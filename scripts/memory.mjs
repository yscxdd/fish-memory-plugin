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
 *   soul drift|propose|apply <提案>   人格修订：自述变了才提提案，人审后应用（锁定小节必须逐字不变）
 *   stats [--days 7] [--price 4] [--turns 100] [--json]   真实账：注入均值/分层占比/门控/命中/每轮成本
 *   asset add <文件> [--kind book|doc|transcript|image|audio|video] [--title 名字]   素材放库外，库里只留引用`n *   book add <文件> [--title 书名]｜book list｜book verify   书源：原文在库外，库里只留引用
 *   wakeup [--out <目录>] [--json]  生成唤醒包（五件，目标 ≤4000 tok）→ 90_snapshot/wakeup-YYYYMMDD/
 *   tokens [--days N] [--json]      每轮注入 token 的账（50_log/token.log）
 *   cliche [--days 7] [--json]      套话密度（只读）：多少轮带着"我记下了/这句稳"这类腔调
 *   alias                          别名半自动：propose/list/accept/reject（人点头才写回点）
 *   reset --all [--yes]  开养前清零：档案/状态/日志/快照/技能/草稿（00_core 与文档不动）
 *
 * flags：--dir <path>  --json  --check  --write  --force  --out <dir>
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { atomicWriteText, localDay } from '../lib/util.js'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { applyForget, findDormant, migrateLegacyDormant, planForget, revivePoint } from '../lib/forget.js'
import { redactArchive } from '../lib/archive.js'
import { acceptVoice, listProposals, mineVoice, readProposal, rejectVoice, writeVoiceProposal } from '../lib/voice.js'
import { acceptAlias, aliasCoverage, aliasOverview, mineAliases, mineAll, pointVocab, rejectAlias } from '../lib/alias.js'
import { latestRun, startRun } from '../lib/identity.js'
import { forgottenLog, searchMemory, statusOf } from '../lib/inspect.js'
import { withLock } from '../lib/lock.js'
import { backtestSkill, promoteSkill } from '../lib/backtest.js'
import { readCompatRecord } from '../lib/compat.js'
import { applyErase, planErase, readErasureLog } from '../lib/erase.js'
import { writeVault } from '../lib/vault.js'
import { buildSelfPack, latestSelf, promoteSelf, selfDraftPath, SELF_MAX_CHARS } from '../lib/self.js'
import { privacyReport, writeGitignoreBlock } from '../lib/privacy.js'
import { abGold, GOLD_FLOOR, runGold, WEIGHT_SETS } from '../lib/goldset.js'
import { goldStability } from './gold-stability.mjs'
import { runHard } from './gold-hard.mjs'
import { checkHost } from '../lib/hostcheck.js'
import { HOST_POINTS } from '../lib/host.js'
import { packMemory, unpackMemory } from '../lib/pack.js'
import { RETURN_GAP_HOURS, loadPresence, presenceSummary, returnLine } from '../lib/presence.js'
import { addHabit, habitsBlock, habitsSummary } from '../lib/habits.js'
import { clicheReplay, clicheReport, findCliches, pruneClicheLog } from '../lib/cliche.js'
import { readWere, writeWere } from '../lib/were.js'
import { addSpecial, emotionLine, emptyState, loadEmotion, saveEmotion, specialsLine, TIER_DEFAULT, TIER_TEXT } from '../lib/emotion.js'
import { behaviorCounts, pruneBehavior } from '../lib/behavior.js'
import { detectSleep, loadSleep, settle } from '../lib/sleep.js'
import { addEntity, loadEntityIndex, loadEntityRegistry, rebuildEntityIndex } from '../lib/entities.js'
import { timeLabel, timelineCounts, timelineRows } from '../lib/time.js'
import { recentTamper, refreshFingerprint } from '../lib/tamper.js'
import { addWorkspace, buildFileIndex, indexStats, listAll, readIndexedFile, removeWorkspace, searchFiles } from '../lib/workspaces.js'
import { everythingStatus, findWithEverything, saveConfig } from '../lib/everything.js'
import { TUNABLES, effectiveValue, resetSetting, setSetting } from '../lib/settings.js'
import { writeReport } from '../lib/report.js'
import { mergeCheck } from '../lib/mergecheck.js'
import { buildHandoffFromArchive, clearHandoff, readHandoff } from '../lib/handoff.js'
import { scopeAnswer } from '../lib/serveapi.js'
import { voiceMetrics } from '../lib/voicemetrics.js'
import { renderToday, todayView } from '../lib/today.js'
import { exportFmb, pruneFmb, readFmbHeader, verifyFmb } from '../lib/fmb.js'
import { restoreFmb } from '../lib/restore.js'
import { wallsReport, wallsSummary } from '../lib/walls.js'
import { checkFields, renderFields } from '../lib/fieldcheck.js'
import { refutePoint, refutedWithoutReason } from '../lib/refute.js'
import { evidenceOf, renderEvidence } from '../lib/evidence.js'
import { TIDY_EVERY, markTidyDone, tidyPack, tidyStatus } from '../lib/tidy.js'
import { readJsonSafe } from '../lib/util.js'
import { SCOPE_DM_MASTER, isGroupScope, scopeOf, stampScope, validateScope, visible } from '../lib/scope.js'
import { renderRecall, searchArchive, searchPoints } from '../lib/recall.js'
import { DEFAULT_BUDGET, INJECT_HARD_CAP, injectBudgetTotal } from '../lib/render.js'
import { initMemory } from '../lib/scaffold.js'
import { checkArchive } from '../lib/integrity.js'
import { verifyPackage } from '../lib/verify.js'
import { writeWakeup } from '../lib/wakeup.js'
import { summarizeTokenLog } from '../lib/toklog.js'
import { applyResetAll, planResetAll } from '../lib/reset.js'
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
  assetAliases,
  assetSummary,
  patchAliases,
} from '../lib/toolkit.js'
import { addAsset, assetsRoot, listAssets, loadAssets, retireAsset, unretireAsset, verifyAsset, parseAssetSource } from '../lib/assets.js'
import { addQuestion, rankedQuestions, resolveQuestion, touchQuestion } from '../lib/questions.js'
import { assetUsage, computeStats, estimateCost, maturity } from '../lib/stats.js'
import { SOUL_DRIFT_MAX, SOUL_DRIFT_MIN, applyRevision, changes7d, driftOf, mutableRegion, proposeRevision, readSoul } from '../lib/soul.js'

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
  const books = loadAssets(dir).books
  const all = [...points, ...pending].map((p) => ({ id: p.id, ...validatePoint(p, { archive, points, books, dir }) }))
  let errors = 0
  let warned = 0
  // v0.25.0：key 点只有 3 个名额（每轮全文注入），多的白写，还会挤掉底线与承诺
  try {
    const keyed = points.filter((x) => x.key === true)
    if (keyed.length > 3) {
      console.warn(`  ⚠ key 点有 ${keyed.length} 条，但注入只取前 3 条：${keyed.slice(3).map((x) => x.id).join(', ')}`)
      console.warn('    （书评/总评建议用 pin: soft，把 key 留给底线与承诺）')
    }
  } catch {
    /* 提醒失败不影响校验 */
  }
  // v0.23.1：素材"只有碎片、没有总评点"要提醒（不阻塞）——聊整体感受时没有打底
  try {
    const summary = assetSummary(points, loadAssets(dir).books)
    for (const m of summary.missingKey) {
      console.warn(`  ⚠ 素材 ${m.title}（${m.id}）记了 ${m.count} 条点，但没有总评点（key: true）`)
    }
  } catch {
    /* 提醒失败不影响校验 */
  }
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
/**
 * 补 `learned_at`（v0.76.0）。
 *
 * 为什么要有：这个字段 v0.73 就解析了、也渲染了，**但没有任何写入方**——
 * 属于"读了没人写"，读到的永远是空。这类断线现在是 `memory fields` 会报的。
 *
 * 什么时候写：`source` 里最早那条消息的时间，和点自己的 `date`（事情发生日）
 * 差 **≥30 天** 才写。差几天是正常的记录延迟，写了只是噪音。
 *
 * 写不进去不算错——`learned_at` 是可选字段，缺了按 `date` 兜底（见 render.js 的 learnedLate）。
 */
function withLearnedAt(raw, draft, archive) {
  if (/^learned_at:/m.test(raw)) return raw
  const ids = Array.isArray(draft.source) ? draft.source : []
  const stamps = ids
    .map((id) => archive.byId?.get?.(id))
    .filter(Boolean)
    .map((m) => Date.parse(m.ts))
    .filter((n) => Number.isFinite(n))
  if (!stamps.length) return raw
  const learnedMs = Math.min(...stamps)
  const happenedMs = Date.parse(String(draft.date || ''))
  if (!Number.isFinite(happenedMs)) return raw
  if (learnedMs - happenedMs < 30 * 86_400_000) return raw
  const learnedAt = new Date(learnedMs).toISOString()
  // 插在 date 行后面（front matter 里，保持人能读的顺序）
  return raw.replace(/^(date:[^\n]*\n)/m, `$1learned_at: ${learnedAt}\n`)
}

function cmdPromote(id) {
  if (!id) fail('用法：memory promote <M-YYYY-MM-DD-NNN>')
  needDir()
  const archive = readArchive(dir)
  const pending = readPointFiles(dir, '40_pending')
  const draft = pending.find((p) => p.id === id || p.filename === `${id}.md`)
  if (!draft) fail(`40_pending 里没有 ${id}`)

  const points = readPointFiles(dir, '30_points')
  const v = validatePoint(draft, { archive, points, allowSample: false, books: loadAssets(dir).books, dir })
  if (v.errors.length) {
    console.error(`✗ ${draft.id} 校验未通过：`)
    for (const e of v.errors) console.error(`    ${e.field}: ${e.message}`)
    process.exit(1)
  }

  const dest = join(dir, '30_points', `${draft.id}.md`)
  if (existsSync(dest)) fail(`30_points 里已有 ${draft.id}`)
  mkdirSync(join(dir, '30_points'), { recursive: true })
  // v0.23.1：素材点自动带别名（书名/类型），让"下次提书名"能命中；只补没有的，纯加法
  // v0.76.0：顺手把 learned_at 补上（没有写入方的字段 = 死字段，这条就是补它的）
  const learned = withLearnedAt(draft.raw, draft, archive)
  const base = learned.replace(/^status:.*$/m, 'status: active')
  const aliased = patchAliases(base, assetAliases(draft, loadAssets(dir).books))
  const patched = aliased.raw
  const tmp = `${dest}.tmp`
  writeFileSync(tmp, patched, 'utf8')
  renameSync(tmp, dest)
  unlinkSync(draft.file)

  const built = buildIndex(readPointFiles(dir, '30_points'))
  writeIndex(dir, built)

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'consolidation.log'),
    JSON.stringify({ at: new Date().toISOString(), action: 'promote', id: draft.id, from: '40_pending', aliases_added: aliased.added }) + '\n',
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
/** 开养前清零：档案/状态/日志/快照/技能/草稿全清，00_core 与文档不动（v0.19.0） */
function cmdResetAll() {
  const plan = planResetAll(dir)
  const total = Object.values(plan.counts).reduce((n, x) => n + x, 0)
  if (!total && !plan.index_stale) {
    console.log('已经是干净的了：没有档案、状态、日志、快照、技能或旧投影需要清。')
    return
  }
  if (!flags.has('--yes')) {
    console.log(`将清空 ${total} 个文件 / 目录（约 ${(plan.bytes / 1024).toFixed(0)} KB）：`)
    for (const [area, n] of Object.entries(plan.counts)) console.log(`  ${area.padEnd(10)} ${String(n).padStart(4)}`)
    if (plan.index_stale) console.log(`  ${'20_index'.padEnd(10)}    重建为空（旧 vault 视图/入口页里有对话原文）`)
    console.log(`\n其中档案消息 ${plan.archive_messages} 条（对话原文，删了不可恢复）。`)
    console.log('不动：' + plan.kept.join(' · '))
    console.log('\n确认执行：加 --yes')
    return
  }
  const r = withLock(dir, () => applyResetAll(dir))
  for (const [area, n] of Object.entries(r.removed)) console.log(`  ${area.padEnd(10)} ${String(n).padStart(4)}`)
  console.log(`✓ 已清零 ${r.archive_messages} 条档案消息、${Object.values(r.removed).reduce((a, b) => a + b, 0)} 个文件/目录`)
  console.log('  ✓ 00_core、文档与模板未动；20_index 已重建为空')
  console.log('  ✓ 流水写在 50_log/reset.log（只追加，只有数量与时间，不含原话）')
  // 删不掉的东西要当场说：日志说"清了 N 个"而实际还剩东西，就是自述为真、事实为假
  if (r.residual && r.residual.total > 0) {
    console.error(`! 还剩 ${r.residual.total} 个文件/目录没删掉（被占用或权限不足）：`)
    for (const [area, n] of Object.entries(r.residual.counts)) console.error(`    ${area.padEnd(10)} ${String(n).padStart(4)}`)
    console.error('  关掉占用它的程序后重跑一次；不要以为已经干净了。')
    process.exitCode = 1
  } else if (r.residual && r.residual.total === -1) {
    console.error('! 删完复查失败（读不了库），无法确认是否清零')
    process.exitCode = 1
  }
}

function cmdReset() {
  needDir()
  if (flags.has('--all')) {
    cmdResetAll()
    return
  }
  if (!flags.has('--fix')) fail('用法：memory reset --fix [--yes]（只清 fixture）｜memory reset --all [--yes]（开养前清零）')
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
  // 注入预算：契约 §11 #6 的上限与当前配置摆在一起。
  // 2026-10-31 拍板后（总设计 §5.4 方案 A，core 700）总额正好顶格，
  // 所以这条线路由"报差额"变成"报余量"——余量是 0 也是一种要说出来的事实。
  const total = injectBudgetTotal(DEFAULT_BUDGET)
  const gap = total == null ? 0 : total - INJECT_HARD_CAP
  console.log(
    `注入预算：core ${DEFAULT_BUDGET.core} + 索引 ${DEFAULT_BUDGET.index} + 正文 ${DEFAULT_BUDGET.body} = ${total ?? '不限'}` +
      (gap > 0
        ? `（破约：契约 §11 上限 ${INJECT_HARD_CAP}，超 ${gap}）`
        : gap === 0
          ? `（= 契约 §11 上限 ${INJECT_HARD_CAP}，顶格）`
          : `（≤ 契约上限 ${INJECT_HARD_CAP}，余 ${-gap}）`) +
      `；关系状态另计 ${DEFAULT_BUDGET.status}`,
  )
  // 隐私一行：只说结论，详情用 memory privacy
  try {
    const p = privacyReport(dir)
    const where = p.repo ? `${p.repo}` : '不在 git 仓库里'
    const state = p.repo ? `${p.memoryIgnored ? '已忽略' : '未忽略'}${p.backupIgnored ? '、备份已忽略' : '、备份未忽略'}` : '不会被 git 带走'
    console.log(`隐私：${where} · ${state}`)
  } catch {
    /* 体检失败不影响 status */
  }
  // v0.75.0：四堵墙的数字放进 status——"每周被看见"比"埋在测试里"有用
  try {
    for (const line of wallsSummary(dir)) console.log(line)
  } catch {
    /* 墙算不出来不影响 status */
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
  // 必须上锁（v0.15.1）：erase 是"读整份档案 → 删行 → 重算链 → rename 覆盖"，
  // 插件正在同一份文件上 append 时，落在窗口里的消息会被静默丢掉，
  // 而且 archive-manifest 会跟着重写，事后的完整性检查看不出来。
  // reset / forget / ingest 早就走了 withLock，只有这条最该锁的路漏了。
  const r = withLock(dir, () => applyErase(dir, { ...plan, points: withPoints }, { reason }))
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
      r.kind === 'archive'
        ? `档案 ${r.file}（删了 ${r.removed} 行：${r.before?.count ?? '?'} → ${r.after?.count ?? '?'}）`
        : r.kind === 'message'
          ? `消息 ${r.id}${r.plat && r.plat !== r.id ? `（平台 ${r.plat}）` : ''}（hash:${r.hash8 || '?'}）`
          : `记忆点 ${r.id}`
    console.log(`${r.at || '?'}  ${what}  ${r.reason || '（无原因）'}`)
  }
  console.log(`\n共 ${rows.length} 条（倒序；只含 id/时间/原因，不含原文）`)
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

// ── refute（这条结论错了）/ evidence（一键查证）────────────────────
/**
 * v0.69.0（T5 + T6）。"能查证、能改错"是视频第 5 条建议，
 * 也是我们最强项（source 硬约束）缺的两个动作。
 *
 *   memory refute <id> --reason "..." [--by <新点id>]
 *   memory evidence <id> [--json]
 */
function cmdRefute() {
  needDir()
  const id = params[0]
  const reason = flagValue('--reason')
  if (!id) fail('用法：memory refute <id> --reason "为什么错" [--by <新点id>]')
  const r = refutePoint(dir, id, { reason, by: flagValue('--by') || null })
  if (!r.ok) fail(r.reason)
  console.log(`✓ 已推翻：${r.id}`)
  console.log(`  理由：${r.reason}`)
  if (r.by) console.log(`  新点：${r.by}${r.linked ? '（已在新点上记 contradicts）' : '（没连上新点，检查 id）'}`)
  console.log('  → 它仍然会注入，但带 [已推翻] 标记；痕迹进了 50_log/erasure.log')
}

function cmdEvidence() {
  needDir()
  const id = params[0]
  if (!id) fail('用法：memory evidence <id>')
  const r = evidenceOf(dir, id)
  if (flags.has('--json')) console.log(JSON.stringify(r, null, 2))
  else console.log(renderEvidence(r))
  if (!r.ok) process.exitCode = 1
}

// ── tidy（整理机节拍：看水位 / 备料 / 记完成）──────────────────────
/**
 * v0.68.0（T1）。视频里那套是"每 35 条整理一次"的机器；
 * 我们**不做机器**——代码永不自动写记忆点——只做**提醒 + 备料**。
 *
 *   memory tidy            看水位：还差多少条到线
 *   memory tidy --pack     现在就备料（不等到线）
 *   memory tidy --done     整理完了，水位前移（唯一会前移的地方）
 */
function cmdTidy() {
  needDir()
  const every = Number(flagValue('--every') || TIDY_EVERY)

  if (flags.has('--done')) {
    const r = markTidyDone(dir)
    console.log(`✓ 水位前移到 ${r.rows} 条（这次整理了 ${r.tidiedSince} 条）`)
    return
  }

  if (flags.has('--pack')) {
    const r = tidyPack(dir, { every: flags.has('--force') ? 0 : every })
    if (!r.ok) {
      console.log(`还没到线（差 ${every - tidyStatus(dir, { every }).since} 条）。想现在就备料加 --force`)
      return
    }
    console.log(`✓ 材料包：${r.at}`)
    console.log(`  ${r.since} 条原文 · ${r.drafts} 条草稿 · ${r.points} 个新点`)
    return
  }

  const s = tidyStatus(dir, { every })
  console.log(`档案 ${s.rows} 条 · 上次整理时 ${s.lastTidyRows} 条 · 之后新增 ${s.since} 条`)
  console.log(s.due ? `  → 该整理了（≥ ${every}），注入里会带一行提醒` : `  → 还差 ${every - s.since} 条到线`)
  if (s.lastTidyAt) console.log(`  上次整理：${s.lastTidyAt}`)
  console.log('')
  console.log('  memory tidy --pack   现在就备料（原文摘录 + 草稿清单 + 新点）')
  console.log('  memory tidy --done   整理完了，水位前移')
}

// ── backup（单文件包：导出 / 看 / 验 / 恢复 / 清）──────────────────
/**
 * v0.67.0。**同步盘只该看见"一个写完的文件"**——目录会边写边传、还会产生冲突副本，
 * 而档案的 hash 链最怕分叉。
 *
 *   memory backup export [--out <file>] [--key-file <path>] [--encrypt]
 *   memory backup list   [--dir <同步盘目录>]
 *   memory backup verify <file> [--key-file <path>]
 *   memory backup restore <file> <目标目录> [--force] [--key-file <path>]
 *   memory backup prune  --dir <目录> [--keep 7] [--monthly 6]
 */
/**
 * verify 用的**真链校验**（v0.67.1，F1）。
 *
 * 以前 `backup verify` 只传 key、不传 checkChain，却无条件打印「链完整」——
 * 那是给人错误的安全感。现在摊到临时目录真跑 `checkArchive`，验不出就抛。
 */
function checkChainOf(files) {
  const tmp = mkdtempSync(join(tmpdir(), 'fmb-verify-'))
  try {
    for (const f of files) {
      const abs = join(tmp, f.name)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, f.data)
    }
    const r = checkArchive(tmp, { persist: false })
    if (!r.ok) {
      const why = [
        ...(r.broken || []).map((b) => `${b.file}: ${b.reason}`),
        ...(r.badLines || []).map((b) => `${b.file}: ${b.count} 行读不出来`),
      ]
      throw new Error(`链校验失败：${why.slice(0, 3).join('；') || '档案不完整'}`)
    }
    return { ok: true, checked: r.checked }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 恢复后重建索引（失败不影响恢复本身） */
function rebuildIndexQuiet(libDir) {
  try {
    const points = readPointFiles(libDir, '30_points')
    writeIndex(libDir, buildIndex(points))
    return { ok: true, points: points.length }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) }
  }
}

/** 库的档案链体检（memory verify --dir 用） */
function chainReport(libDir) {
  const chain = checkArchive(libDir, { persist: false })
  const problems = [
    ...(chain.broken || []).map((b) => `${b.file}: ${b.reason}`),
    ...(chain.badLines || []).map((b) => `${b.file}: ${b.count} 行读不出来`),
  ]
  return { ...chain, problems }
}

function backupKey() {
  const kf = flagValue('--key-file') || process.env.FISH_MEMORY_BACKUP_KEY_FILE
  if (kf) {
    try {
      return readFileSync(kf, 'utf8').trim()
    } catch (e) {
      fail(`读不到口令文件：${kf}（${e?.message || e}）`)
    }
  }
  return process.env.FISH_MEMORY_BACKUP_PASSPHRASE || null
}

function cmdBackup() {
  const sub = params[0]
  if (!sub) fail('用法：memory backup export|list|verify|restore|prune')

  if (sub === 'export') {
    needDir()
    const encrypt = flags.has('--encrypt')
    let key = encrypt ? backupKey() : null
    if (encrypt && !key) {
      fail('--encrypt 要给口令：--key-file <路径> 或 FISH_MEMORY_BACKUP_PASSPHRASE（**绝不静默降级为明文**）')
    }
    const out = flagValue('--out')
    const r = exportFmb(dir, { outFile: out, key })
    console.log(`✓ 导出：${r.file}`)
    console.log(`  ${r.files} 个文件 · ${(r.bytes / 1024).toFixed(0)} KB · ${r.encrypted ? '已加密（aes-256-gcm）' : '明文'}`)
    console.log(`  sha256 ${r.digest}`)
    if (r.encrypted) console.log('  提示：口令别存进这个库（等于把钥匙和锁放一个包）')
    return
  }

  if (sub === 'list') {
    const d = flagValue('--dir') || dir
    if (!existsSync(d)) fail(`目录不存在：${d}`)
    const files = readdirSync(d).filter((f) => /^fish-memory-\d{8}\.fmb$/.test(f)).sort()
    if (!files.length) {
      console.log('（这个目录里没有备份包）')
      return
    }
    for (const f of files) {
      try {
        const { head } = readFmbHeader(join(d, f))
        const size = (statSync(join(d, f)).size / 1024).toFixed(0)
        console.log(`  ${f} · ${size} KB · ${head.files} 个文件 · ${head.enc ? '加密' : '明文'}`)
      } catch (e) {
        console.log(`  ${f} · 读不出来（${e?.message || e}）`)
      }
    }

    // v0.67.2（B4）：`--check` 回答一个问题——**最近一份还新吗、还读得出来吗**。
    // 同步盘的失败是静默的，所以这条要能进 cron。
    if (flags.has('--check')) {
      const newest = files[files.length - 1]
      const day = (newest.match(/(\d{8})/) || [])[1]
      const madeAt = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))
      const hours = Math.round((Date.now() - madeAt.getTime()) / 3600_000)
      let ok = true
      try {
        readFmbHeader(join(d, newest))
      } catch (e) {
        console.log(`  ✗ 最新一份读不出来：${e?.message || e}`)
        ok = false
      }
      if (hours > 48) {
        console.log(`  ✗ 最新一份是 ${hours} 小时前（超过 48h 没备份了）`)
        ok = false
      } else if (ok) {
        console.log(`  ✓ 最新一份 ${hours} 小时前，头部可读`)
      }
      if (!ok) process.exitCode = 1
    }
    return
  }

  if (sub === 'verify') {
    const file = params[1]
    if (!file) fail('用法：memory backup verify <file>')
    // 明文包不需要口令；加密包才要——由 readFmb 自己判并给出人话错误
    try {
      // v0.67.1（F1）：以前这里只传 key，checkChain 是 null，却无条件打印「链完整」——
      // 那三个字在**没验**的时候说出口，等于给人错误的安全感。现在真验。
      const r = verifyFmb(file, { key: backupKey(), checkChain: checkChainOf })
      console.log(`✓ 验过：${r.files} 个文件 · 链完整（已验）· ${(r.bytes / 1024).toFixed(0)} KB`)
      // v0.67.2（B4）：同步盘的失败是**静默的**（传了一半、名字带 (1)、体积 0）。
      // 所以远端那份必须能和本地记录对上哈希，否则"我有备份"只是信仰。
      const expect = String(flagValue('--expect-sha256') || '').trim().toLowerCase()
      if (expect) {
        const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
        if (actual !== expect) {
          fail(`远端文件与本地记录不一致：\n  期望 ${expect}\n  实际 ${actual}\n  （网盘截断/改名/传输不完整，最典型的表现）`)
        }
        console.log('  ✓ sha256 与本地记录一致')
      }
    } catch (e) {
      fail(String(e?.message || e))
    }
    return
  }

  if (sub === 'restore') {
    const file = params[1]
    const dest = params[2]
    if (!file || !dest) fail('用法：memory backup restore <file> <目标目录> [--force]')
    let r
    try {
      r = restoreFmb(file, resolve(dest), { key: backupKey(), force: flags.has('--force'), rebuild: rebuildIndexQuiet })
    } catch (e) {
      fail(String(e?.message || e))
    }
    console.log(`✓ 恢复完成：${r.files} 个文件 → ${dest}`)
    if (r.oldDir) console.log(`  旧库挪到：${r.oldDir}`)
    return
  }

  if (sub === 'prune') {
    const d = flagValue('--dir')
    if (!d) fail('用法：memory backup prune --dir <同步盘目录> [--keep 7] [--monthly 6]')
    const keep = Number(flagValue('--keep') || 7)
    const monthly = Number(flagValue('--monthly') || 6)
    const r = pruneFmb(resolve(d), { keep, monthly, dry: flags.has('--dry') })
    console.log(`  删掉 ${r.removed.length} 份，留下 ${r.kept.length} 份`)
    for (const f of r.removed) console.log('    - ' + f)
    return
  }

  fail(`不认识的子命令：${sub}`)
}

// ── today（她的今天：一屏，只读）──────────────────────────────
/**
 * v0.63.0。回答两个问题：**她什么心情**、**今天都做了什么**。
 *
 * 六个块：心情 / 聊了 / 记住 / 写了 / 悬着 / 到期。
 * 心情用**句子**不用刻度盘——数字摆出来人就想调一格，那是把人当仪表盘。
 */
function cmdToday() {
  needDir()
  const view = todayView(dir)
  if (flags.has('--json')) {
    console.log(JSON.stringify(view, null, 2))
    return
  }
  console.log(renderToday(view))
  console.log('')
  console.log('  （只读：不补算 drift、不 touch 问题、不写任何文件）')
}

// ── voice-metrics（她说话的样子 · 八维，只读）──────────────
/**
 * v0.60.0。八维借自别人的验收清单，口径按我们的 soul / voice 重写：
 * 句数、字数、感叹号、语气词、动作、自称、禁用词、总结句。
 *
 * **只量"说话"，不量"工作产出"**——档案里她的消息大多是开发报告，
 * 拿报告量语音只能量出"报告写得长"（实测 99 条里 67 条是 work）。
 */
function cmdVoiceMetrics() {
  needDir()
  const r = voiceMetrics(dir)
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    if (!r.ok) process.exitCode = 1
    return
  }
  if (r.empty) {
    console.log(`（没有数据）${r.reason}`)
    return
  }
  console.log(`她说话的样子：样本 ${r.total} 条 · 排除工作产出 ${r.excluded} 条`)
  console.log('')
  for (const row of r.rows) {
    console.log(`  ${row.ok ? '✓' : '✗'} ${row.name.padEnd(6, '　')} ${row.value}`)
    if (!row.ok) console.log(`      ${row.hint}`)
  }
  console.log('')
  console.log(r.ok ? '✓ 八维都过' : '✗ 有维度不过（这是基线，别为了变绿去改阈值）')
  if (!r.ok) process.exitCode = 1
}

// ── scope（这条记忆属于谁：看默认值 / 判一条渠道消息）──────────
/**
 * v0.59.0 接入准备。通道侧只用两个接口：
 *   GET /scope?...   这条消息属于谁
 *   GET /context?...&scope=group:123
 * 这个命令是它们的本地版，方便不上服务时核对。
 *
 *   memory scope                                   看默认作用域
 *   memory scope --channel group --group 123 --sender u1 --masters u1 --homes 123
 *   memory scope --check group:123                 校验写法
 */
function cmdScope() {
  // A3（v0.71.0）：隔离以前只做了读侧。补写侧——
  // 没有 scope 的点缺省按 global 处理，而 global 对所有作用域可见；
  // 接群那天，私聊点的**标题**就会跟着索引行进群。
  if (params[0] === 'stamp') {
    needDir()
    const fallback = String(flagValue('--default') || SCOPE_DM_MASTER)
    const checked = validateScope(fallback)
    if (!checked.ok) fail(`--default 不合法：${fallback}（${checked.reason || checked.error || ''}）`)
    const dry = flags.has('--dry')
    const points = readPointFiles(dir, '30_points')
    const missing = points.filter((p) => !p.scope)
    if (!missing.length) {
      console.log(`✓ 全部 ${points.length} 个点都有 scope，不用补`)
      return
    }
    if (dry) {
      console.log(`  要补 ${missing.length} / ${points.length} 个点 → ${checked.scope}`)
      for (const p of missing.slice(0, 10)) console.log(`    · ${p.id} ${p.title || ''}`)
      if (missing.length > 10) console.log(`    …（还有 ${missing.length - 10} 个）`)
      console.log('  去掉 --dry 才会真写')
      return
    }
    const r = stampScope(dir, checked.scope)
    console.log(`✓ 补了 ${r.stamped} 个点 → ${checked.scope}（跳过已有 scope 的 ${r.skipped} 个）`)
    console.log(`  日志：${r.log}（每个点一行，含改动前后指纹）`)
    return
  }
  const check = flagValue('--check')
  if (check) {
    const v = validateScope(check)
    console.log(v.ok ? `✓ 合法：${v.scope}` : `✗ ${v.reason}`)
    return
  }
  if (flags.has('--channel')) {
    const r = scopeAnswer({
      channelType: flagValue('--channel'),
      groupId: flagValue('--group'),
      senderId: flagValue('--sender'),
      masterIds: flagValue('--masters') || '',
      homeGroups: flagValue('--homes') || '',
      memberRole: flagValue('--role'),
    })
    console.log(`作用域：${r.scope}`)
    console.log(`  角色：${r.role}（${r.reason}）`)
    console.log(`  只读：${r.readOnly ? '是' : '否'}`)
    console.log(`  能写核心层：${r.mayWriteCore ? '能' : '不能（任何人、任何渠道都不能）'}`)
    console.log(`  写入落点：${r.writeTarget}`)
    if (isGroupScope(r.scope)) {
      console.log('  群作用域的限制：不能 pin:hard / 不能 origin:chosen / salience ≤ 3')
    }
    return
  }
  // 配置里的 scope（没配就是 dm:master）
  const cfgScope = readJsonSafe(join(dir, 'memory.json'), {})?.scope
  const configured = cfgScope || SCOPE_DM_MASTER
  const v = validateScope(configured)
  console.log(`默认作用域：${configured}${v.ok ? '' : '  ← 配置里这个值不合法'}`)
  console.log('  · 缺省是主人私聊（dm:master）。')
  // v0.71.0（A3）：以前这里写"历史点没有 scope 的按 global 处理，不用迁移"——
  // 只有私聊时那是对的，**接了群就是错的**：global 对所有作用域可见，标题会跟着进群。
  console.log('  ⚠ 没有 scope 的点按 global 处理，对**任何**作用域都可见（含群）。接群前先补齐：')
  console.log('      memory scope stamp --default dm:master --dry')
  console.log('  · 通道侧要判"这条消息属于谁"：memory scope --channel group --group <id> --sender <id> --masters <id> --homes <id>')
}

// ── handoff（换窗交接包：看 / 手动写 / 清）────────────────────
/**
 * v0.52.0：现在交接包只能靠事件触发（压缩开始 / 压力换窗），太被动。
 *   memory handoff            看当前包（有没有、什么时候写的、两栏内容）
 *   memory handoff --write    用档案最近 8 条手动拼一份（"没做完的事"留空，不编）
 *   memory handoff --clear    删掉（下一轮就不会读到它）
 */
function cmdHandoff() {
  needDir()
  if (flags.has('--clear')) {
    const r = clearHandoff(dir)
    console.log(r.removed ? '✓ 交接包已删除' : '（本来就没有）')
    return
  }
  if (flags.has('--write')) {
    const r = buildHandoffFromArchive(dir)
    if (!r) fail('档案里还没有消息，拼不出交接包')
    console.log(`✓ 写好了：近 ${r.tail} 条 + 惦记 ${r.regrets} 条 + 别再提 ${r.doNotMention} 条`)
    console.log(r.text)
    return
  }
  const h = readHandoff(dir)
  if (!h) {
    console.log('现在没有交接包。')
    console.log('  · 压缩开始时（compaction/start）会自动写；')
    console.log('  · 也可以手动：memory handoff --write')
    return
  }
  const age = Math.round((Date.now() - Date.parse(h.at)) / 60000)
  console.log(`交接包：${h.at}（${age} 分钟前，来自 ${h.from}）`)
  if (h.regrets?.length) console.log(`  我还惦记着：${h.regrets.join(' / ')}`)
  if (h.doNotMention?.length) console.log(`  别再提：${h.doNotMention.join(' / ')}`)
  console.log('')
  console.log(h.text)
}

// ── merge-check（只读：两个库差在哪）──────────────────────────
/**
 * v0.51.0：**不做双向同步**，只告诉你两个库差在哪、有没有结构性冲突。
 *   memory merge-check <另一个库的路径> [--json]
 */
function cmdMergeCheck(other) {
  needDir()
  if (!other) fail('用法：memory merge-check <另一个库的路径>')
  const r = mergeCheck(dir, resolve(other))
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.dangers.length ? 1 : 0)
  }
  const fmt = (n) => (n == null ? '—' : String(n))
  console.log(`A（本机）：${r.a}`)
  console.log(`B（另一台）：${r.b}`)
  console.log('')
  console.log(`档案：A ${r.archive.a.messages} 条 / B ${r.archive.b.messages} 条`)
  console.log(`  只在 A：${r.archive.onlyA}${r.archive.sampleOnlyA.length ? '（如 ' + r.archive.sampleOnlyA.join('、') + '）' : ''}`)
  console.log(`  只在 B：${r.archive.onlyB}${r.archive.sampleOnlyB.length ? '（如 ' + r.archive.sampleOnlyB.join('、') + '）' : ''}`)
  console.log(`  同 id 内容不同：${r.archive.differ}`)
  console.log(`  两边都改过的天文件（链已分叉）：${r.archive.forks.length}${r.archive.forks.length ? '：' + r.archive.forks.join('、') : ''}`)
  console.log(`记忆点：A ${r.points.a} / B ${r.points.b} · 冲突 ${r.points.differ} · 只在 A ${r.points.onlyA} · 只在 B ${r.points.onlyB}`)
  if (r.core.differ.length) console.log(`核心层两边都改过：${r.core.differ.join('、')}`)
  console.log(`谁的档案更新：${r.newer === 'A' ? 'A（本机）' : r.newer === 'B' ? 'B（另一台）' : r.newer === 'same' ? '一样' : '无法判断'}`)
  const st = r.state.filter((x) => x.a || x.b)
  if (st.length) {
    console.log('')
    console.log('状态文件（左 A / 右 B）：')
    for (const x of st) console.log(`  ${x.file.padEnd(18)} ${fmt(x.a)}  ${fmt(x.b)}`)
  }
  console.log('')
  if (r.dangers.length) {
    console.log('⚠ 有结构性冲突：')
    for (const d of r.dangers) console.log('  · ' + d)
  } else {
    console.log('✓ 没有结构性冲突')
  }
  console.log('  ' + r.advice)
  process.exit(r.dangers.length ? 1 : 0)
}

// ── report（静态状态报告）──────────────────────────────────────
/**
 * v0.45.0：生成一页自包含 HTML，双击就开。**只读**，不改任何状态。
 *   memory report            生成到 90_snapshot/report-<时间>.html 并打印路径
 *   memory report --out <f>  指定路径
 */
function cmdReport() {
  needDir()
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? argv[outIdx + 1] : null
  const r = writeReport(dir, { out })
  const d = r.data
  console.log(`✓ 报告已生成：${r.path}（${Math.round(r.bytes / 1024)} KB）`)
  console.log(`  成熟度 ${d.maturity?.level || '—'} · 点 ${d.counts.points} · 待审 ${d.counts.pending} · 情绪 ${d.emotion.label}（tier ${d.emotion.tier}）`)
  console.log('  这个文件不会自己更新：想刷新就再跑一次。')
}

// ── config（可调参数）────────────────────────────────────────
/**
 * v0.45.0：白名单参数，一次写一个，带说明和范围校验，改动记 50_log/settings.log。
 *   memory config              看所有可调参数（当前值 / 默认值 / 生效时机）
 *   memory config set <键> <值>
 *   memory config reset <键>
 */
function cmdConfig(sub, args) {
  needDir()
  if (sub === 'set') {
    const [key, ...rest] = args
    if (!key || !rest.length) fail('用法：memory config set <键> <值>')
    const r = setSetting(dir, key, rest.join(' '))
    if (!r.ok) fail(r.reason)
    console.log(`✓ ${r.key}：${fmtVal(r.from)} → ${fmtVal(r.to)}${r.apply === 'restart' ? '（重载插件后生效）' : '（下一轮生效）'}`)
    return
  }
  if (sub === 'reset') {
    const key = args[0]
    if (!key) fail('用法：memory config reset <键>')
    const r = resetSetting(dir, key)
    if (!r.ok) fail(r.reason)
    console.log(r.unchanged ? `${r.key} 本来就是默认值` : `✓ ${r.key} 已恢复默认：${fmtVal(r.to)}`)
    return
  }
  const rows = []
  for (const spec of TUNABLES) {
    const cur = effectiveValue(dir, spec)
    rows.push([spec.key, fmtVal(cur), fmtVal(spec.default), spec.apply === 'restart' ? '重载' : '下一轮', spec.doc])
  }
  const w = Math.max(...rows.map((r) => r[0].length))
  for (const [k, cur, def, when, doc] of rows) {
    const mark = cur === def ? ' ' : '*'
    console.log(`${mark} ${k.padEnd(w)}  ${String(cur).padStart(6)}  (默认 ${def})  ${when.padEnd(6)} ${doc}`)
  }
  console.log('\n* = 改过的。用 memory config set <键> <值> 改，reset 恢复默认。')
}

const fmtVal = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))

// ── es（Everything 加速器）────────────────────────────────────
/**
 * v0.43.0：Everything 是可选加速器，不是依赖。
 *   memory es              看状态（有没有 es.exe、从哪找到的）
 *   memory es setup <路径>  手动指定 es.exe（也可以设 EVERYTHING_ES）
 *   memory es off / on     关掉/打开（关掉就只用本地索引）
 */
function cmdEs(sub, arg) {
  needDir()
  if (sub === 'setup') {
    if (!arg) fail('用法：memory es setup <es.exe 的完整路径>')
    if (!existsSync(arg)) fail(`找不到：${arg}`)
    saveConfig(dir, { esPath: arg })
    console.log(`✓ 已记住 es.exe：${arg}`)
    return
  }
  if (sub === 'off' || sub === 'on') {
    saveConfig(dir, { enabled: sub === 'on' })
    console.log(`✓ Everything 加速器已${sub === 'on' ? '打开' : '关闭'}（关掉就只用本地索引）`)
    return
  }
  const st = everythingStatus(dir)
  console.log(`Everything 加速器：${st.enabled ? '开' : '关'} · ${st.available ? '可用' : '不可用'}`)
  if (st.available) console.log(`  es.exe：${st.esPath}（来自 ${st.source}）`)
  else console.log(`  原因：${st.reason || '未知'}`)
  console.log('  找不到时 memory find 会自动回落到本地索引，不影响使用。')
}

// ── ws / find / read（工作区文件索引）──────────────────────────
/**
 * v0.42.0：只索引名字，读文件是另一条显式的路（三道闸）。
 *   memory ws add <目录>     登记一个目录（绝对路径）
 *   memory ws list           看登记与索引概况
 *   memory ws remove <目录>
 *   memory ws rebuild        重建索引
 *   memory find <关键词>      按名字/路径找
 *   memory read <路径>        读文本文件（仅登记目录内、≤512KB、文本类）
 */
function cmdWs(sub, arg) {
  needDir()
  if (sub === 'add') {
    if (!arg) fail('用法：memory ws add <绝对路径>')
    const r = addWorkspace(dir, arg)
    if (!r.ok) fail(r.reason)
    console.log(`✓ 已登记：${r.path}（共 ${r.count} 个）`)
    const b = buildFileIndex(dir)
    console.log(`  索引：${b.count} 个文件${b.truncated ? '（已截断，目录太大）' : ''}`)
    return
  }
  if (sub === 'remove') {
    if (!arg) fail('用法：memory ws remove <绝对路径>')
    const r = removeWorkspace(dir, arg)
    if (!r.ok) fail('没找到这个登记')
    console.log(`✓ 已移除（剩 ${r.count} 个）`)
    return
  }
  if (sub === 'rebuild') {
    const b = buildFileIndex(dir)
    console.log(`✓ 索引 ${b.count} 个文件 · ${b.roots} 个目录 · ${b.ms}ms${b.truncated ? ' · 已截断' : ''}`)
    return
  }
  const rows = listAll(dir)
  if (!rows.length) {
    console.log('还没有登记目录。用 memory ws add <绝对路径> 加一个。')
    return
  }
  const st = indexStats(dir)
  for (const r of rows) console.log(`- ${r.path}  ${r.files} 个文件${r.exists ? '' : '（目录不在了）'}`)
  console.log(`索引：${st.count} 个文件 · ${st.at ? String(st.at).slice(0, 16).replace('T', ' ') : '未建'}${st.truncated ? ' · 已截断' : ''}`)
}

function cmdFind(q) {
  needDir()
  if (!q) fail('用法：memory find <关键词> [--local] [--in memory|all]')
  const localOnly = argv.includes('--local')
  const inIdx = argv.indexOf('--in')
  const scope = inIdx >= 0 ? String(argv[inIdx + 1] || 'files') : 'files'

  // v0.44.0：--in memory 直接翻档案与记忆点（名字找不到时，"他提过什么"还能捞出来）
  if (scope === 'memory' || scope === 'all') {
    if (scope === 'all') {
      console.log('文件：')
      findFiles(q, localOnly)
    }
    const pts = searchPoints(dir, q, { limit: 10 })
    const arch = searchArchive(dir, q, { limit: 8 })
    if (pts.length) {
      console.log(`记忆点 ${pts.length} 条：`)
      for (const p of pts) console.log(`- [${p.kind}] ${p.date} ${p.title}  ${p.id}\n    ${p.excerpt}`)
    }
    if (arch.length) {
      console.log(`原话 ${arch.length} 条：`)
      for (const a of arch) console.log(`- ${a.role === 'user' ? '他' : '她'} ${String(a.ts).slice(0, 16).replace('T', ' ')}  ${a.id}\n    ${a.excerpt}`)
    }
    if (!pts.length && !arch.length) console.log(`档案和记忆点里都没有「${q}」。`)
    logFind({ q, mode: 'memory', hits: pts.length + arch.length, dropped: 0 })
    return
  }

  findFiles(q, localOnly)
}

/** 文件查找（Everything → 本地索引 → 都没有） */
function findFiles(q, localOnly) {

  // v0.43.0：先问 Everything（全盘、毫秒级），但**结果必须过滤到登记工作区**
  if (!localOnly) {
    const es = findWithEverything(dir, q, { limit: 30 })
    if (es.ok && es.hits.length) {
      for (const h of es.hits) console.log(`- ${h.n}  ${Math.round(h.s / 1024)}KB  ${h.p}`)
      console.log(`共 ${es.hits.length} 条（Everything${es.dropped ? ` · 已挡掉工作区外 ${es.dropped} 条` : ''}）`)
      logFind({ q, mode: 'everything', hits: es.hits.length, dropped: es.dropped })
      return
    }
    if (es.ok && !es.hits.length) {
      // Everything 搜到了但全在工作区外：说明"登记目录里没有"，仍然回落到本地索引确认
      logFind({ q, mode: 'everything-empty', hits: 0, dropped: es.dropped })
    }
  }

  const r = searchFiles(dir, q, { limit: 20 })
  if (!r.hits.length) {
    console.log(`没找到「${q}」。${r.built ? '（刚建了索引）' : ''}`)
    logFind({ q, mode: 'local', hits: 0, dropped: 0 })
    return
  }
  for (const h of r.hits) console.log(`- ${h.n}  ${Math.round(h.s / 1024)}KB  ${h.p}`)
  console.log(`共 ${r.total} 条（本地索引${r.built ? ' · 刚建了索引' : ''}）`)
  logFind({ q, mode: 'local', hits: r.hits.length, dropped: 0 })
}

/** 找文件也记账：她查过什么、有没有伸到工作区外 */
function logFind(row) {
  try {
    const line = { at: new Date().toISOString(), ...row }
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, '50_log', 'find.log'), JSON.stringify(line) + '\n', 'utf8')
  } catch {
    /* 记账失败不影响查找 */
  }
}

function cmdRead(p) {
  needDir()
  if (!p) fail('用法：memory read <路径>')
  const r = readIndexedFile(dir, p)
  if (!r.ok) fail(r.reason)
  console.log(r.text)
  console.log(`\n（${r.path} · ${Math.round(r.bytes / 1024)}KB）`)
}

// ── tamper（核心层篡改告警）────────────────────────────────────
/**
 * v0.41.0：她要是绕过插件直接改了 soul/voice/档案，这里能看到。
 *   memory tamper            看有没有可疑改动（只读）
 *   memory tamper --reset    把当前内容当新基线（我们合法改完之后用）
 */
function cmdTamper() {
  needDir()
  if (argv.includes('--reset')) {
    refreshFingerprint(dir)
    console.log('✓ 已把当前核心层当新基线')
    return
  }
  const rows = recentTamper(dir, 5)
  if (!rows.length) {
    console.log('没有篡改告警。')
    return
  }
  console.log(`最近 ${rows.length} 次核心层改动：`)
  for (const r of rows) {
    const files = [...(r.changed || []), ...(r.added || []), ...(r.removed || [])]
    console.log(`  ${String(r.at).slice(0, 16).replace('T', ' ')}  ${files.join(' / ')}`)
  }
  console.log('  如果这些是你自己改的，跑 memory tamper --reset')
}

// ── entity（实体表）────────────────────────────────────────────
/**
 * v0.40.0：登记表人写，索引派生。
 *   memory entity add 我妈 --kind person --aliases 妈妈,母亲
 *   memory entity list
 *   memory entity rebuild
 *   memory entity show 我妈
 */
function cmdEntity(sub, args) {
  needDir()
  if (sub === 'add') {
    const name = args[0]
    if (!name) fail('用法：memory entity add <名字> [--kind person|place|thing|topic] [--aliases a,b]')
    const kind = flagValue('--kind') || 'thing'
    const aliases = String(flagValue('--aliases') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const r = addEntity(dir, { name, kind, aliases })
    if (!r.ok) fail(r.reason)
    console.log(`✓ ${r.merged ? '已合并别名' : '已登记'}：${r.entity.name}（${r.entity.kind}）${r.entity.aliases.length ? ' · 别名 ' + r.entity.aliases.join('/') : ''}`)
    rebuildEntityIndex(dir)
    return
  }
  if (sub === 'list') {
    const reg = loadEntityRegistry(dir)
    if (!reg.entities.length) {
      console.log('还没有登记实体。')
      return
    }
    const idx = loadEntityIndex(dir)
    for (const e of reg.entities) {
      const n = (idx[e.name] || []).length
      console.log(`- ${e.name.padEnd(6)} ${e.kind.padEnd(5)} ${n} 条点${e.aliases.length ? ' · 别名 ' + e.aliases.join('/') : ''}`)
    }
    return
  }
  if (sub === 'rebuild') {
    const r = rebuildEntityIndex(dir)
    console.log(`✓ 重建索引：${r.entities} 个实体，命中 ${r.matched} 个，扫了 ${r.points} 条点`)
    return
  }
  if (sub === 'show') {
    const name = args[0]
    if (!name) fail('用法：memory entity show <名字>')
    rebuildEntityIndex(dir)
    const ids = loadEntityIndex(dir)[name] || []
    console.log(`${name}：${ids.length} 条点`)
    for (const id of ids) console.log(`  - ${id}`)
    return
  }
  fail('用法：memory entity <add|list|rebuild|show> ...')
}

// ── fields（front matter 字段的接线表）────────────────────────────
/**
 * v0.76.0。这个仓库连续四次犯"接线断了一头"的错（contradicts / refuted_by / scope / learned_at），
 * 每次都不是逻辑写错。人的眼睛看不见，所以做成一条能跑的命令。
 *
 * 三种产生方式：她写（技能模板教了） / 代码写（某条命令在改） / 谁都不写（死字段）。
 * 表在 lib/fieldcheck.js 的 POINT_FIELDS，检查会核对表与代码是否一致。
 */
function cmdFields() {
  const r = checkFields(resolve(import.meta.dirname, '..'))
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(renderFields(r))
  }
  // 有孤儿字段就退 1：这条能进 CI，接的是"新增字段必须两头都接上"
  if (r.orphans.length || r.unregistered.length || r.deadWriters.length) process.exitCode = 1
}

// ── walls（四堵墙的数字）──────────────────────────────────────────
/**
 * v0.75.0。外部总结把伴侣记忆拆成四堵墙：记忆 / 触发 / 决定 / 连续。
 * 前三堵我们有机制，第四堵我们最强——**但没有一堵有指标**。
 * 这个命令只做一件事：把"墙有没有"变成"墙有多厚"。只读。
 */
function cmdWalls() {
  needDir()
  const r = wallsReport(dir)
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  for (const line of wallsSummary(dir)) console.log(line)

  console.log('')
  console.log('  记忆墙  点数 ' + r.memory.points + ' · 有 source ' + r.memory.withSource +
    ' · 可回溯 ' + r.memory.traceable + ' · 没有 source ' + r.memory.noSource +
    ' · 档案 ' + r.memory.archiveFiles + ' 个文件')
  console.log('  触发墙  共 ' + r.trigger.turns + ' 轮 · 门控挡掉 ' + r.trigger.gated +
    ' · 真查 ' + r.trigger.tried + ' · 空 ' + r.trigger.empty +
    (r.trigger.meaningful ? '' : '  ← 点数 0 时这个空率没有意义'))
  console.log('  决定墙  被推翻 ' + r.decision.superseded + ' 条（带新点 ' + r.decision.withBy +
    '）· 无反面证据的推翻 ' + r.decision.withoutEvidence + ' · 撤销工具 ' +
    (r.decision.canUnrefute ? '有' : '缺（未做 M4）'))
  console.log('  连续墙  漂移最大 ' + (r.continuity.driftWorst ?? '-') +
    '（比了 ' + r.continuity.driftFiles + ' 个文件）· 锚点 ' + r.continuity.anchors + '/' +
    r.continuity.anchorsTotal + ' · 金丝雀命中 ' + r.continuity.canary +
    ' · 前缀样本 ' + r.continuity.prefixSamples +
    (r.continuity.prefixVariants === null ? '' : ' · 不同取值 ' + r.continuity.prefixVariants))
}

// ── near-miss（差一点就想起的查询）────────────────────────────────
/**
 * R7（v0.73.0）。公开文章点破过一件事：
 * **「忘了」通常等于「没检索到」**——换个说法再问就出来了。
 *
 * `50_log/retrieval.log` 从这一版开始记 `nearMiss`（最好的那条没过线的分）。
 * 这个命令把 0.7–阈值之间的查询列出来，按出现次数排——补别名/加同义词最直接的清单。
 */
function cmdNearMiss() {
  needDir()
  const file = join(dir, '50_log', 'retrieval.log')
  if (!existsSync(file)) {
    console.log('（还没有检索日志：跑几轮对话再来）')
    return
  }
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  const lo = Number(flagValue('--above') || 0.7)
  const hits = rows.filter((r) => r.nearMiss && r.nearMiss.score >= lo)
  if (!hits.length) {
    console.log(`✓ 没有差一点的查询（看过 ${rows.length} 条日志，门槛 ${lo}）`)
    if (!rows.some((r) => 'nearMiss' in r)) {
      console.log('  注：这一版之前的日志没有 nearMiss 字段，等新的记录产生。')
    }
    return
  }
  const byQuery = new Map()
  for (const r of hits) {
    const key = String(r.query || '').trim().slice(0, 40)
    if (!key) continue
    const cur = byQuery.get(key) || { n: 0, best: 0, id: null, last: null }
    cur.n += 1
    if (r.nearMiss.score > cur.best) {
      cur.best = r.nearMiss.score
      cur.id = r.nearMiss.id
    }
    cur.last = r.at
    byQuery.set(key, cur)
  }
  const list = [...byQuery].sort((a, b) => b[1].n - a[1].n || b[1].best - a[1].best)
  console.log(`差一点的查询：${list.length} 个（门槛 ${lo}）`)
  for (const [q, v] of list.slice(0, 15)) {
    console.log(`  ×${v.n}  ${v.best}  「${q}」${v.id ? ` → 最接近 ${v.id}` : ''}`)
  }
  console.log('')
  console.log('  这些就是该补别名/同义字的入口：memory alias add <name> --aliases ...')
}

// ── timeline（时间轴）──────────────────────────────────────────
/** v0.40.0：看"现在 / 过去 / 计划"各有多少，顺便列计划的。 */
function cmdTimeline() {
  needDir()
  const now = new Date()
  const pts = readPointFiles(dir, '30_points')
  const c = timelineCounts(pts, now)
  console.log(`现在 ${c.current} · 过去 ${c.past} · 计划 ${c.future}（共 ${pts.length} 条）`)
  const rows = timelineRows(pts, now).filter((r) => r.bucket !== 'current')
  for (const r of rows.slice(0, 20)) {
    const when = r.bucket === 'future' ? r.valid_from : r.invalid_at || r.expires_at
    console.log(`  [${timeLabel(r.bucket)}] ${String(when || '').slice(0, 10)}  ${r.title}`)
  }
  if (!rows.length) console.log('  （没有过去或计划的点）')
}

// ── sleep（睡觉 / 结算）────────────────────────────────────────
/**
 * v0.39.0：
 *   memory sleep            看"现在算不算睡过一觉"（只读）
 *   memory sleep --now      手动结算一次（补账用；幂等）
 */
function cmdSleep() {
  needDir()
  const now = new Date()
  if (argv.includes('--now')) {
    const r = settle(dir, { now, points: readPointFiles(dir, '30_points') })
    console.log(r.slept ? `✓ 结算完成：睡了 ${r.hours} 小时，tier ${r.emotion.tierFrom}→${r.emotion.tierTo}` : `没睡（${r.reason}）；维护已跑`)
    return
  }
  const det = detectSleep(dir, { now })
  const st = loadSleep(dir)
  console.log(det.slept ? `算睡过：夜间静默 ${det.hours} 小时` : `不算睡过（${det.reason}）· 夜间重叠 ${det.hours} 小时`)
  console.log(`上次睡醒：${st.lastSleepAt ? String(st.lastSleepAt).slice(0, 16).replace('T', ' ') : '（还没有）'} · 累计 ${st.nights || 0} 次`)
}

// ── emotion（情绪状态 / 她自己挂情绪）──────────────────────────
/**
 * v0.38.0：
 *   memory emotion                         看档位与挂着的情绪（不发数字给她，只给人看）
 *   memory feel 委屈 0 "他说那话没看我"      她自己挂一个情绪（0 分钟 = 等他开口才散）
 */
function cmdEmotion(sub, args) {
  needDir()
  const st = loadEmotion(dir) || emptyState()
  if (sub === 'feel') {
    const [id, mins, ...rest] = args
    if (!id) fail('用法：memory feel <情绪> [分钟] [原因]')
    const r = addSpecial(st, { id, minutes: Number(mins) || 0, cause: rest.join(' ') })
    if (!r.ok) fail(r.reason)
    saveEmotion(dir, st)
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(
      join(dir, '50_log', 'emotion-manual.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), id: r.item.id, minutes: Number(mins) || 0, cause: r.item.cause, strength: r.item.strength }) + '\n',
      'utf8',
    )
    console.log(`✓ 挂上了：${r.item.id}（强度 ${r.item.strength}${Number(mins) > 0 ? `，${mins} 分钟后自己散` : '，等他开口才散'}）`)
    return
  }
  const tier = Number.isFinite(Number(st.tier)) ? Number(st.tier) : TIER_DEFAULT
  console.log(`档位：${tier} ${TIER_TEXT[tier] || ''}${st.frozenUntil && Date.parse(st.updatedAt || 0) ? '' : ''}`)
  const sp = specialsLine(st)
  console.log(`挂着的：${sp || '（没有）'}`)
  const line = emotionLine(st, { showWhenQuiet: true })
  console.log(`会注入：${line.text || '（空）'}  ${line.tokens || 0} tok`)
}

// ── behavior（行为账本）────────────────────────────────────────
/**
 * v0.38.0：只记数、不推分。默认看 7 天。
 *   memory behavior              看计数（封顶 5）
 *   memory behavior --days 30    看更久
 *   memory behavior --prune      清掉 14 天前的行
 */
function cmdBehavior() {
  needDir()
  if (argv.includes('--prune')) {
    const r = pruneBehavior(dir)
    console.log(`✓ 清掉 ${r.before - r.after} 行（保留 ${r.after} 行）`)
    return
  }
  const days = Number(flagValue('--days') || 7)
  const r = behaviorCounts(dir, { days })
  if (!r.total) {
    console.log(`最近 ${days} 天没有可记的行为。`)
    return
  }
  for (const [kind, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) {
    const raw = r.raw[kind] || n
    console.log(`- ${kind.padEnd(6)} ${n}${raw > n ? `（原始 ${raw}，封顶 5）` : ''}`)
  }
}

// ── were（上次聊到哪儿）────────────────────────────────────────
/** v0.37.0：读/重写「上次聊到哪儿」的纸条（给轻唤醒用，只摘原话不写结论）。 */
function cmdWere() {
  needDir()
  const apply = argv.includes('--write')
  if (apply) {
    const r = writeWere(dir, { points: readPointFiles(dir, '30_points') })
    console.log(`✓ 已重写 ${r.path}（${r.chars} 字）`)
    return
  }
  const text = readWere(dir)
  if (!text) {
    console.log('还没有纸条。加 --write 生成一张。')
    return
  }
  console.log(text)
  console.log(`（${[...text].length} 字 · 重写：memory were --write）`)
}

// ── habit（说话习惯）────────────────────────────────────────────
/**
 * v0.36.0：权重自动、文本人写。
 *   memory habit list            看权重与门限
 *   memory habit add "不主动说教"  加一条（默认 w=0.4，还没证明她做得到）
 *   memory habit block           看现在会注入什么
 */
function cmdHabit(sub, arg) {
  needDir()
  if (sub === 'list' || !sub) {
    const rows = habitsSummary(dir)
    for (const r of rows) {
      console.log(`- ${r.level.padEnd(2)} w=${r.w.toFixed(3)}  命中${r.hits} 违反${r.violations}  ${r.text}`)
    }
    console.log('\n门限：≥0.75 硬性 · ≥0.5 平时 · <0.3 归档（不注入）')
    return
  }
  if (sub === 'add') {
    if (!arg) fail('用法：memory habit add "习惯文本"')
    const r = addHabit(dir, arg)
    if (!r.ok) fail(r.reason)
    console.log(`✓ 已加（共 ${r.count} 条）。文本人写，权重由她自己的表现涨落。`)
    return
  }
  if (sub === 'block') {
    const b = habitsBlock(dir)
    console.log(b.text ? `${b.text}   （${b.tokens} tok）` : '（现在没有够重的习惯，不注入）')
    return
  }
  fail('用法：memory habit <list|add|block> ...')
}

// ── alias（别名半自动，v0.48.0）────────────────────────────────
/**
 * 召回率的天花板不在打分，在"词不是同一个词"。
 * 实测：同义改述的二字组重合与词级重合都是 0.00（见 RESEARCH-2026-11-04 §A1）。
 * 唯一能连上两套措辞的是别名，而别名只能由人点头——自动猜同义词 = 永久污染检索。
 *
 *   memory alias                      覆盖率 + 有待办的点
 *   memory alias propose [<点>]       从他的措辞里挖候选（不写任何东西）
 *   memory alias accept <点> <词...>   写回点的 aliases
 *   memory alias reject <点> <词>      进拒绝表，以后不再提
 *   memory alias list [<点>]          现在有哪些别名
 */
function cmdAlias(sub, args) {
  needDir()
  if (!sub) {
    const c = aliasCoverage(dir)
    const rows = mineAll(dir, { minSupport: 3, limit: 3 })
    console.log(`别名覆盖：${c.withAlias}/${c.points} 个 active 点（${(c.rate * 100).toFixed(0)}%）`)
    if (!c.points) {
      console.log('（库里还没有 active 点——先有记忆，才谈得上别名）')
      return
    }
    if (!rows.length) {
      console.log('没有挖到候选。要么他已经用同一套词，要么档案还不够多。')
      return
    }
    console.log('\n有候选的点：')
    for (const r of rows) console.log(`  ${r.point}  ${r.candidates.map((x) => `${x.term}(${x.support})`).join(' ')}`)
    console.log('\n下一步：memory alias propose <点> 看证据；memory alias accept <点> <词> 写回')
    return
  }
  if (sub === 'propose') {
    const id = args[0]
    if (!id) {
      const rows = mineAll(dir, { minSupport: 3, limit: 5 })
      if (!rows.length) return console.log('没有候选。')
      for (const r of rows) {
        console.log(`\n${r.point}`)
        for (const x of r.candidates) console.log(`  ${x.term.padEnd(8)} 共现 ${x.support} 条（他说的 ${x.inUser}）  例：${x.sample}`)
      }
      console.log('\n（只看不写。accept 才会进点文件。）')
      return
    }
    const p = scanPointFiles(dir).points.find((x) => x.id === id || x.filename === id)
    if (!p) fail(`找不到点 ${id}`)
    const r = mineAliases(dir, p, { minSupport: 2, limit: 20 })
    console.log(`${p.id}  ${p.title}`)
    console.log(`已有的词：${[...pointVocab(p)].join(' ') || '（无）'}`)
    if (!r.candidates.length) return console.log('\n没有候选：他的措辞没有偏离这条点的词表。')
    console.log(`\n候选（共现 ${r.scanned} 条相关消息）：`)
    for (const x of r.candidates) console.log(`  ${x.term.padEnd(8)} 共现 ${x.support}（他 ${x.inUser}）  ${x.sample}`)
    console.log('\naccept 才会写回；reject 之后不再提。')
    return
  }
  if (sub === 'accept') {
    const [id, ...terms] = args
    if (!id || !terms.length) fail('用法：memory alias accept <点> <词> [更多词...]')
    for (const t of terms) {
      const r = acceptAlias(dir, id, t)
      if (!r.ok) fail(`${t}：${r.reason}`)
      console.log(r.added ? `✓ ${id} += ${t}（现有 ${r.aliases.length} 条）` : `· ${id} 已有 ${t}，跳过`)
    }
    console.log('\n下轮检索就生效（store 有 30s 缓存，最迟半分钟后）。')
    return
  }
  if (sub === 'reject') {
    const [id, ...terms] = args
    if (!id || !terms.length) fail('用法：memory alias reject <点> <词>')
    for (const t of terms) {
      const r = rejectAlias(dir, id, t)
      if (!r.ok) fail(`${t}：${r.reason}`)
    }
    console.log(`✓ ${id} 的 ${terms.join(' ')} 已进拒绝表，以后不再提`)
    return
  }
  if (sub === 'list') {
    const id = args[0]
    const rows = aliasOverview(dir)
    const sel = id ? rows.filter((r) => r.id === id) : rows
    if (!sel.length) return console.log(id ? `${id} 没有别名` : '还没有任何点带别名')
    for (const r of sel) console.log(`${r.id.padEnd(16)} ${r.aliases.join(' / ')}   — ${r.title}`)
    return
  }
  fail('用法：memory alias [propose|list|accept|reject] ...')
}

// ── cliche（套话密度）──────────────────────────────────────────
/**
 * v0.46.1：只读地数"多少轮带着套话"。
 *
 *   memory cliche [--days 7] [--json]   看密度与分布
 *   memory cliche test "我记下了"        看一句话命中哪几族（调试短语表用）
 *
 * 刻意不做的事：不注入提醒、不改写、不扣权重。
 * 提醒本身会变成新的腔调；"别说 X"还会把 X 喂到眼前。
 * 管住她的是 `00_core/rules.md` 的「说话」三条，这里只量它有没有用。
 */
function cmdCliche(sub, args) {
  needDir()
  if (sub === 'test') {
    const text = args.join(' ')
    if (!text) fail('用法：memory cliche test "一句话"')
    const hit = findCliches(text)
    console.log(hit.count ? `命中：${hit.labels.join(' / ')}（${hit.matches.join('、')}）` : '没有命中')
    return
  }
  const days = Number(flagValue('--days') || 7)

  // v0.47.1：回放——拿档案里已有的她的终稿重算，给"加规则之前"的基线
  if (argv.includes('--replay')) {
    const split = flagValue('--split') || null
    const rp = clicheReplay(dir, { days: Number(flagValue('--days') || 90), split })
    if (argv.includes('--json')) {
      console.log(JSON.stringify(rp, null, 2))
      return
    }
    const pct = (x) => Math.round(x.rate * 1000) / 10
    console.log(`回放近 ${rp.days} 天：她回了 ${rp.totalTurns} 轮${rp.metaTurns ? `（另有 ${rp.metaTurns} 轮在讨论套话本身，已排除）` : ''}`)
    console.log(`  全部：${rp.all.hitTurns} 轮带套话（${pct(rp.all)}%）`)
    if (rp.split && rp.before && rp.after) {
      console.log(`  切点 ${rp.split} 之前：${rp.before.turns} 轮 · ${rp.before.hitTurns} 轮命中（${pct(rp.before)}%）`)
      console.log(`  切点 ${rp.split} 之后：${rp.after.turns} 轮 · ${rp.after.hitTurns} 轮命中（${pct(rp.after)}%）`)
    }
    console.log('\n只读回放：不改档案、不写日志。')
    return
  }

  const r = clicheReport(dir, { days })
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  if (!r.totalTurns && !r.hitTurns) {
    console.log(`近 ${days} 天没有可算的样本（档案里还没有她的终稿，或插件低于 0.46.1）。`)
    return
  }
  const pct = Math.round(r.rate * 100)
  console.log(`近 ${days} 天：她回了 ${r.totalTurns} 轮，${r.hitTurns} 轮带套话（${pct}%）`)
  if (r.ranked.length) {
    console.log(`  ${r.ranked.map((x) => `${x.label} ${x.n}`).join(' · ')}`)
    console.log(`最常见：${r.top.label}（${r.top.n} 轮）`)
  }
  console.log('\n这个数字只用来对照 `00_core/rules.md` 的「说话」三条；不注入、不拦截、不改权重。')
  pruneClicheLog(dir)
}

// ── presence（在场记录 / 回来第一句）────────────────────────────/** v0.35.0：看"他上次在场是多久前"。回来第一句就是靠这个算的。 */
function cmdPresence() {
  needDir()
  console.log(presenceSummary(dir))
  const state = loadPresence(dir)
  if (state.lastSeen) {
    const r = returnLine({ state, lastTopic: '', question: '' })
    console.log(r.shown ? `下次他回来会看到：${r.text}` : `（间隔 < ${RETURN_GAP_HOURS} 小时，或这次已经说过）`)
  }
}

// ── snapshot（快照 / 回滚）──────────────────────────────────────
/**
 * v0.34.0：借"天上鱼"的快照纪律——改之前先拍一张，红了退回，不往前打补丁。
 *   memory snapshot              拍一张（自动带时间戳）
 *   memory snapshot 改遗忘参数    带个标签
 *   memory snapshot --list       看有哪些
 *   memory snapshot --restore <名> --force   回滚（会覆盖当前库，必须 --force）
 */
function snapshotRoot() {
  return join(dirname(dir), 'fish-memory-snapshots')
}

function cmdSnapshot(arg) {
  needDir()
  const root = snapshotRoot()
  if (argv.includes('--list')) {
    if (!existsSync(root)) {
      console.log('还没有快照。')
      return
    }
    const items = readdirSync(root).filter((f) => f.startsWith('snap-')).sort()
    if (!items.length) {
      console.log('还没有快照。')
      return
    }
    for (const f of items) console.log(`- ${f}`)
    return
  }
  if (argv.includes('--restore')) {
    const name = argv[argv.indexOf('--restore') + 1]
    if (!name) fail('用法：memory snapshot --restore <snap-...> --force')
    const src = join(root, name)
    if (!existsSync(src)) fail(`找不到快照：${src}`)
    if (!argv.includes('--force')) fail('回滚会覆盖当前库；确认无误请加 --force')
    const r = unpackMemory(src, dir, { force: true })
    console.log(`✓ 已回滚到 ${name}（${r.files} 个文件）`)
    return
  }
  const tag = String(arg || 'snap').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 24)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const dest = join(root, `snap-${stamp}-${tag}`)
  const r = packMemory(dir, dest, { force: true })
  console.log(`✓ 快照 ${r.files} 个文件，${(r.bytes / 1024 / 1024).toFixed(2)} MB → ${dest}`)
  console.log('  回滚：memory snapshot --restore ' + basename(dest) + ' --force')
}

// ── voice（口癖采集）────────────────────────────────────────────
/**
 * v0.33.0：只提案，不改 voice.md。
 *   memory voice mine              从档案里挑"她真说过、反复说"的句子 → 40_pending/ 提案
 *   memory voice list              看现有提案
 *   memory voice accept 1,3|all    接受（才写 voice.md，并记 core_changelog）
 *   memory voice reject 2|all      拒绝（以后不再提）
 */
function cmdVoice(sub, arg) {
  needDir()
  if (sub === 'mine') {
    const limit = Number(flagValue('--limit') || 12)
    const c = mineVoice(dir, { limit })
    if (!c.length) {
      console.log('没有可提议的句子（要么样本太少，要么都已经在 voice.md 里）。')
      return
    }
    const r = writeVoiceProposal(dir, c)
    console.log(`✓ 提案 ${r.count} 句 → ${r.path}`)
    console.log('  它**没有**改 voice.md；打开看一眼，再 memory voice accept 1,3|all')
    return
  }
  if (sub === 'list') {
    const files = listProposals(dir)
    if (!files.length) {
      console.log('还没有提案。先 memory voice mine')
      return
    }
    for (const f of files) {
      const items = readProposal(dir, f)
      console.log(`- ${f}  （${items.length} 句）`)
      for (const it of items) console.log(`    ${it.n}. ${it.text}`)
    }
    return
  }
  if (sub === 'accept' || sub === 'reject') {
    const files = listProposals(dir)
    if (!files.length) fail('还没有提案，先 memory voice mine')
    const file = files[files.length - 1]
    const items = readProposal(dir, file)
    const picks = arg === 'all' || !arg ? items : items.filter((it) => arg.split(',').map((x) => x.trim()).includes(String(it.n)))
    if (!picks.length) fail('没选中任何一句（用法：memory voice accept 1,3 | all）')
    const texts = picks.map((x) => x.text)
    if (sub === 'accept') {
      const r = acceptVoice(dir, texts, { proposalPath: file })
      if (!r.ok) fail(r.reason)
      console.log(`✓ 已写进 voice.md：第 ${r.from}–${r.to} 段（共 ${r.added} 句）· changelog v${String(r.version).padStart(3, '0')}`)
      console.log('  别忘了：voice.md 是核心层，改完建议跑一次 memory verify')
    } else {
      const r = rejectVoice(dir, texts)
      console.log(`✓ 已拒绝 ${r.rejected} 句（累计 ${r.total} 句）；以后不会再提`)
    }
    return
  }
  fail('用法：memory voice <mine|list|accept|reject> ...')
}

// ── redact（隐私脱敏）──────────────────────────────────────────
/**
 * v0.31.0：扫旧档案，把明文密钥/手机号/身份证换成标记。
 *   memory redact            先看（dry，不动任何文件）
 *   memory redact --apply    真的改（会重算档案链，并写 50_log/redaction.log）
 */
function cmdRedact() {
  needDir()
  const apply = argv.includes('--apply')
  const r = redactArchive(dir, { dry: !apply })
  if (!r.scanned) {
    console.log('档案里没有东西可扫。')
    return
  }
  if (!r.changed) {
    console.log(`扫了 ${r.scanned} 条，没有发现敏感信息。`)
    return
  }
  const sum = r.hits.map((h) => `${h.kind}×${h.count}`).join(' · ')
  if (!apply) {
    console.log(`扫了 ${r.scanned} 条，命中 ${r.changed} 条（${sum}）。`)
    console.log('确认要改就加 --apply（会重算档案链，并写 50_log/redaction.log）')
    return
  }
  console.log(`✓ 已脱敏 ${r.changed}/${r.scanned} 条（${sum}）；链已重算，日志在 50_log/redaction.log`)
}

// ── dormant（遗忘层）────────────────────────────────────────────
/**
 * v0.29：遗忘层是独立目录 31_dormant/。
 *   memory dormant list            看层里有什么（张力之外的第二层）
 *   memory dormant revive <id>     手动复活（相当于"你又提起了它"）
 *   memory forget --migrate        把旧 status=dormant 的点迁进层（一次性）
 */
function cmdDormant(sub, arg) {
  needDir()
  if (sub === 'list') {
    const layer = readPointFiles(dir, '31_dormant')
    if (!layer.length) {
      console.log('遗忘层是空的。')
      return
    }
    for (const p of layer) {
      const at = (/^dormant_at:\s*(.+)$/m.exec(p.raw) || [])[1] || ''
      console.log(`- ${p.id}  ${String(at).slice(0, 10)}  ${p.title}`)
    }
    console.log(`\n共 ${layer.length} 条 · 复活：memory dormant revive <id>`)
    return
  }
  if (sub === 'find') {
    if (!arg) fail('用法：memory dormant find <关键词> [--apply]')
    const hits = findDormant(dir, arg)
    if (!hits.length) {
      console.log('遗忘层里没有对得上的。')
      return
    }
    for (const h of hits) console.log(`- ${h.id}  ${String(h.dormant_at || '').slice(0, 10)}  第${h.resurrections}次   ${h.title}`)
    if (argv.includes('--apply')) {
      let n = 0
      for (const h of hits) {
        const r = revivePoint(dir, h.id)
        if (r.ok) n += 1
      }
      console.log(`✓ 捞回 ${n} 条（时钟从今天重新走；S×1.6）`)
      return
    }
    console.log(`\n共 ${hits.length} 条 · 捞回：同一个关键词加 --apply`)
    return
  }
  if (sub === 'revive') {
    if (!arg) fail('用法：memory dormant revive <id>')
    const r = revivePoint(dir, arg)
    if (!r.ok) fail(r.reason)
    console.log(`✓ ${arg} 已复活（第 ${r.revivals} 次）· S=${r.S}${r.permanent ? ' · 已转 pin: soft，不会再进遗忘层' : ''}`)
    return
  }
  fail('用法：memory dormant <list|revive> ...')
}

// ── question（缺口/放不下的事）──────────────────────────────────
/**
 * v0.27.0：想不起来的事不是"忘了"，是她会一直惦记。
 *   memory question add "<她放不下什么>" [--from recall]
 *   memory question list [--top N]
 *   memory question touch <id>      # 说出来会松（显式才算）
 *   memory question resolve <id> [--by <点 id>]
 */
function cmdQuestion(sub, arg) {
  needDir()
  if (sub === 'add') {
    if (!arg) fail('用法：memory question add "<她放不下什么>" [--from recall|look|read|dream|self]')
    const r = addQuestion(dir, { text: arg, from: flagValue('--from') || 'self' })
    if (!r.ok) fail(r.reason)
    console.log(`✓ 记下了：${r.item.id}（${r.item.text}）`)
    if (r.dropped?.length) console.log(`  淘汰了最轻的 ${r.dropped.length} 条：${r.dropped.join(', ')}`)
    return
  }
  if (sub === 'list') {
    const rows = rankedQuestions(dir)
    if (!rows.length) {
      console.log('还没有放不下的事。')
      return
    }
    for (const q of rows.slice(0, Number(flagValue('--top') || 20))) {
      console.log(`${q.now_tension >= 60 ? '●' : '○'} ${q.id}  张力 ${String(q.now_tension).padStart(5)}  ${q.text}`)
    }
    return
  }
  if (sub === 'touch') {
    if (!arg) fail('用法：memory question touch <id>')
    const r = touchQuestion(dir, arg)
    if (!r.ok) fail(r.reason)
    console.log(`✓ ${arg}：张力 ${r.before} → ${r.item.tension}（说出来会松，但不会忘干净）`)
    return
  }
  if (sub === 'resolve') {
    if (!arg) fail('用法：memory question resolve <id> [--by <点 id>]')
    const r = resolveQuestion(dir, arg, { by: flagValue('--by') })
    if (!r.ok) fail(r.reason)
    console.log(`✓ ${arg} 标成想通了${r.item.resolved_by ? `（${r.item.resolved_by}）` : ''}`)
    return
  }
  fail('用法：memory question <add|list|touch|resolve> ...')
}

// ── soul（人格修订提案）────────────────────────────────────────
/**
 * 人格修订（v0.26.0）：修"叙事 → 人格"的桥。
 *
 *   memory soul-drift                 看自述与 soul 可变区差多少
 *   memory soul-propose [--force]     生成提案到 40_pending/_soul/（**不改 soul**）
 *   memory soul-apply <提案> [--force] 人审后应用：六道校验 → 旧版快照 → 写新 soul → changelog
 */
function cmdSoul(sub, arg) {
  needDir()
  const points = readPointFiles(dir, '30_points')
  if (sub === 'drift') {
    const soul = readSoul(dir)
    if (!soul) fail('00_core/soul.md 不存在')
    const self = latestSelf(dir)
    if (!self) {
      console.log('还没有自述（15_self/ 为空）。先写：memory self-draft → self-promote')
      return
    }
    const d = driftOf(mutableRegion(soul), self)
    console.log(`自述 vs soul 可变区：漂移 ${(d * 100).toFixed(1)}%`)
    console.log(`  提案阈值 ${(SOUL_DRIFT_MIN * 100).toFixed(0)}% · 单次上限 ${(SOUL_DRIFT_MAX * 100).toFixed(0)}%`)
    console.log(d >= SOUL_DRIFT_MIN ? '  → 够格提修订（memory soul-propose）' : '  → 还不够格，先继续过日子')
    return
  }
  if (sub === 'propose') {
    const r = proposeRevision(dir, points, { force: argv.includes('--force') })
    if (!r.ok) fail(`不提案：${r.reason}（自述漂移 ${((r.sourceDrift || 0) * 100).toFixed(1)}%）`)
    console.log(`✓ 提案已生成：${r.path}`)
    console.log(`  自述漂移 ${(r.sourceDrift * 100).toFixed(1)}% · 本次改动 ${(r.editDrift * 100).toFixed(1)}%（上限 ${(SOUL_DRIFT_MAX * 100).toFixed(0)}%）`)
    if (r.voiceNote) console.log(`  ⚠ ${r.voiceNote}`)
    console.log('  它**没有**改 soul.md；用 memory soul-apply 应用')
    console.log('  建议先打开看一眼：填一句"她哪里不一样了"，再 apply。')
    return
  }
  if (sub === 'apply') {
    if (!arg) fail('用法：memory soul-apply <40_pending/_soul/rev-*.md> [--force]')
    const r = applyRevision(dir, arg, points, { force: argv.includes('--force') })
    if (!r.ok) {
      console.error('✗ 没通过，soul.md 一个字节都没动：')
      for (const e of r.errors) console.error(`    ${e.field}: ${e.message}`)
      process.exit(1)
    }
    console.log(`✓ 已应用：soul.md → v${r.version}（旧版 ${r.snapshot}，改动 ${(r.drift * 100).toFixed(1)}%）`)
    for (const w of r.warnings || []) console.log(`  ⚠ ${w}`)
    try {
      refreshFingerprint(dir)
    } catch {
      /* 刷新失败不影响结果 */
    }
    console.log(`  changelog 已记一行；7 天内已用 ${changes7d(dir)}/2`)
    return
  }
  fail('用法：memory soul <drift|propose|apply> ...')
}

// ── stats ─────────────────────────────────────────────────────
/**
 * 用真实日志算账（v0.24.0）：注入均值/中位/峰值 + 分层占比 + 门控与命中率 + 每轮成本。
 * 只读 50_log 下的 token.log / retrieval.log，不写任何东西。
 */
function cmdStats() {
  needDir()
  const days = Number(flagValue('--days') || 7)
  const s = computeStats(dir, { days })
  if (flagValue('--json') !== undefined || argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 2))
    return
  }
  // v0.28.1：她长到哪了（只读统计，借《数字生命》的 L1–L4，但按我们库里的真东西定义）
  try {
    const m = maturity(dir)
    console.log(`成熟度：${m.stage} ${m.label} · 点 ${m.points} · 自述 ${m.self} 篇 · 修订 ${m.revisions} 次${m.stalled ? ' · 停滞风险' : ''}`)
    if (m.reasons.length) console.log(`  ${m.reasons.join(' · ')}`)
  } catch {
    /* 成熟度算不出不影响账本 */
  }
  const price = Number(flagValue('--price') || 4)
  const turns = Number(flagValue('--turns') || 100)
  const cost = estimateCost(s.injection, { yuanPerMTok: price, turnsPerDay: turns })
  const yuan = (n) => `¥${n.toFixed(3)}`

  console.log(`最近 ${s.days} 天 · ${s.turns} 轮（门控跳过 ${s.gate.skipped} · ${s.gate.skippedPct}%）`)
  console.log(`注入 token：均值 ${s.injection.mean} · 中位 ${s.injection.median} · 峰值 ${s.injection.max}`)
  const total = s.injection.mean || 1
  for (const [k, v] of Object.entries(s.injection.layers).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${String(v).padStart(5)} tok · 占 ${Math.round((v / total) * 100)}%`)
  }
  console.log(`检索：门控 ${s.retrieval.gated}/${s.retrieval.rows} 轮（${s.retrieval.gatedPct}%）· 命中 ${s.retrieval.hits} 轮（${s.retrieval.hitPct}%）· 平均命中 ${s.retrieval.avgRendered} 条`)
  console.log(`丢弃：正文 ${s.retrieval.dropped} · 核心 ${s.retrieval.coreDropped}` + (s.retrieval.msMean == null ? '' : ` · 检索耗时均值 ${s.retrieval.msMean}ms`))
  const usage = assetUsage(readPointFiles(dir, '30_points'), loadAssets(dir).books)
  if (usage.length) {
    console.log('素材：')
    for (const u of usage) console.log(`  ${u.points > 0 ? '•' : '○'} ${String(u.kind || 'book').padEnd(10)} ${u.title}  ${u.points} 条点`)
  }
  console.log(`\n每轮成本（¥${price}/M 输入 · 按 ${turns} 轮/日）：${yuan(cost.perTurn)}/轮 · ${yuan(cost.perDay)}/日 · ${yuan(cost.perMonth)}/月`)
  console.log('  （口径：只算插件注入，不含对话历史与输出；缓存命中时实际更低）')
}

// ── book ──────────────────────────────────────────────────────
/**
 * 书源（v0.22.0）：**书在库外，库里只留读过的痕迹**。
 *
 * 为什么不让书进库：整本几十万 token，进档案后每次翻档案都可能把原文捞出来；
 * 而她要的不是背原文，是"记住几个有波动的地方 + 对整本书的感受"。
 * 所以原文放在库外的书库目录（默认 <库>/../fish-memory-books），
 * 库里只有 20_state/books.json（引用清单）和几个 source 指向书源的点。
 */
function cmdBook(sub, arg) {
  needDir()
  if (sub === 'add') {
    if (!arg) fail('用法：memory asset add <文件> --kind book|doc|transcript|image|audio|video [--title 名字]')
    const kind = flagValue('--kind') || 'doc'
    const { entry, reused } = addAsset(dir, arg, { title: flagValue('--title'), kind })
    console.log(reused ? '· 这个素材已经登记过（同一 sha256），复用清单项' : '✓ 已登记素材（原文拷进库外素材目录，没进记忆库）')
    console.log(`  id    ${entry.id}`)
    console.log(`  类型  ${entry.kind}`)
    console.log(`  标题  ${entry.title}`)
    console.log(`  规模  ${entry.lines == null ? '(非文本)' : `${entry.lines} 行`} / ${Math.round(entry.bytes / 1024)} KB`)
    console.log(`  素材库 ${assetsRoot(dir)}`)
    console.log(`  引用写法：source: [asset:${entry.kind}:${entry.id}${entry.kind === 'image' || entry.kind === 'audio' || entry.kind === 'video' ? '' : '#L123'}]`)
    return
  }
  if (sub === 'list') {
    const rows = listAssets(dir)
    if (!rows.length) {
      console.log('还没有登记过素材。用法：memory asset add <文件> --kind doc --title 名字')
      return
    }
    for (const b of rows) {
      console.log(`${b.retired ? '⊘' : b.present ? '✓' : '✗'} ${String(b.kind || 'book').padEnd(10)} ${b.id.padEnd(22)} ${b.title}  (${b.lines == null ? '非文本' : `${b.lines} 行`})`)
    }
    console.log(`\n素材库根：${assetsRoot(dir)}`)
    return
  }
  if (sub === 'retire' || sub === 'unretire') {
    if (!arg) fail('用法：memory asset retire <id> [--reason 原因]')
    const r = sub === 'retire'
      ? retireAsset(dir, arg, { reason: flagValue('--reason') })
      : unretireAsset(dir, arg)
    if (!r.ok) fail(r.reason)
    console.log(sub === 'retire' ? `✓ ${arg} 已退役（清单保留、点不动、引用仍可核对）` : `✓ ${arg} 已恢复`)
    return
  }
  if (sub === 'verify') {
    const reg = loadAssets(dir).books
    const rows = arg ? [[arg, reg[arg]]] : Object.entries(reg)
    if (!rows.length) {
      console.log('清单是空的')
      return
    }
    let bad = 0
    for (const [id, entry] of rows) {
      const v = verifyAsset(dir, entry)
      if (v.ok) console.log(`✓ ${id}`)
      else {
        bad += 1
        console.error(`✗ ${id}：${v.reason}`)
      }
    }
    if (bad) process.exitCode = 1
    return
  }
  fail('用法：memory book <add|list|verify> ...')
}

// ── wakeup ────────────────────────────────────────────────────
/** 唤醒包（总设计 §11.1）：五件，目标 ≤4,000 tok。只读，不碰档案与记忆点 */
function cmdWakeup() {
  needDir()
  const out = flagValue('--out')
  // 默认只认 00_core/voice.md；抽档案必须显式开（工作汇报不是她的语气）
  let r
  try {
    r = writeWakeup(dir, { out, sampleVoice: flags.has('--sample-voice') })
  } catch (e) {
    // 落点不合法（写进真相层）当场停，而不是写完才发现 memory check 红了
    fail(String(e?.message || e))
  }
  if (r.external) {
    console.error(`! 写到库外了：${r.outDir}`)
    console.error('  里面是她的灵魂全文与对话原句，走网盘/发人之前想清楚。')
  }
  if (flags.has('--json')) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  const s = r.stats
  console.log(`✓ 唤醒包：${r.outDir}`)
  for (const f of r.files) {
    const f2 = s.perFile[f]
    console.log(`  ${f.padEnd(16)} ${String(f2.tokens).padStart(5)} tok  sha256 ${f2.sha256.slice(0, 12)}`)
  }
  console.log(
    `合计 ${s.tokens} tok / 目标 ≤ ${s.target}` +
      (s.over ? `（**超出 ${-s.headroom}**，回 S7 前要砍）` : `（余 ${s.headroom}）`),
  )
  console.log(
    `素材：记忆点 ${s.points} 条 · 档案 ${s.days} 天 · voice ` +
      (s.voice.source === 'voice.md'
        ? '取自 00_core/voice.md'
        : s.voice.source === 'archive'
          ? `档案里抽 ${s.voice.segments ?? 0} 段（未经人审）`
          : '**缺**：`00_core/voice.md` 的「## 现在」还是空的'),
  )
  if (s.voice.reason === 'archive-looks-like-work') {
    console.log('  ⚠ 档案里她的话全像工作汇报（代码/命令/长解释），一段都没抽——这一格得人工挑。')
  }
  if (r.overwrote) console.log('（这个目录里已有 manifest.json，已覆盖）')
  console.log('只读生成：10_archive / 30_points 一个字节都没动。')
}

// ── tokens ────────────────────────────────────────────────────
/** 每轮注入 token 的账（本地模型 §10.2）。看趋势用，不看单轮 */
function cmdTokens() {
  needDir()
  const raw = flagValue('--days')
  const days = raw === undefined ? 7 : Number(raw)
  if (!Number.isFinite(days) || days < 1) fail('--days 要是正整数')
  const s = summarizeTokenLog(dir, { days })
  if (flags.has('--json')) {
    console.log(JSON.stringify(s, null, 2))
    return
  }
  if (!s.turns) {
    console.log(`最近 ${days} 天没有 token 记账（50_log/token.log 是空的）。`)
    console.log('正常：只有插件真的装配过一次注入才会写。开养后每轮一行。')
    return
  }
  console.log(`最近 ${days} 天 · ${s.turns} 轮（检索 ${s.turns - s.gated} / 门控跳过 ${s.gated}）`)
  console.log(`注入 token：均值 ${s.avg} · 中位 ${s.p50} · 峰值 ${s.max} · 合计 ${s.total_tokens}`)
  const rows = Object.entries(s.blocks)
    .filter(([, v]) => v.avg > 0)
    .sort((a, b) => b[1].avg - a[1].avg)
  for (const [k, v] of rows) {
    console.log(`  ${k.padEnd(8)} 均值 ${String(v.avg).padStart(6)} tok · 峰值 ${String(v.max).padStart(5)} · 占 ${v.share}%`)
  }
  if (s.bad_lines) console.log(`  （${s.bad_lines} 行坏 JSON 已跳过）`)
  if (s.by_day.length) {
    console.log('按天：')
    for (const d of s.by_day) console.log(`  ${d.day}  ${String(d.turns).padStart(3)} 轮 · 均值 ${d.avg} tok`)
  }
  console.log('设计里另外三列（history / out / local_*）是宿主与小模型的账，插件测不到，没编。')
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

  // v0.50.0（C1 小步）：难题组——一把会输的尺子
  if (flagValue('--set') === 'hard') {
    const r = runHard({ threshold: Number(flagValue('--threshold') || 0.5) })
    const floor = flagValue('--floor') === undefined ? null : Number(flagValue('--floor'))
    if (flags.has('--json')) {
      console.log(JSON.stringify(r, null, 2))
      if (floor != null && r.rate < floor) process.exit(1)
      return
    }
    console.log(`难题组：${r.hit}/${r.total} top-1（${Math.round(r.rate * 100)}%）· 近 3 ${r.near} · 未进 ${r.miss} · 命中错条 ${r.bad}`)
    for (const [cat, c] of Object.entries(r.byCategory)) {
      console.log(`  ${cat}：${c.hit}/${c.total} top-1` + (c.bad ? ` · 错条 ${c.bad}` : '') + (c.near ? ` · 近 3 ${c.near}` : ''))
    }
    console.log('')
    for (const row of r.rows) {
      const mark = row.verdict === 'hit' ? '✓' : row.verdict === 'near' ? '~' : row.verdict === 'bad' ? '✗错条' : '✗'
      console.log(`  ${mark.padEnd(4)} ${row.query} → ${row.got ?? '空'}（期望 ${row.expect}）` + (row.range ? ` · 窗 ${row.range}` : ''))
    }
    if (floor != null) {
      if (r.rate < floor) fail(`难题组低于下限：${Math.round(r.rate * 100)}% < ${Math.round(floor * 100)}%`)
      console.log(`\n✓ 不低于下限 ${Math.round(floor * 100)}%`)
    }
    return
  }

  // v0.49.0（C3）：pass^k——参数扰动 k 次，看每条查询是不是每次都还 top-1
  const repeatArg = flagValue('--repeat')
  if (repeatArg !== undefined) {
    const repeat = Number(repeatArg)
    if (!Number.isFinite(repeat) || repeat < 2 || repeat > 20) fail('--repeat 要是 2..20 的整数')
    const jitter = Number(flagValue('--jitter') || 0.05)
    const st = goldStability({ repeat, jitter, threshold })
    if (flags.has('--json')) {
      console.log(JSON.stringify(st, null, 2))
      process.exit(st.passRate >= 0.9 ? 0 : 1)
    }
    console.log(`金标 pass^${st.repeat}（扰动 ±${Math.round(st.jitter * 100)}%）：稳定 ${st.stable}/${st.detail.length} = ${Math.round(st.passRate * 100)}%`)
    console.log(`  不稳 ${st.fragile} · 一次没中 ${st.alwaysMiss}`)
    for (const x of st.runs) console.log(`  第 ${x.i} 次：${x.hits}/${x.total} · 阈值 ${x.threshold} · 边际 ${x.margin}`)
    if (st.worst.length) {
      console.log('  不稳的：')
      for (const w of st.worst) console.log(`    ${w.query} → ${w.hits}/${w.of}`)
    }
    process.exit(st.passRate >= 0.9 ? 0 : 1)
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
    // v0.67.1（F2）：以前写死验插件包，--dir 完全不看——
    // 于是 `memory verify --dir Z:\根本不存在` 也会「✓ 自检通过」。
    // 现在：给了 --dir 就验**那个库**（档案链），没给才验插件包。
    if (dirIdx >= 0) {
      if (!existsSync(dir)) {
        console.error(`✗ 库不存在：${dir}`)
        process.exit(1)
      }
      const chain = chainReport(dir)
      if (flags.has('--json')) console.log(JSON.stringify({ dir, ...chain }, null, 2))
      else {
        console.log(`库：${dir}`)
        console.log(`  档案 ${chain.checked} 个文件 · 链${chain.ok ? '完整' : '有问题'}`)
        for (const p of chain.problems.slice(0, 5)) console.error(`  ✗ ${p}`)
      }
      process.exit(chain.ok ? 0 : 1)
    }
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
  case 'refute':
    cmdRefute()
    break
  case 'evidence':
    cmdEvidence()
    break
  case 'tidy':
    cmdTidy()
    break
  case 'backup':
    cmdBackup()
    break
  case 'today':
    cmdToday()
    break
  case 'voice-metrics':
    cmdVoiceMetrics()
    break
  case 'scope':
    cmdScope()
    break
  case 'handoff':
    cmdHandoff()
    break
  case 'merge-check':
    cmdMergeCheck(params[0])
    break
  case 'report':
    cmdReport()
    break
  case 'config':
    cmdConfig(params[0], params.slice(1))
    break
  case 'es':
    cmdEs(params[0], params[1])
    break
  case 'ws':
    cmdWs(params[0], params[1])
    break
  case 'find':
    cmdFind(params[0])
    break
  case 'read':
    cmdRead(params[0])
    break
  case 'tamper':
    cmdTamper()
    break
  case 'entity':
    cmdEntity(params[0], params.slice(1))
    break
  case 'fields':
    cmdFields()
    break
  case 'walls':
    cmdWalls()
    break
  case 'near-miss':
    cmdNearMiss()
    break
  case 'timeline':
    cmdTimeline()
    break
  case 'sleep':
    cmdSleep()
    break
  case 'emotion':
    cmdEmotion('show', [])
    break
  case 'feel':
    cmdEmotion('feel', params)
    break
  case 'behavior':
    cmdBehavior()
    break
  case 'were':
    cmdWere()
    break
  case 'habit':
    cmdHabit(params[0], params[1])
    break
  case 'cliche':
    cmdCliche(params[0], params.slice(1))
    break
  case 'alias':
    cmdAlias(params[0], params.slice(1))
    break
  case 'presence':
    cmdPresence()
    break
  case 'snapshot':
    cmdSnapshot(params[0])
    break
  case 'voice':
    cmdVoice(params[0], params[1])
    break
  case 'redact':
    cmdRedact()
    break
  case 'dormant':
    cmdDormant(params[0], params[1])
    break
  case 'question':
    cmdQuestion(params[0], params[1])
    break
  case 'soul':
    cmdSoul(params[0], params[1])
    break
  case 'stats':
    cmdStats()
    break
  case 'book':
  case 'asset':
    cmdBook(params[0], params[1])
    break
  case 'wakeup':
    cmdWakeup()
    break
  case 'tokens':
    cmdTokens()
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
