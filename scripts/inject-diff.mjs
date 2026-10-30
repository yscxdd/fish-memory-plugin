#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * inject-diff.mjs — "她这一轮会读到什么"的改前/改后对比。
 *
 * 为什么要有：插件是她的**读出器**。改阈值、权重、预算、注入顺序、模式分流
 * 都不会改档案一个字节，但会改"她此刻读到什么"。这种改动没有日志会告发，
 * 而且最容易出的事故是——你以为只是调了个数，结果某个核心层段落被裁掉了
 * （实测：`budget.core` 700 → 250，`rules.md` 那 213 tok 硬规则整段消失）。
 *
 * 两次调用，中间随便你改什么（代码、默认值、配置）：
 *
 *   node scripts/inject-diff.mjs --capture            # 记下"现在她读到什么"
 *   ...改...
 *   node scripts/inject-diff.mjs --compare            # 逐问对比，指出变了哪一段
 *
 * 只比配置时不必改代码：`--compare --config try.json`（try.json 只写要覆盖的键，
 * 例如 `{"inject":{"core":250}}`），基线里存的是当时的完整配置。
 *
 * ## 它覆盖什么、不覆盖什么（重要）
 *
 * 覆盖：核心层装配（含裁剪 dropped）、检索选点（threshold/权重/门控/maxEvents）、
 *       正文预算与降级、索引层、能力块（task 模式）、related/ghosts/key 三种附加块。
 * 不覆盖（这些是宿主动态状态，只有重启后才看得到）：
 *   - 自述提醒 / 自述块（`selfDue` 是回合结束时的状态）
 *   - 上下文压力提醒、锚点重注、handoff 块
 *   - 首轮工作记忆（`上次说到`）——它是会话状态，不是参数
 *   - 到期复习那一行（它会写 `markReviewed`，本工具**不写库**，故跳过）
 *
 * 所以：这个工具验的是"装配层"。宿主包装层的唯一验证方式是重启后看真实注入。
 *
 * 全程只读：不写档案、不写记忆点、不写状态。唯一的写是你显式要的基线文件。
 *
 * 用法：
 *   node scripts/inject-diff.mjs --capture [--out .inject-baseline.json] [--label "..."]
 *   node scripts/inject-diff.mjs --compare [--baseline <file>] [--config try.json] [--json]
 *   node scripts/inject-diff.mjs --print   [--config try.json] [--json]     # 只看现在
 *
 * 选项：
 *   --dir <memoryDir>    默认 = 插件目录旁边的 fish-memory/
 *   --mode auto|task|daily   默认 auto（按 detectMode 判）
 *   --now <ISO>          默认今天 12:00（同一天内稳定，避免"时间过去了"造成的假 diff）
 *   --queries <file.json>  覆盖默认的 5 个问题：[{id,q}] 或 ["问题", ...]
 *   --fail-on-diff       有任何差异就退出码 1（给 CI / 脚本用）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../lib/config.js'
import { dormantPoints } from '../lib/inspect.js'
import { detectMode, layoutAbilities, needsRelationshipRecall, rankAbilities, renderTools, scanAbilities } from '../lib/mode.js'
import { DEFAULT_BUDGET, assemble } from '../lib/render.js'
import { bigrams, isGated, pickByEvent, rankHybrid } from '../lib/retrieve.js'
import { MemoryStore } from '../lib/store.js'
import { estTokens } from '../lib/util.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

/** index.js 里那组 retrieval 默认值（改了要同步这里——见文件末尾的自检测试） */
export const RETRIEVAL_DEFAULTS = { threshold: 0.8, recallLimit: 20, maxEvents: 3, idf: false, idfMode: 'min' }

/** 默认问题组：闲聊 / 回忆 / 工作 / 边界 / 空输入 */
export const DEFAULT_QUERIES = [
  { id: 'chat', q: '今天有点累' },
  { id: 'recall', q: '上次台风那天我们去了哪' },
  { id: 'work', q: '帮我改一下 lib/self.js，然后跑测试' },
  { id: 'bound', q: '你觉得我应该辞职吗' },
  { id: 'empty', q: '' },
]

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : d
}
const dir = resolve(val('--dir', join(pkgRoot, '..', 'fish-memory')))
const asJson = has('--json')
const modeOpt = val('--mode', 'auto')

/** 今天 12:00（本地）——同一天内多次 capture/compare 不受"时间流逝"影响 */
function defaultNow() {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d
}

/**
 * 读 JSON，顺手剥掉 BOM。
 *
 * 为什么：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 直接炸。
 * 这坑在这个项目里已经踩过三次（`verify` 的 BOM 检查就是为它加的），
 * 让工具自己扛住，比让用户去猜"我的 json 怎么了"好。
 */
function readJson(file) {
  const p = resolve(file)
  let raw = readFileSync(p, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`${p} 不是合法 JSON：${e.message}（若用 PowerShell 写过，可能带了 BOM——已尝试剥掉，仍失败就是内容问题）`)
  }
}

function loadConfig() {
  const cfgFile = val('--config', '')
  const raw = cfgFile ? readJson(cfgFile) : {}
  const cfg = normalizeConfig(raw)
  return {
    cfg,
    raw,
    budget: { ...DEFAULT_BUDGET, ...(cfg.inject || {}) },
    retrieval: { ...RETRIEVAL_DEFAULTS, ...(cfg.retrieval || {}) },
  }
}

function loadQueries() {
  const f = val('--queries', '')
  if (!f) return DEFAULT_QUERIES
  const raw = readJson(f)
  return raw.map((x, i) => (typeof x === 'string' ? { id: `q${i + 1}`, q: x } : { id: x.id || `q${i + 1}`, q: String(x.q ?? '') }))
}

/**
 * 复刻 `lib/index.js` 的注入装配（取点 → assemble），不含宿主动态块。
 * 这段是刻意复刻的：index.js 的注入在宿主回调里，没法直接调。
 * 改 `index.js` 的取点逻辑时**要回来同步这里**，否则这个工具会开始撒谎。
 */
export function renderProbe({ store, dir: memDir, query, mode = 'auto', budget = DEFAULT_BUDGET, retrieval = RETRIEVAL_DEFAULTS, now = defaultNow() } = {}) {
  const detected = mode === 'auto' ? detectMode(query).mode : mode
  const task = detected === 'task'
  const points = store.indexPoints()

  let picked = []
  const recall = !task || needsRelationshipRecall(query)
  if (recall && !isGated(query)) {
    const cand = store.candidates(query)
    let pool = points
    if (cand) {
      const m = new Map(points.map((p) => [p.id, p]))
      pool = cand.map((id) => m.get(id)).filter(Boolean)
    }
    picked = pickByEvent(
      rankHybrid(pool, query, {
        threshold: retrieval.threshold,
        limit: retrieval.recallLimit,
        weight: (p) => store.memoryWeight(p),
        weights: retrieval.weights,
        rebalance: retrieval.rebalance !== false,
        idf: retrieval.idf ? store.idf() : undefined,
        idfMode: retrieval.idfMode || 'min',
      }),
      retrieval.maxEvents,
    )
    picked = picked.map((p) => store.fullPoint(p)).filter(Boolean)
  }

  // 场景展开：同 event 的其它点 + 沿 links 一跳（≤3 条）——与 index.js:736-748 一致
  const pickedIds = new Set(picked.map((p) => p.id))
  const byId = new Map(points.map((p) => [p.id, p]))
  const related = []
  const addRelated = (q) => {
    if (!q || pickedIds.has(q.id) || related.some((r) => r.id === q.id)) return
    related.push(q)
  }
  for (const p of picked) {
    if (p.event) for (const q of points) if (q.event === p.event) addRelated(q)
    for (const l of p.links || []) addRelated(byId.get(l))
  }

  // 能力块（task 模式）
  let ability = ''
  let abilityIds = []
  if (task) {
    const cand = rankAbilities(scanAbilities(memDir), query)
    const laid = layoutAbilities(cand, 2400)
    const tools = renderTools(memDir)
    const inner = [tools, laid.text].filter(Boolean).join('\n\n')
    abilityIds = laid.picked || []
    if (inner) {
      ability = ['<!-- 你会做的事 -->', '以下是你会的事。用之前先确认前提条件，不适用就直说。', inner, '<!-- /你会做的事 -->'].join('\n\n')
    }
  }

  const keyPoints = points
    .filter((p) => p.key)
    .slice(0, 3)
    .map((p) => store.fullPoint(p))
    .filter(Boolean)
  const ghosts = dormantPoints(memDir).slice(0, 5)

  const result = assemble({
    store,
    query,
    sessionId: '', // 空 = 不装首轮工作记忆（会话状态，不是参数）
    now,
    budget,
    mode: task ? 'task' : 'daily',
    ability,
    keyPoints,
    ghosts,
    related: related.slice(0, 3),
    retrieve: () => picked,
  })

  return {
    id: '',
    q: query,
    mode: task ? 'task' : 'daily',
    detected: mode === 'auto' ? detectMode(query).reasons : ['(强制)'],
    tokens: estTokens(result.text),
    chars: result.text.length,
    text: result.text,
    rendered: result.rendered || [],
    dropped: result.dropped || [],
    coreDropped: result.coreDropped || [],
    ability: abilityIds,
  }
}

/**
 * 库里遗留的 `_samples/`（**v0.13.3 起不再参与检索**）。
 *
 * 历史：`MemoryStore.points()` 以前同时扫 `30_points/` 和 `_samples/`，于是空库里
 * 她"检索到"的其实是演示素材——2026-10-30 20:17 那轮真实注入过 `M-2026-10-28-001`
 * （台风天看海，`source: [msg-sample-*]`，档案里没有这条消息）。那不是她的记忆。
 * 现在演示素材在插件仓的 `samples/`；库里若还有旧目录，工具仍会提醒（但不该被读到了）。
 */
function sampleIds(memDir) {
  const d = join(memDir, '_samples')
  if (!existsSync(d)) return []
  try {
    return readdirSync(d)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

/** 拍一份基线：当前代码 + 当前配置，跑完全部问题 */
export function capture({ dir: memDir, queries, config, mode = 'auto', now = defaultNow() } = {}) {
  const store = new MemoryStore(memDir)
  const qs = queries || DEFAULT_QUERIES
  const samples = sampleIds(memDir)
  const results = qs.map((x) => {
    const r = renderProbe({ store, dir: memDir, query: x.q, mode, budget: config.budget, retrieval: config.retrieval, now })
    return { ...r, id: x.id, sampleHits: (r.rendered || []).filter((id) => samples.includes(id)) }
  })
  const sampleUsed = [...new Set(results.flatMap((r) => r.sampleHits))]
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version
    } catch {
      return 'unknown'
    }
  })()
  return {
    at: new Date().toISOString(),
    plugin: pkg,
    dir: memDir,
    mode,
    config: { inject: config.budget, retrieval: config.retrieval, raw: config.raw },
    samples: { available: samples.length, used: sampleUsed },
    queries: results,
  }
}

/** 把正文切成段落（按空行），用来做"哪一段变了"的分类 */
function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function sections(text) {
  return paragraphs(text)
    .filter((p) => /^#{1,6}\s/.test(p))
    .map((p) => p.split('\n')[0])
}

/** 段落级 diff：消失 / 新增 / 顺序变化 */
export function diffText(before, after) {
  const b = paragraphs(before)
  const a = paragraphs(after)
  const cnt = (arr) => {
    const m = new Map()
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1)
    return m
  }
  const cb = cnt(b)
  const ca = cnt(a)
  const removed = []
  const added = []
  for (const [x, n] of cb) {
    const m = ca.get(x) || 0
    if (n > m) removed.push(x)
  }
  for (const [x, n] of ca) {
    const m = cb.get(x) || 0
    if (n > m) added.push(x)
  }
  const sb = sections(before)
  const sa = sections(after)
  return {
    changed: before !== after,
    tokenDelta: estTokens(after) - estTokens(before),
    paragraphs: { before: b.length, after: a.length },
    removed,
    added,
    sectionsRemoved: sb.filter((s) => !sa.includes(s)),
    sectionsAdded: sa.filter((s) => !sb.includes(s)),
  }
}

/** 逐问对比基线 vs 现在 */
export function diffQueries(baseline, current) {
  const byId = new Map(current.queries.map((q) => [q.id, q]))
  return baseline.queries.map((bq) => {
    const aq = byId.get(bq.id) || null
    if (!aq) return { id: bq.id, q: bq.q, missing: true }
    return {
      id: bq.id,
      q: bq.q,
      mode: aq.mode,
      before: { tokens: bq.tokens, rendered: bq.rendered.length, coreDropped: bq.coreDropped, dropped: bq.dropped },
      after: { tokens: aq.tokens, rendered: aq.rendered.length, coreDropped: aq.coreDropped, dropped: aq.dropped },
      ...diffText(bq.text, aq.text),
      coreDroppedNew: aq.coreDropped.filter((x) => !bq.coreDropped.includes(x)),
    }
  })
}

function fmtTok(n) {
  return n > 0 ? `+${n}` : String(n)
}

function short(s, n = 72) {
  const t = String(s).replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function printReport(base, cur, rows) {
  console.log(`基线：${base.at.slice(0, 16).replace('T', ' ')} · v${base.plugin} · mode=${base.mode} · config.core=${base.config.inject.core} thr=${base.config.retrieval.threshold}`)
  console.log(`现在：${cur.at.slice(0, 16).replace('T', ' ')} · v${cur.plugin} · mode=${cur.mode} · config.core=${cur.config.inject.core} thr=${cur.config.retrieval.threshold}`)
  const cfgDiff = []
  for (const k of ['core', 'index', 'body', 'work']) {
    if (base.config.inject[k] !== cur.config.inject[k]) cfgDiff.push(`budget.${k} ${base.config.inject[k]} → ${cur.config.inject[k]}`)
  }
  for (const k of ['threshold', 'recallLimit', 'maxEvents']) {
    if (base.config.retrieval[k] !== cur.config.retrieval[k]) cfgDiff.push(`retrieval.${k} ${base.config.retrieval[k]} → ${cur.config.retrieval[k]}`)
  }
  if (base.plugin !== cur.plugin) cfgDiff.push(`插件版本 ${base.plugin} → ${cur.plugin}`)
  if (cfgDiff.length) console.log(`配置变化：${cfgDiff.join(' · ')}`)
  const samples = cur.samples || { available: 0, used: [] }
  if (samples.available) {
    const used = [...new Set([...(base.samples?.used || []), ...(samples.used || [])])]
    console.log(
      used.length
        ? `⚠ 库里有 ${samples.available} 条 _samples/，本次命中 ${used.length} 条（${used.join(', ')}）——**这不是她的记忆，说明你跑的是 v0.13.3 之前的代码**`
        : `⚠ 库里有 ${samples.available} 条遗留 _samples/（v0.13.3 起不再参与检索）——演示素材在插件仓 samples/，这个目录可以删`,
    )
  }
  console.log('')

  let changed = 0
  let lost = 0
  for (const r of rows) {
    if (r.missing) {
      console.log(`? 「${short(r.q)}」 基线里有、现在没有这个查询——跳过`)
      continue
    }
    const head = `${r.changed ? '✗' : '='} ${r.id.padEnd(6)} 「${short(r.q, 28)}」 ${String(r.mode).padEnd(5)} tok ${r.before.tokens} → ${r.after.tokens} (${fmtTok(r.tokenDelta)})  正文 ${r.before.rendered} → ${r.after.rendered}`
    console.log(head)
    if (!r.changed) continue
    changed += 1
    if (r.coreDroppedNew.length) {
      lost += 1
      console.log(`    ⚠ 核心层被裁：${r.coreDroppedNew.join(', ')} —— 她这一轮读不到这层了`)
    }
    for (const s of r.sectionsRemoved) console.log(`    − 段落消失 ${s}`)
    for (const s of r.sectionsAdded) console.log(`    + 段落新增 ${s}`)
    const plainRemoved = r.removed.filter((p) => !/^#{1,6}\s/.test(p))
    const plainAdded = r.added.filter((p) => !/^#{1,6}\s/.test(p))
    for (const p of plainRemoved.slice(0, 4)) console.log(`    − ${short(p)}`)
    for (const p of plainAdded.slice(0, 4)) console.log(`    + ${short(p)}`)
    const extra = Math.max(0, plainRemoved.length - 4) + Math.max(0, plainAdded.length - 4)
    if (extra) console.log(`    …还有 ${extra} 段（用 --json 看全量）`)
  }
  console.log('')
  console.log(`${rows.length} 个查询：${changed} 个变了${lost ? `，其中 ${lost} 个丢了核心层段落` : ''}`)
  if (!changed) console.log('她读到的文本没变。')
}

// ── CLI ────────────────────────────────────────────────────────

const baselineFile = resolve(val('--baseline', join(process.cwd(), '.inject-baseline.json')))

if (has('--capture')) {
  if (!existsSync(dir)) {
    console.error(`✗ 记忆库不存在：${dir}（用 --dir 指定）`)
    process.exit(1)
  }
  const config = loadConfig()
  const snap = capture({ dir, queries: loadQueries(), config, mode: modeOpt, now: new Date(val('--now', defaultNow().toISOString())) })
  snap.label = val('--label', '')
  const out = resolve(val('--out', baselineFile))
  writeFileSync(out, JSON.stringify(snap, null, 2), 'utf8')
  console.log(`✓ 已拍基线：${out}`)
  console.log(`  v${snap.plugin} · ${snap.queries.length} 个查询 · tok ${snap.queries.map((q) => q.tokens).join(' / ')}`)
  console.log('  改完再跑：node scripts/inject-diff.mjs --compare')
  process.exit(0)
}

if (has('--compare')) {
  if (!existsSync(baselineFile)) {
    console.error(`✗ 没有基线：${baselineFile}`)
    console.error('  先跑 --capture 记下"改前"，或者用 --baseline <旧基线文件> 指定。')
    process.exit(1)
  }
  if (!existsSync(dir)) {
    console.error(`✗ 记忆库不存在：${dir}`)
    process.exit(1)
  }
  const base = readJson(baselineFile)
  const config = loadConfig()
  // 基线里没存 queries 内容时退回默认问题组
  const queries = base.queries.map((q) => ({ id: q.id, q: q.q }))
  const cur = capture({ dir, queries, config, mode: modeOpt, now: new Date(val('--now', defaultNow().toISOString())) })
  const rows = diffQueries(base, cur)
  if (asJson) {
    console.log(JSON.stringify({ baseline: { at: base.at, plugin: base.plugin, config: base.config }, current: { at: cur.at, plugin: cur.plugin, config: cur.config }, rows }, null, 2))
  } else {
    printReport(base, cur, rows)
  }
  const anyDiff = rows.some((r) => r.changed || r.missing)
  process.exit(has('--fail-on-diff') && anyDiff ? 1 : 0)
}

if (has('--print')) {
  if (!existsSync(dir)) {
    console.error(`✗ 记忆库不存在：${dir}`)
    process.exit(1)
  }
  const config = loadConfig()
  const snap = capture({ dir, queries: loadQueries(), config, mode: modeOpt, now: new Date(val('--now', defaultNow().toISOString())) })
  if (asJson) console.log(JSON.stringify(snap, null, 2))
  else {
    console.log(`v${snap.plugin} · mode=${snap.mode} · config.core=${snap.config.inject.core} thr=${snap.config.retrieval.threshold}`)
    for (const q of snap.queries) console.log(`  ${q.id.padEnd(6)} tok=${String(q.tokens).padStart(4)} ${String(q.mode).padEnd(5)} 「${short(q.q, 30)}」`)
    if (snap.samples.available) {
      console.log(
        snap.samples.used.length
          ? `⚠ 命中 ${snap.samples.used.length} 条 _samples/ 演示点（${snap.samples.used.join(', ')}）——不是她的记忆`
          : `⚠ 库里有 ${snap.samples.available} 条 _samples/ 演示点，本次未命中`,
      )
    }
  }
  process.exit(0)
}

console.log(
  [
    'inject-diff — 她这一轮读到什么，改前/改后对比（只读，不写库）',
    '',
    '  node scripts/inject-diff.mjs --capture            记基线（默认 .inject-baseline.json）',
    '  node scripts/inject-diff.mjs --compare            对比：变了哪段、哪层被裁',
    '  node scripts/inject-diff.mjs --print              只看现在，不写文件',
    '',
    '只试参数（不改代码）：--compare --config try.json   try.json 例：{"inject":{"core":250}}',
    '其他：--dir <库>  --mode auto|task|daily  --now <ISO>  --queries <json>  --json  --fail-on-diff',
  ].join('\n'),
)
