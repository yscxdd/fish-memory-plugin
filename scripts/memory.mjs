#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * memory.mjs — 记忆库离线命令行。
 *
 * 用法：
 *   node scripts/memory.mjs <command> [--dir <memoryDir>] [flags]
 *
 * 命令：
 *   check              校验 30_points 与 40_pending（退出码 1 = 有硬错误）
 *   promote <id>       校验通过后把草稿从 40_pending 移入 30_points 并重建索引
 *   index [--check]    重建派生索引；--check 只比对不写
 *   audit [--json]     审计报告（契约 §10）；退出码 1 = 未通过
 *   digest [--write]   按 30 分钟切段 + 空窗检测；--write 生成压缩用的原文包
 *   self-pack [YYYY-MM]     生成自述素材包 → 40_pending/_self/<月>.md
 *   self-promote <YYYY-MM>  人审闸门：校验 40_pending/_self/<月>.draft.md → 15_self/<月>.md
 *   invalidate <id> [--at YYYY-MM-DD] [--reason]  标记事实失效（boundary/promise 不许）
 *
 * flags：--dir <path>  --json  --check  --write  --force
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { atomicWriteText, localDay } from '../lib/util.js'
import { join, resolve } from 'node:path'
import { applyForget, planForget } from '../lib/forget.js'
import { latestRun, startRun } from '../lib/identity.js'
import { forgottenLog, searchMemory, statusOf } from '../lib/inspect.js'
import { withLock } from '../lib/lock.js'
import { backtestSkill, promoteSkill } from '../lib/backtest.js'
import { readCompatRecord } from '../lib/compat.js'
import { applyErase, planErase, readErasureLog } from '../lib/erase.js'
import { writeVault } from '../lib/vault.js'
import { buildSelfPack, promoteSelf, selfDraftPath, SELF_MAX_CHARS } from '../lib/self.js'
import { privacyReport, writeGitignoreBlock } from '../lib/privacy.js'
import { abGold, GOLD_FLOOR, runGold, WEIGHT_SETS } from '../lib/goldset.js'
import { checkHost } from '../lib/hostcheck.js'
import { HOST_POINTS } from '../lib/host.js'
import { packMemory, unpackMemory } from '../lib/pack.js'
import { renderRecall, searchArchive } from '../lib/recall.js'
import { initMemory } from '../lib/scaffold.js'
import { verifyPackage } from '../lib/verify.js'
import {
  audit,
  buildIndex,
  diffIndex,
  ingestPending,
  listFixtures,
  readArchive,
  readPointFiles,
  scanPointFiles,
  renderDigest,
  resetFixtures,
  splitSegments,
  validatePoint,
  writeIndex,
} from '../lib/toolkit.js'

const argv = process.argv.slice(2)
const dirIdx = argv.indexOf('--dir')
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const rest = argv.filter(
  (a, i) => !a.startsWith('--') && (dirIdx < 0 || (i !== dirIdx && i !== dirIdx + 1)),
)
const [command, ...params] = rest
const dir = resolve(dirIdx >= 0 ? argv[dirIdx + 1] : join(process.cwd(), 'fish-memory'))

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function needDir() {
  if (!existsSync(dir)) fail(`记忆库不存在：${dir}`)
}

/** 取 `--flag <值>` 的值（只认第一个） */
function flagValue(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// ── check ──────────────────────────────────────────────────────
function cmdCheck() {
  needDir()
  const archive = readArchive(dir)
  // v0.14.0：用 scanPointFiles，把"读不出来的文件"当硬错误——
  // 一个 front matter 坏掉的点如果只是被静默跳过，她的记忆就少了一条而没人知道
  const scanPoints = scanPointFiles(dir, '30_points')
  const scanPending = scanPointFiles(dir, '40_pending')
  const points = scanPoints.points
  const pending = scanPending.points
  const skipped = [
    ...scanPoints.skipped.map((s) => ({ ...s, where: '30_points' })),
    ...scanPending.skipped.map((s) => ({ ...s, where: '40_pending' })),
  ]
  for (const s of skipped) {
    console.error(`✗ ${s.where}/${s.file}`)
    console.error(`    读不出来：${s.reason}`)
  }
  const all = [...points, ...pending].map((p) => ({ id: p.id, ...validatePoint(p, { archive, points }) }))
  let errors = 0
  let warned = 0
  for (const item of all) {
    if (!item.errors.length) {
      // 没有硬错误但有告警：默认只报数，--json 才逐条展开（别把 check 刷成噪音）
      if (item.warnings.length) {
        warned += 1
        if (flags.has('--json')) {
          console.error(`! ${item.id}`)
          for (const w of item.warnings) console.error(`    (warn) ${w.field}: ${w.message}`)
        }
      }
      continue
    }
    errors += 1
    console.error(`✗ ${item.id}`)
    for (const e of item.errors) console.error(`    ${e.field}: ${e.message}`)
    if (flags.has('--json')) for (const w of item.warnings) console.error(`    (warn) ${w.field}: ${w.message}`)
  }
  const unreadable = skipped.length ? `，${skipped.length} 个文件读不出来` : ''
  console.log(`校验：${all.length} 条，${errors} 条有硬错误${unreadable}${warned ? `，${warned} 条有告警（加 --json 看详情）` : ''}`)
  if (errors || skipped.length) process.exit(1)
}

// ── promote ────────────────────────────────────────────────────
function cmdPromote(id) {
  if (!id) fail('用法：memory promote <M-YYYY-MM-DD-NNN>')
  needDir()
  const archive = readArchive(dir)
  const pending = readPointFiles(dir, '40_pending')
  const draft = pending.find((p) => p.id === id || p.filename === `${id}.md`)
  if (!draft) fail(`40_pending 里没有 ${id}`)

  const points = readPointFiles(dir, '30_points')
  const v = validatePoint(draft, { archive, points, allowSample: false })
  if (v.errors.length) {
    console.error(`✗ ${draft.id} 校验未通过：`)
    for (const e of v.errors) console.error(`    ${e.field}: ${e.message}`)
    process.exit(1)
  }

  const dest = join(dir, '30_points', `${draft.id}.md`)
  if (existsSync(dest)) fail(`30_points 里已有 ${draft.id}`)
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const patched = draft.raw.replace(/^status:.*$/m, 'status: active')
  const tmp = `${dest}.tmp`
  writeFileSync(tmp, patched, 'utf8')
  renameSync(tmp, dest)
  unlinkSync(draft.file)

  const built = buildIndex(readPointFiles(dir, '30_points'))
  writeIndex(dir, built)

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'consolidation.log'),
    JSON.stringify({ at: new Date().toISOString(), action: 'promote', id: draft.id, from: '40_pending' }) + '\n',
    'utf8',
  )
  console.log(`✓ ${draft.id} 已提升为 active，索引已重建`)
}

// ── index ──────────────────────────────────────────────────────
function cmdIndex() {
  needDir()
  const points = readPointFiles(dir, '30_points')
  const built = buildIndex(points)
  if (flags.has('--check')) {
    const diff = diffIndex(dir, built)
    if (diff.length) {
      console.error(`✗ 索引与记忆点不一致：${diff.join(', ')}`)
      process.exit(1)
    }
    console.log(`✓ 索引一致（${points.length} 条记忆点）`)
    return
  }
  writeIndex(dir, built)
  console.log(`✓ 已重建索引：${points.length} 条记忆点`)
}

// ── invalidate ─────────────────────────────────────────────────
/**
 * 标记一条事实**不再成立**（v0.14.0）——标记，不是删除。
 *
 * 为什么：偏好会变（"以前喝美式，现在喝拿铁"）。以前只能留两条 active，
 * 检索可能把两条都注入，等于让她同时相信互斥的两件事。
 * 现在写 `invalid_at`：点还在、审计还看得见，但**不再进注入**。
 *
 * 硬规则（照 graphiti 的 soft-deadline 语义）：`boundary` / `promise` **不许失效**。
 */
function cmdInvalidate(id) {
  if (!id) fail('用法：memory invalidate <M-YYYY-MM-DD-NNN> [--at YYYY-MM-DD] [--reason "..."]')
  needDir()
  const points = readPointFiles(dir, '30_points')
  const p = points.find((x) => x.id === id)
  if (!p) fail(`30_points 里没有 ${id}`)
  if (p.type === 'boundary' || p.type === 'promise') {
    fail(`${p.type} 不许失效：承诺到期不等于没说过（soft deadlines are not invalid_at）`)
  }
  if (p.invalid_at) fail(`${id} 已经标过失效：${p.invalid_at}`)
  const at = flagValue('--at') || localDay(new Date())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || !Number.isFinite(Date.parse(at))) fail(`--at 要写合法日期 YYYY-MM-DD：${at}`)
  const reason = (flagValue('--reason') || '').replace(/\r?\n/g, ' ')
  const patched = p.raw.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (m, head) => {
    const extra = `invalid_at: ${at}${reason ? `\ninvalid_reason: ${reason}` : ''}`
    return `---\n${head.trimEnd()}\n${extra}\n---`
  })
  if (patched === p.raw) fail('改不动这条点的 front matter（格式不认识），先手工看一眼')
  atomicWriteText(p.file, patched)
  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'invalidation.log'),
    JSON.stringify({ at: new Date().toISOString(), point: id, invalid_at: at, reason: reason || null }) + '\n',
    'utf8',
  )
  console.log(`✓ ${id} 已标记为 ${at} 起不再成立：点仍在库里、审计仍看得见，但不再进注入`)
  console.log('  撤销：手工删掉该文件的 invalid_at / invalid_reason 两行')
}

// ── audit ──────────────────────────────────────────────────────
function cmdAudit() {
  needDir()
  const report = audit(dir)
  if (flags.has('--json')) console.log(JSON.stringify(report, null, 2))
  else for (const c of report.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.id}  ${JSON.stringify(c)}`)
  if (!flags.has('--json')) console.log(report.passed ? '\n审计通过' : '\n审计未通过')
  process.exit(report.passed ? 0 : 1)
}

// ── reset ──────────────────────────────────────────────────────
function cmdReset() {
  needDir()
  if (!flags.has('--fix')) fail('用法：memory reset --fix [--yes]（只清 fixture，不动档案）')
  const list = listFixtures(dir)
  if (!list.length) {
    console.log('没有 fixture 素材，无需清理')
    return
  }
  if (!flags.has('--yes')) {
    console.log(`将清空 ${list.length} 项测试素材（档案不动）：`)
    for (const f of list) console.log(`  ${f.kind.padEnd(9)} ${f.id}`)
    console.log('\n确认执行：加 --yes')
    return
  }
  const r = withLock(dir, () => resetFixtures(dir, { apply: true }))
  console.log(`✓ 已清空 ${r.deleted} 项测试素材，索引已重建；10_archive 未动`)
}

// ── identity ───────────────────────────────────────────────────
function cmdIdentity() {
  needDir()
  const run = flags.has('--new') || !latestRun(dir) ? startRun(dir) : latestRun(dir)
  console.log(`✓ 答题卡：${join(run, 'sheet.md')}`)
  console.log('按顺序问她 20 题，原样记录；评分规则在答题卡末尾。')
}

// ── pack / unpack ──────────────────────────────────────────────
function cmdPack(dest) {
  needDir()
  if (!dest) fail('用法：memory pack <目标目录> [--force]')
  const r = packMemory(dir, resolve(dest), { force: flags.has('--force') })
  console.log(`✓ 打包 ${r.files} 个文件，${(r.bytes / 1024 / 1024).toFixed(2)} MB → ${r.dest}`)
}

function cmdUnpack(packDir, dest) {
  if (!packDir || !dest) fail('用法：memory unpack <包目录> <目标目录> [--force]')
  const r = unpackMemory(resolve(packDir), resolve(dest), { force: flags.has('--force') })
  console.log(`✓ 校验 ${r.verified}/${r.files}，索引重建 ${r.rebuilt} 条 → ${r.dest}`)
}

// ── forget ─────────────────────────────────────────────────────
function cmdForget() {
  needDir()
  const { plan, skipped } = planForget(dir)
  for (const x of plan) {
    console.log(
      `${x.action.padEnd(7)} ${x.id}  status=${x.status}  salience=${x.salience}  age=${x.age}d  S=${x.S}  R=${x.R}`,
    )
  }
  const acts = plan.filter((x) => x.action !== 'keep')
  console.log(
    `\n检查 ${plan.length} 条，${acts.length} 条可动；跳过 fixture ${skipped.fixture} 条、底线 ${skipped.protected} 条`,
  )
  if (!acts.length) return
  if (!flags.has('--yes')) {
    console.log('执行：加 --yes')
    return
  }
  const r = withLock(dir, () => applyForget(dir))
  console.log(`✓ 已处理 ${r.changed} 条；墓碑写入 50_log/eviction.log`)
}

// ── ingest ─────────────────────────────────────────────────────
function cmdIngest() {
  needDir()
  const dry = ingestPending(dir, { apply: false })
  const bad = dry.results.filter((r) => !r.ok)
  for (const r of dry.results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.id}`)
    for (const e of r.errors) console.log(`    ${e.field}: ${e.message}`)
  }
  if (!dry.results.length) {
    console.log('40_pending 里没有草稿')
    return
  }
  if (bad.length) {
    console.error(`\n${bad.length} 条校验不过，先修再 ingest（不会提升任何一条）`)
    process.exit(1)
  }
  if (!flags.has('--yes')) {
    console.log(`\n${dry.results.length} 条可提升。执行：加 --yes`)
    return
  }
  const r = withLock(dir, () => ingestPending(dir, { apply: true }))
  console.log(`✓ 已提升 ${r.promoted.length} 条，索引已重建`)
}

// ── digest ─────────────────────────────────────────────────────
function cmdDigest() {
  needDir()
  const { messages } = readArchive(dir)
  const { segments, gaps } = splitSegments(messages)
  const outDir = join(dir, '40_pending', '_segments')
  const done = (s) => existsSync(join(outDir, `${s.id}.done`))
  const todo = segments.filter((s) => !done(s))
  console.log(`档案 ${messages.length} 条，切出 ${segments.length} 段（已压 ${segments.length - todo.length} 段）；空窗 ${gaps.length} 处`)
  for (const g of gaps) console.log(`  空窗 ${g.days} 天：${g.from} → ${g.to}`)

  if (!flags.has('--write')) {
    for (const s of segments) console.log(`  ${s.id}  ${s.start} → ${s.end}  ${s.messages.length} 条${done(s) ? '  [已压]' : ''}`)
    return
  }

  mkdirSync(outDir, { recursive: true })
  let written = 0
  for (const s of todo) {
    const dest = join(outDir, `${s.id}.md`)
    if (existsSync(dest) && !flags.has('--force')) continue
    writeFileSync(dest, renderDigest(s), 'utf8')
    written += 1
  }
  console.log(`✓ 已写 ${written} 个原文包到 40_pending/_segments/（用 --force 覆盖）`)
}

// ── status / search ────────────────────────────────────────────
function cmdStatus() {
  needDir()
  const s = statusOf(dir)
  console.log(`库：${s.dir}`)
  console.log(`记忆点：${s.points.total}（active ${s.points.active} / merged ${s.points.merged} / fixture ${s.points.fixtures}）`)
  console.log(`草稿：${s.pending}  ·  档案：${s.archive} 条`)
  console.log(`压缩段：已出包 ${s.segments.written} / 已压 ${s.segments.done}`)
  console.log(`备份：${s.backups.count} 份${s.backups.latest ? `（最近 ${s.backups.latest}）` : '（还没有）'}`)
  console.log(`日志：检索 ${s.logs.retrieval} · 金丝雀 ${s.logs.canary} · 注入隔离 ${s.logs.guard}`)
  // 隐私一行：只说结论，详情用 memory privacy
  try {
    const p = privacyReport(dir)
    const where = p.repo ? `${p.repo}` : '不在 git 仓库里'
    const state = p.repo ? `${p.memoryIgnored ? '已忽略' : '未忽略'}${p.backupIgnored ? '、备份已忽略' : '、备份未忽略'}` : '不会被 git 带走'
    console.log(`隐私：${where} · ${state}`)
  } catch {
    /* 体检失败不影响 status */
  }
}

function cmdInit(target) {
  if (!target) fail('用法：memory init <新目录>')
  const r = initMemory(target)
  console.log(`✓ 已建库：${r.dir}`)
  console.log('下一步：填 00_core/soul.md 和 user.md，然后开始聊。')
  const p = privacyReport(r.dir)
  if (p.repo) {
    console.log(`注意：这个目录在 git 仓库 ${p.repo} 里。档案是明文——要防止被提交，跑 memory privacy --write。`)
  }
}

// ── privacy ────────────────────────────────────────────────────
/**
 * G3：这套库会不会被 git 带走。默认只报告；`--write` 才动仓库根的 .gitignore。
 */
function cmdPrivacy() {
  needDir()
  const report = privacyReport(dir)
  console.log(`记忆库：${report.memoryDir}`)
  console.log(`备份：  ${report.backupRoot}`)
  console.log(`git 仓库：${report.repo || '（不在仓库里）'}`)
  console.log(
    `忽略状态：记忆库 ${report.memoryIgnored ? '已覆盖' : '未覆盖'} · 备份 ${report.backupIgnored ? '已覆盖' : '未覆盖'}` +
      `${report.localGitignore ? '（库内有 .gitignore）' : ''}`,
  )
  if (report.risks.length) {
    console.log('')
    for (const r of report.risks) console.log(`! ${r}`)
  }
  console.log('')
  for (const a of report.advice) console.log(`  ${a}`)

  if (flags.has('--write')) {
    if (!report.repo) fail('不在 git 仓库里，不需要写 .gitignore')
    const memoryName = report.memoryDir.split(/[\\/]/).filter(Boolean).pop()
    const backupName = report.backupRoot.split(/[\\/]/).filter(Boolean).pop()
    const r = writeGitignoreBlock(report.repo, { memoryName, backupName })
    if (r.changed) console.log(`\n✓ 已追加忽略块：${r.path}`)
    else console.log(`\n没有改动（${r.reason || '无需改动'}）：${r.path}`)
  }
  process.exit(report.risks.length && !report.repo ? 1 : 0)
}

// ── erase ──────────────────────────────────────────────────────
/**
 * G1 真删除。默认只**列出**会删什么（dry-run），要 `--yes` 才动手。
 * 被引用的消息默认拒绝，`--cascade` 才连引用的点一起删。
 */
function cmdErase(params) {
  needDir()
  const ids = params.filter((p) => !p.startsWith('--'))
  if (!ids.length) fail('用法：memory erase <msg-id...> [--reason 说明] [--point <id>] [--cascade] [--yes]')
  const pointIdx = argv.indexOf('--point')
  const pointIds = pointIdx >= 0 ? [argv[pointIdx + 1]].filter(Boolean) : []
  const reason = flagValue('--reason') || ''

  const plan = planErase(dir, { messageIds: ids, pointIds })
  if (plan.unknown.length) fail(`库里没有这些 id：${plan.unknown.join(', ')}`)

  console.log(`要删的消息 ${plan.messages.length} 条：`)
  for (const m of plan.messages) console.log(`  ${m.id}  ${m.ts.slice(0, 16)}  ${m.role}  hash:${m.hash8}`)
  if (plan.points.length) {
    console.log(`要删的记忆点 ${plan.points.length} 条：`)
    for (const p of plan.points) console.log(`  ${p.id}  ${p.file}`)
  }
  if (plan.refs.length) {
    console.log(`\n有 ${plan.refs.length} 条记忆点在引用这些消息：`)
    for (const r of plan.refs) console.log(`  ${r.id}（${r.via.join(', ')}）`)
    if (!flags.has('--cascade')) {
      console.error('\n✗ 默认不删被引用的东西。加 --cascade 连这些点一起删，或先手工处理它们。')
      process.exit(1)
    }
    console.log('  已加 --cascade：这些点会一起删掉')
  }
  if (plan.backups.length) console.log(`\n备份里也要同步改写 ${plan.backups.length} 个文件（并重算 MANIFEST 哈希）`)

  if (!flags.has('--yes')) {
    console.log('\n这是预览。确认执行：加 --yes（删除不可撤销）')
    return
  }

  const withPoints = flags.has('--cascade') ? [...plan.points, ...plan.refs.map((r) => ({ id: r.id, file: r.file }))] : plan.points
  const r = applyErase(dir, { ...plan, points: withPoints }, { reason })
  for (const w of r.warnings) console.error(`! ${w}`)
  console.log(`\n✓ 删掉 ${r.removed} 条消息、${r.points} 条记忆点，改写 ${r.backups} 个备份文件；链已重算，墓碑在 50_log/erasure.log`)
  if (!reason) console.log('  （没写 --reason：墓碑里原因是空的，以后自己会看不懂为什么删的）')
}

function cmdErased() {
  needDir()
  const rows = readErasureLog(dir)
  if (!rows.length) {
    console.log('还没有删除记录')
    return
  }
  for (const r of rows) {
    const what =
      r.kind === 'message'
        ? `消息 ${r.id}${r.plat && r.plat !== r.id ? `（平台 ${r.plat}）` : ''}（hash:${r.hash8 || '?'}）`
        : `记忆点 ${r.id}`
    console.log(`${r.at || '?'}  ${what}  ${r.reason || '（无原因）'}`)
  }
  console.log(`\n共 ${rows.length} 条（最近 30 条，倒序；只含 id/时间/原因，不含原文）`)
}

// ── vault ──────────────────────────────────────────────────────
/** 生成 Obsidian/LogSeq 能直接打开的派生视图（只写 20_index/） */
function cmdVault() {
  needDir()
  const rawDays = flagValue('--days')
  const days = rawDays === undefined ? undefined : Number(rawDays)
  if (days !== undefined && (!Number.isFinite(days) || days < 1)) fail('--days 要是正整数')
  const r = writeVault(dir, { days })
  console.log(`✓ 已生成 vault 视图：`)
  console.log(`  日笔记 ${r.views.length} 篇 → 20_index/views/（覆盖 ${r.days} 天、${r.messages} 条）`)
  console.log(`  入口   20_index/index.md`)
  console.log(`  关系   20_index/links.md`)
  console.log('')
  console.log('用法：Obsidian → 打开文件夹 → 选 ' + dir)
  console.log('      把 20_index/index.md 设成首页；Ctrl/Cmd+G 看图谱。')
  console.log('注意：这些是派生视图，可重建；改记忆请走 40_pending/ + promote。')
}

// ── self-pack ──────────────────────────────────────────────────
/** 生成自述素材包 `40_pending/_self/<month>.md`（运行时没人替她建，得自己叫） */
function cmdSelfPack(month) {
  needDir()
  const now = month ? new Date(`${month}-01T00:00:00`) : new Date()
  if (month && Number.isNaN(now.getTime())) fail('月份要写成 YYYY-MM，例如 2026-10')
  const r = buildSelfPack(dir, now)
  console.log(`✓ 素材包：${r.path}（${r.points} 条，其中值得写自述的 ${r.material} 条）`)
  if (!r.material) console.log('  这个月只有日常素材 —— 允许写"这个月没什么可说的"，不用硬凑。')
  console.log('  写草稿到同目录 <月>.draft.md，然后 memory self-promote <月>。')
}

// ── self-promote ───────────────────────────────────────────────
/**
 * 人审闸门：`40_pending/_self/<month>.draft.md` → `15_self/<month>.md`。
 * 不合格就不动 15_self/，只留一行 reject 日志（见 lib/self.js 的 validateSelf）。
 */
function cmdSelfPromote(month) {
  if (!month) fail('用法：memory self-promote <YYYY-MM>')
  needDir()
  const r = promoteSelf(dir, month, { force: flags.has('--force') })
  if (!r.ok) {
    console.error(`✗ ${month || '(没给月份)'} 的自述没通过闸门：`)
    for (const e of r.errors) console.error(`    ${e.field}: ${e.message}`)
    if (r.chars !== undefined) console.error(`    （现在 ${r.chars} 字，上限 ${SELF_MAX_CHARS}）`)
    // 草稿确实存在时才说"留在哪"，否则这句话会指着不存在的文件
    if (r.errors.every((e) => e.field !== 'draft' && e.field !== 'month')) {
      console.error(`    草稿留在 ${selfDraftPath(dir, month)}；15_self/ 没动。`)
    }
    process.exit(1)
  }
  console.log(`✓ ${month} 的自述已提升：${r.dest.replace(dir + '\\', '').replace(dir + '/', '')}（${r.chars} 字）`)
  console.log(`  日志 50_log/self.log 记了一行（action=promote, sha8=${r.record.sha8}）`)
  console.log('  下一篇只有在话题涉及情绪/关系/变化时才会带进上下文。')
}

function cmdForgotten() {
  needDir()
  const rows = forgottenLog(dir)
  if (!rows.length) {
    console.log('还没有墓碑')
    return
  }
  for (const r of rows) {
    console.log(
      `${r.at}  ${r.point}  ${r.action}  R=${r.R} S=${r.S} salience=${r.salience}  ${r.reason || ''}`,
    )
  }
  console.log(`\n共 ${rows.length} 条（最近 30 条，倒序）`)
}

function cmdSearch(q) {
  needDir()
  if (!q) fail('用法：memory search <关键词>')
  const r = searchMemory(dir, q)
  console.log(`记忆点命中 ${r.points.length} 条：`)
  for (const p of r.points) console.log(`  ${p.score.toFixed(2)}  ${p.id}  ${p.title}  [${p.status}] salience=${p.salience}`)
  console.log(`档案原文命中 ${r.archive.length} 条：`)
  for (const m of r.archive) console.log(`  ${m.ts.slice(11, 16)} ${m.role.padEnd(9)} ${m.excerpt}`)
}

// ── gold ───────────────────────────────────────────────────────
function cmdGold() {
  const rawThreshold = flagValue('--threshold')
  const threshold = rawThreshold === undefined ? 0.8 : Number(rawThreshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 20) {
    fail('--threshold 要是 0..20 的数字（默认 0.8）')
  }

  if (flags.has('--ab')) {
    const ab = abGold({ threshold })
    console.log(`金标 A/B：${ab.total} 条查询，阈值 ${threshold}`)
    for (const s of ab.results) {
      const delta = s.delta > 0 ? `+${s.delta}` : String(s.delta)
      const flagsText = `${s.rebalance ? '补权' : '无补权'}${s.useIdf ? `+idf(${s.idfMode})` : ''}`
      console.log(
        `  ${s.name.padEnd(13)} ${s.hits}/${s.total}  Δ${delta}  边际 ${s.margin ?? '—'}  负例 ${s.falsePositives.length}  [${flagsText}]`,
      )
      for (const m of s.misses) console.log(`      未命中：${m}`)
      if (s.falsePositives.length) console.log(`      误命中：${s.falsePositives.join('、')}`)
    }
    const ok = ab.base / ab.total >= GOLD_FLOOR && ab.baseFalsePositives.length === 0
    process.exit(ok ? 0 : 1)
  }

  const r = runGold({ threshold })
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  console.log(
    `金标：${r.hits}/${r.total}（${Math.round(r.rate * 100)}%，下限 ${Math.round(GOLD_FLOOR * 100)}%）` +
      `  阈值 ${threshold}  最小边际 ${r.margin ?? '—'}  负例误命中 ${r.falsePositives.length}`,
  )
  console.log(
    `打分：稀疏补权 ${r.rebalance ? '开' : '关'} · IDF ${r.useIdf ? `开（${r.idfMode}）` : '关'}   ← 插件的默认配置`,
  )
  for (const row of r.rows) {
    console.log(`${row.ok ? '✓' : '✗'} ${row.query} → ${row.got ?? '空'}（${row.score}）${row.ok ? '' : ` 期望 ${row.expect}`}`)
  }
  for (const q of r.falsePositives) console.log(`✗ 负例误命中：${q}`)
  console.log(r.ok ? '\n✓ 金标通过' : '\n✗ 金标未通过')
  process.exit(r.ok ? 0 : 1)
}

// ── compat ─────────────────────────────────────────────────────
/**
 * 版更对照：把「上一次好用的快照」和「最近一次加载结果」摆在一起。
 * 离线可跑（不依赖宿主），用的是插件自己写下的 20_state/host-surface.json + 50_log/compat.log。
 */
function cmdCompat() {
  needDir()
  const { surface, failures } = readCompatRecord(dir)
  const marks = []

  if (!surface) {
    console.log('! 还没有宿主快照（20_state/host-surface.json）')
    console.log('  说明：插件还没在拿到库目录后加载过，或者那次加载就崩了。')
    marks.push('warn')
  } else {
    const missing = surface.missing || []
    const found = surface.found || []
    // 老快照没有 unprobeable 字段：按"既不在 found 也不在 missing"补出来，别显示成 0
    const unprobeable =
      surface.unprobeable ||
      HOST_POINTS.filter((p) => !found.includes(p.id) && !missing.includes(p.id)).map((p) => p.id)
    const required = surface.requiredMissing || []
    const prevMissing = surface.previous?.missing || null
    const regressed = prevMissing ? missing.filter((id) => !prevMissing.includes(id)) : []
    const recovered = prevMissing ? prevMissing.filter((id) => !missing.includes(id)) : []

    console.log(`快照：${surface.at}`)
    console.log(
      `  口子 ${(surface.found || []).length} 在 · ${unprobeable.length} 只能靠跑 · ${missing.length} 缺` +
        `（必需缺口 ${required.length}）/ 共 ${HOST_POINTS.length}`,
    )
    if (missing.length) {
      for (const id of missing) {
        const p = HOST_POINTS.find((x) => x.id === id)
        console.log(`    - ${id}${p ? `（${p.symptom}）` : ''}`)
      }
    }
    if (unprobeable.length) console.log(`  只能靠跑：${unprobeable.join(', ')}（事件名/消息形状，静态验不了）`)
    if (!prevMissing) console.log('  比上一份：首次记录')
    else if (!regressed.length && !recovered.length) console.log('  比上一份：没有变化')
    else {
      if (regressed.length) console.log(`  比上一份少了：${regressed.join(', ')}   ← 这次版更动到了这些`)
      if (recovered.length) console.log(`  比上一份多了：${recovered.join(', ')}   ← 好了的`)
    }
    if (required.length) marks.push('error')
    else if (regressed.length) marks.push('warn')
    else marks.push('ok')
  }

  const lastFail = failures[failures.length - 1]
  if (lastFail) {
    marks.push('error')
    console.log('')
    console.log(`✗ 最近一次加载失败：${lastFail.at || '（时间未知）'}`)
    console.log(`    ${lastFail.error}`)
    if (lastFail.surface?.requiredMissing?.length) {
      console.log(`    当时缺的必需口子：${lastFail.surface.requiredMissing.join(', ')}`)
    }
    if (lastFail.stack) {
      for (const line of String(lastFail.stack).split('\n').slice(0, 4)) console.log(`    ${line}`)
    }
    console.log(`    建议：只改 lib/host.js；改完 sync + 重新加载；验收看 50_log/host.log`)
  } else {
    console.log('')
    console.log('✓ 最近没有加载失败记录（50_log/compat.log 里没有 apply-failed）')
  }

  const worst = marks.includes('error') ? 'error' : marks.includes('warn') ? 'warn' : 'ok'
  console.log('')
  console.log(worst === 'ok' ? '✓ 兼容状态正常' : worst === 'warn' ? '! 兼容状态需要看一眼' : '✗ 兼容状态有问题')
  process.exit(worst === 'error' ? 1 : 0)
}

// ── hostcheck ──────────────────────────────────────────────────
function cmdHostcheck() {
  const root = resolve(import.meta.dirname, '..')
  const r = checkHost(root)
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  console.log(`宿主口子：${r.points.length} 个`)
  console.log(`对照：${r.verifiedAgainst.build} · ${r.verifiedAgainst.at}`)
  console.log('')
  for (const p of r.points) {
    const mark = p.sites.length ? '✓' : '✗'
    const flag = p.required ? '必需' : '可选'
    console.log(`${mark} ${p.id.padEnd(26)} ${p.kind.padEnd(7)} ${flag}  ${p.sites.join(', ') || '(代码里没有标记)'}`)
    console.log(`    api   ${p.api}`)
    console.log(`    坏了   ${p.symptom}`)
  }
  console.log('')
  const bad = r.errors
  console.log(`${bad.length ? '✗' : '✓'} 静态约束：标记与表一一对应、host.js 之外无 ctx 直呼`)
  for (const e of bad) console.log(`    ${e}`)
  const fails = r.selfTest.cases.filter((c) => !c.ok)
  console.log(`${fails.length ? '✗' : '✓'} 降级自检：${r.selfTest.cases.length - fails.length}/${r.selfTest.cases.length}`)
  for (const f of fails) console.log(`    ${f.name}：${f.note}`)
  console.log('')
  console.log('运行时那一半（静态查不出来）：重启 DSH 后看 50_log/host.log')
  console.log('  missing          缺了哪些口子（requiredMissing 才算坏）')
  console.log('  channel-gap      只见 session 事件、不见 inbox = 事件名很可能被改了')
  process.exit(r.ok ? 0 : 1)
}

switch (command || 'help') {
  case 'check':
    cmdCheck()
    break
  case 'promote':
    cmdPromote(params[0])
    break
  case 'index':
    cmdIndex()
    break
  case 'audit':
    cmdAudit()
    break
  case 'digest':
    cmdDigest()
    break
  case 'ingest':
    cmdIngest()
    break
  case 'forget':
    cmdForget()
    break
  case 'pack':
    cmdPack(params[0])
    break
  case 'backtest': {
    needDir()
    const id = params[0]
    if (!id) fail('用法：memory backtest <技能 id>')
    const r = backtestSkill(dir, id)
    if (r.error) fail(r.error)
    console.log(`技能 ${r.id}（v${r.version}）`)
    console.log(`触发覆盖：${r.hits}/${r.queries}（${Math.round(r.rate * 100)}%）`)
    for (const i of r.invariants) console.error(`✗ ${i}`)
    console.log(r.ok ? '✓ 回测通过' : '✗ 回测未通过')
    process.exit(r.ok ? 0 : 1)
  }
  case 'recall': {
    needDir()
    const q = params[0]
    if (!q) fail('用法：memory recall <原话里的词>')
    console.log(renderRecall(searchArchive(dir, q)))
    break
  }
  case 'skill-promote': {
    needDir()
    const draft = params[0]
    if (!draft) fail('用法：memory skill-promote <草稿路径>')
    const r = promoteSkill(dir, resolve(draft))
    if (r.error) fail(r.error)
    console.log(`技能 ${r.id}（v${r.version}）触发覆盖 ${r.hits}/${r.queries}（${Math.round(r.rate * 100)}%）`)
    for (const i of r.invariants) console.error(`✗ ${i}`)
    if (!r.applied) {
      console.error('✗ 回测未通过，未采纳')
      process.exit(1)
    }
    console.log(`✓ 已采纳：${r.dest}（旧版已备份到 35_ability/versions/）`)
    break
  }
  case 'verify': {
    const r = verifyPackage(resolve(import.meta.dirname, '..'))
    if (flags.has('--json')) console.log(JSON.stringify(r, null, 2))
    else {
      for (const e of r.errors) console.error(`✗ ${e}`)
      for (const w of r.warnings) console.error(`! ${w}`)
      console.log(r.ok ? '✓ 自检通过' : `✗ 自检失败（${r.errors.length} 项）`)
    }
    process.exit(r.ok ? 0 : 1)
  }
  case 'identity':
    cmdIdentity()
    break
  case 'status':
    cmdStatus()
    break
  case 'init':
    cmdInit(params[0])
    break
  case 'search':
    cmdSearch(params[0])
    break
  case 'gold':
    cmdGold()
    break
  case 'hostcheck':
    cmdHostcheck()
    break
  case 'compat':
    cmdCompat()
    break
  case 'privacy':
    cmdPrivacy()
    break
  case 'erase':
    cmdErase(rest.slice(1))
    break
  case 'erased':
    cmdErased()
    break
  case 'vault':
    cmdVault()
    break
  case 'self-pack':
    cmdSelfPack(params[0])
    break
  case 'self-promote':
    cmdSelfPromote(params[0])
    break
  case 'invalidate':
    cmdInvalidate(params[0])
    break
  case 'forgotten':
    cmdForgotten()
    break
  case 'unpack':
    cmdUnpack(params[0], params[1])
    break
  case 'reset':
    cmdReset()
    break
  default:
    console.log(
      [
        'memory — 大肥鱼记忆库离线工具',
        '',
        '  check              校验 30_points 与 40_pending',
        '  promote <id>       把草稿提升为 active',
        '  ingest [--yes]     批量校验并提升 40_pending 里所有合格的草稿',
        '  index [--check]    重建 / 比对派生索引',
        '  audit [--json]     审计',
        '  digest [--write]   切段 + 空窗；--write 生成压缩原文包',
        '  reset --fix [--yes] 清空 fixture 测试素材（不动档案）',
        '  status             一眼看库：点数/草稿/备份/日志',
        '  search <关键词>    搜记忆点（带分数）与档案原文',
        '  gold [--ab]        跑金标召回（20 条查询 + 6 条负例）；--ab 比较几组权重',
        '  hostcheck          宿主口子清单与降级自检（DSH 版更后先跑这个）',
        '  compat             版更对照：上次好用的快照 vs 这次 → 缺了哪个口子、有没有崩过',
        '  privacy [--write]  这套库会不会被 git 带走；--write 往仓库根追加忽略块（幂等）',
        '  erase <id...>      真删除（改档案 + 重算链 + 同步改写备份 + 墓碑）；默认预览，--yes 执行',
        '  erased             看删除墓碑（只有 id/时间/原因，不含原文）',
        '  vault [--days N]   生成 Obsidian/LogSeq 视图（日笔记 + 入口 + 关系图，只写 20_index/）',
        '  self-pack [YYYY-MM]     生成自述素材包 → 40_pending/_self/<月>.md',
        '  self-promote <YYYY-MM>  人审闸门：校验 40_pending/_self/<月>.draft.md → 15_self/<月>.md',
        '  invalidate <id> [--at D] [--reason ...]  标记一条事实不再成立（不走遗忘，不删档案）',
        '',
        'flags: --dir <path>  --json  --check  --write  --force  --threshold <n>',
      ].join('\n'),
    )
    process.exit(command ? 1 : 0)
}
