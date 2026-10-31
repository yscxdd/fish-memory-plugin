// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * toolkit.js — 记忆库的离线工具：校验 / 提升 / 重建索引 / 审计 / 切段。
 *
 * 这些事都不该进插件（契约 §1.2）：它们不影响"她这一轮能不能说话"。
 * 但它们决定"库里记的东西能不能信"。
 *
 * 用法见 scripts/memory.mjs。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText, extractSum, findSecrets, isInvalidated, localDay, normalizeEmotion, parseFrontMatter, sanitizeForPrompt } from './util.js'
import { checkArchive } from './integrity.js'
import { CORE_DRIFT_LIMIT, coreDrift } from './guard.js'

const POINT_TYPES = new Set([
  'event',
  'preference',
  'boundary',
  'habit',
  'promise',
  'conflict',
  'gap',
  'incarnation',
])
const STATUSES = new Set(['pending', 'active', 'demoted', 'dormant', 'merged', 'suppressed'])
const ANCHORS = ['我最怕被当成"AI"讨论', '我绝不会说"作为一个AI"', '我不会给人生建议']
const SUM_MAX = 55
const QUOTE_MAX = 30

/**
 * 记忆点 front matter 的 schema 版本（G5）。
 *
 * 为什么要有：字段会随着版本增加（`key`、`contradicts`、`fixture` 都是后加的）。
 * 没有版本号的话，将来改格式只能靠"猜这条点是哪一版写的"。
 * 现在：老文件没有 `version` 一律按 1 读；**未来版本的点会被认出来并报错**，
 * 而不是被旧代码按旧格式悄悄读错。
 */
export const POINT_SCHEMA_VERSION = 1

/**
 * 迁移表：`{ from, to, apply }`。目前只有 v1，所以是空的。
 * 加 v2 的时候在这里写一条，`migratePoints()` 就会把旧点升上来。
 */
export const POINT_MIGRATIONS = []

/** 把一条点升到当前 schema 版本（纯函数，返回新对象） */
export function migratePoint(p) {
  let cur = { ...p }
  let ver = Number.isInteger(p.version) ? p.version : POINT_SCHEMA_VERSION
  while (ver < POINT_SCHEMA_VERSION) {
    const step = POINT_MIGRATIONS.find((m) => m.from === ver)
    if (!step) break
    cur = { ...step.apply(cur), version: step.to }
    ver = step.to
  }
  return cur
}

function norm(s) {
  return String(s || '').replace(/\s+/g, '')
}

// ── 读档案 ─────────────────────────────────────────────────────

/** 读全部档案消息，按时间排序；byId 同时索引记录 id 与平台 msgid */
export function readArchive(dir) {
  const base = join(dir, '10_archive', 'messages')
  const messages = []
  if (!existsSync(base)) return { messages, byId: new Map() }
  for (const f of readdirSync(base).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(base, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        /* 坏行跳过，审计里会体现 */
      }
    }
  }
  messages.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.seq || 0) - (b.seq || 0))
  const byId = new Map()
  for (const m of messages) {
    if (m.id) byId.set(m.id, m)
    if (m.msgid_plat) byId.set(m.msgid_plat, m)
  }
  return { messages, byId }
}

// ── 读记忆点 ───────────────────────────────────────────────────

/** 读 30_points（或 40_pending）下的记忆点，保留原文以便原地改 status */
export function scanPointFiles(dir, sub = '30_points') {
  const d = join(dir, sub)
  if (!existsSync(d)) return { points: [], skipped: [] }
  const out = []
  const skipped = []
  for (const f of readdirSync(d).filter((x) => x.endsWith('.md') && !/^TEMPLATE/i.test(x)).sort()) {
    let raw = ''
    try {
      raw = readFileSync(join(d, f), 'utf8')
    } catch (e) {
      skipped.push({ file: f, reason: `读不出来：${e?.message || e}` })
      continue
    }
    // 没有 front matter 的 .md 是说明文件（README 之类），不是记忆点——静默跳过
    if (!/^---\r?\n/.test(raw)) {
      if (!/^README/i.test(f)) skipped.push({ file: f, reason: '没有 front matter，不像记忆点' })
      continue
    }
    const { meta, body } = parseFrontMatter(raw)
    // v0.14.0：**不许静默跳过**。以前这里 `if (!meta.id) continue`，
    // 于是一个 front matter 坏掉/被截断的点会同时从检索和审计里消失——
    // 她的记忆少了一条，而所有闸门还是绿的（mem0 踩过同一个坑：
    // 空响应静默变 []，再也分不清"没有"和"坏了"）。
    if (!meta.id) {
      skipped.push({ file: f, reason: 'front matter 里没有 id（坏了或被截断）' })
      continue
    }
    out.push({
      file: join(d, f),
      filename: f,
      raw,
      id: String(meta.id),
      // G5：老文件没有 version 就当 1（不逼人改历史），但要把实际值记下来
      version: Number.isInteger(Number(meta.version)) && Number(meta.version) > 0 ? Number(meta.version) : undefined,
      title: meta.title || '',
      quote: typeof meta.quote === 'string' ? meta.quote : '',
      quote_by: typeof meta.quote_by === 'string' ? meta.quote_by : null,
      date: meta.date || '',
      // v0.21.0：承诺/事件的"该办日期"（可选，纯加法；老点没有就是 null）
      due: typeof meta.due === 'string' && meta.due ? meta.due : null,
      salience: Number(meta.salience || 0),
      type: meta.type || 'event',
      cluster: meta.cluster || '',
      event: meta.event || null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      status: meta.status || 'active',
      merged_into: typeof meta.merged_into === 'string' ? meta.merged_into : null,
      fixture: meta.fixture === true,
      segment: typeof meta.segment === 'string' ? meta.segment : null,
      key: meta.key === true,
      contradicts: Array.isArray(meta.contradicts) ? meta.contradicts : [],
      // v0.14.0：事实失效（不是删除）。没写 = 仍然成立，老点不用迁移。
      invalid_at: typeof meta.invalid_at === 'string' ? meta.invalid_at : null,
      invalid_reason: typeof meta.invalid_reason === 'string' ? meta.invalid_reason : null,
      // v0.18.0：情绪（总设计 §5.2 第 11 项）。只解析，量程留到 validatePoint 报错
      emotion: normalizeEmotion(meta.emotion, meta),
      source: Array.isArray(meta.source) ? meta.source : [],
      links: Array.isArray(meta.links) ? meta.links : [],
      summary: extractSum(body),
    })
  }
  return { points: out, skipped }
}

export function readPointFiles(dir, sub = '30_points') {
  return scanPointFiles(dir, sub).points
}

// ── 校验 ───────────────────────────────────────────────────────

/**
 * 校验一条记忆点。
 * @returns {{errors: {field:string,message:string}[], warnings: ...}}
 *
 * 硬错误（errors）= 会破坏溯源或语义；
 * 软警告（warnings）= 历史样例、字段不规范，但可以保留。
 */
export function validatePoint(p, { archive, points = [], allowSample = true } = {}) {
  const errors = []
  const warnings = []
  const err = (field, message) => errors.push({ field, message })
  const warn = (field, message) => warnings.push({ field, message })

  if (!/^M-\d{4}-\d{2}-\d{2}-\d{3}$/.test(p.id)) err('id', `ID 不合格式：${p.id}`)
  if (!p.title) err('title', '缺少 title')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) err('date', `date 不合格式：${p.date}`)
  else if (!/^M-(\d{4}-\d{2}-\d{2})-/.test(p.id) || !p.id.includes(p.date)) warn('date', 'ID 里的日期与 date 不一致')
  // v0.21.0：due 是"该办日期"（可选）。承诺/事件到期会进注入的"该办了"一行。
  if (p.due != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.due)) err('due', `due 不合格式（要 YYYY-MM-DD）：${p.due}`)
    else if (Date.parse(p.due) < Date.parse(p.date)) warn('due', `due（${p.due}）早于 date（${p.date}）：是不是写反了？`)
    else if (p.type !== 'promise' && p.type !== 'event') warn('due', `due 只对 promise / event 有意义，当前 type=${p.type}`)
  }
  if (!Number.isInteger(p.salience) || p.salience < 1 || p.salience > 5) err('salience', `salience 必须是 1–5：${p.salience}`)
  if (!POINT_TYPES.has(p.type)) err('type', `未知 type：${p.type}`)
  if (!STATUSES.has(p.status)) err('status', `未知 status：${p.status}`)
  if (!p.cluster) warn('cluster', '缺少 cluster')
  if (p.event && !/^E-\d{8}-\d{2}$/.test(p.event)) err('event', `event 不合格式：${p.event}`)

  // 情绪字段（总设计 §5.2 第 11 项；v0.18.0）。
  // **不 clamp**：写错就报错，别把她把情绪写成 3.0 还当没事。
  if (p.emotion) {
    for (const side of ['self', 'user']) {
      const e = p.emotion[side]
      if (e == null) continue
      if (typeof e !== 'object') {
        err('emotion', `emotion.${side} 必须是对象`)
        continue
      }
      if (e.valence != null && !(Number(e.valence) >= -1 && Number(e.valence) <= 1)) {
        err('emotion', `emotion.${side}.valence 必须在 [-1,1]：${e.valence}`)
      }
      if (e.arousal != null && !(Number(e.arousal) >= 0 && Number(e.arousal) <= 1)) {
        err('emotion', `emotion.${side}.arousal 必须在 [0,1]：${e.arousal}`)
      }
      if (e.label != null && String(e.label).length > 12) {
        err('emotion', `emotion.${side}.label 太长（≤12 字）：${e.label}`)
      }
    }
    // 审计清单 #12：只有旁白情绪时，遗忘不会因它变牢——提醒人补 user 侧，而不是假装生效
    if (p.emotion.self && !p.emotion.user) {
      warn('emotion', '只写了 self（她的旁白）：遗忘权重只采信 user 侧，这条不会因情绪而更牢')
    }
  }

  // G5：schema 版本。没有（或写 null）就按 1 读（不逼人改历史），但**来自更新版本的点必须报错**，
  // 否则旧代码会按旧格式悄悄读错字段。
  const schemaVersion = p.version === null ? undefined : p.version
  if (schemaVersion !== undefined) {
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) err('version', `version 必须是正整数：${JSON.stringify(p.version)}`)
    else if (schemaVersion > POINT_SCHEMA_VERSION) {
      err('version', `这条点来自更新的插件（schema v${schemaVersion} > 本插件 v${POINT_SCHEMA_VERSION}），先升级插件再处理`)
    }
  }

  if (!p.summary) err('summary', '缺少 SUM 块')
  else if (p.summary.length > SUM_MAX) err('summary', `SUM ${p.summary.length} 字 > ${SUM_MAX}`)

  if (p.quote) {
      if (p.quote.length > QUOTE_MAX) err('quote', `QUOTE ${p.quote.length} 字 > ${QUOTE_MAX}`)
    if (!p.quote_by) warn('quote_by', '缺少 quote_by（判不出归属就写 null）')
  }

  if (!p.source.length) err('source', '缺少 source（无法溯源）')
  const resolved = []
  for (const sid of p.source) {
    if (sid.startsWith('msg-sample-')) {
      if (allowSample) warn('source', `样例来源：${sid}`)
      else err('source', `样例来源：${sid}`)
      continue
    }
    const m = archive?.byId?.get(sid)
    if (!m) err('source', `档案里找不到：${sid}`)
    else resolved.push(m)
  }

  // 原话逐字：必须能在来源消息里原样找到（允许标点/空白差异）
  if (p.quote && resolved.length) {
    const hay = resolved.map((m) => norm(m.text)).join('\u0000')
    if (!hay.includes(norm(p.quote))) err('quote', `原话在来源消息里找不到：${p.quote}`)
  }

  const ids = new Set(points.map((x) => x.id))
  for (const l of p.links) if (!ids.has(l)) warn('links', `链接指向不存在的点：${l}`)
  // 冲突必须显式指向一个真实存在的点；不自动裁决，只逼人看见
  for (const c of p.contradicts || []) if (!ids.has(c)) err('contradicts', `冲突指向不存在的点：${c}`)
  // v0.14.0：草稿带冲突引用 → promote 前提醒人看两边（不自动裁决，也不拦）
  if (p.status === 'pending' && (p.contradicts || []).length) {
    warn('contradicts', `草稿标了 ${p.contradicts.length} 条冲突：promote 前先人看一遍两边，别直接覆盖旧说法`)
  }

  // v0.14.0：事实失效标记（不是删除）。两条硬规则来自 graphiti：
  // ① boundary/promise 永不失效（"承诺到期"≠"承诺没说过"，soft deadlines are not invalid_at）
  // ② 没写一律当仍有效（老点不迁移）
  if (p.invalid_at != null) {
    if (!Number.isFinite(Date.parse(String(p.invalid_at)))) err('invalid_at', `invalid_at 不是合法时间：${p.invalid_at}`)
    if (p.type === 'boundary' || p.type === 'promise') {
      err('invalid_at', `${p.type} 不许写 invalid_at：承诺/底线到期不等于没说过（soft deadlines are not invalid_at）`)
    }
    if (p.status !== 'active') warn('invalid_at', `点已不是 active（${p.status}），invalid_at 只在 active 点上有意义`)
  }

  // v0.7.0：疑似密钥/隐私落在记忆点里 → **告警，不静默改写**（磁盘保原文，出口打码）。
  // 为什么告警而不是报错：逐字原话里出现 11 位数字可能只是订单号；逼人看一眼，比机器猜好。
  const secretFields = [
    ['quote', p.quote],
    ['summary', p.summary],
    ['facts', p.facts],
    ['thoughts', p.thoughts],
  ]
  for (const [field, value] of secretFields) {
    const hits = findSecrets(value)
    if (hits.length) warn(field, `疑似密钥/隐私（${hits.join('、')}）：注入时会打码，但磁盘上是原文`)
  }
  if (findSecrets(p.title).length) warn('title', '标题里有疑似密钥/隐私，它会进索引与注入')

  // G6：跟已有的点太像 → 告警（**不自动合并**：同一件事分两条只有人看得懂）
  const similar = similarPoints(p, points)
  if (similar.length) {
    warn(
      'similar',
      `和这些点很像：${similar.map((s) => `${s.id}(${s.score})`).join('、')}——如果是同一件事，考虑合并；不是就别管`,
    )
  }

  return { errors, warnings }
}

/**
 * 相似度：标题+摘要的二字组 Jaccard。**只用来提醒，不用来裁决。**
 *
 * 阈值 0.6 是拍的：金标里同一件事的两种写法通常在 0.6–0.9，不同事通常 <0.3。
 * 宁可偶尔多提醒一句，也不要悄悄把两条合并掉。
 *
 * @param {{title?:string, summary?:string, id?:string}} point
 * @param {object[]} points 已有的点
 * @param {{threshold?:number}} [opts]
 * @returns {{id:string, score:number}[]}
 */
export function similarPoints(point, points = [], { threshold = 0.6 } = {}) {
  const grams = (x) => {
    const t = norm(`${x.title || ''}${x.summary || ''}`)
    const out = new Set()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    if (t.length === 1) out.add(t)
    return out
  }
  const mine = grams(point)
  if (mine.size < 4) return [] // 太短的两个标题本来就容易"很像"，不提醒
  const out = []
  for (const other of points) {
    if (!other?.id || other.id === point.id) continue
    const theirs = grams(other)
    if (!theirs.size) continue
    let hit = 0
    for (const g of mine) if (theirs.has(g)) hit++
    const score = hit / (mine.size + theirs.size - hit)
    if (score >= threshold) out.push({ id: other.id, score: Number(score.toFixed(2)) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

// ── 索引重建 ───────────────────────────────────────────────────

export function idxLine(p) {
  return [p.id, p.title, p.date, p.salience, p.type, p.cluster, p.tags.join(','), p.status].join('|')
}

export function sumLine(p) {
  return [p.id, p.summary].join('|')
}

/**
 * 从记忆点生成派生索引（纯函数，可重放）。
 * @param {object[]} points
 * @param {{now?:Date, recentDays?:number, recentCap?:number, clusterCap?:number}} opts
 */
export function buildIndex(points, { now = new Date(), recentDays = 14, recentCap = 25, clusterCap = 8 } = {}) {
  // 与注入同一个判据：只有 active 进索引
  const live = points.filter((p) => p.status === 'active')
  const idx = live.map(idxLine)
  const sum = live.map(sumLine)

  const since = new Date(now.getTime() - recentDays * 86_400_000).toISOString().slice(0, 10)
  const recent = live
    .filter((p) => p.date >= since)
    .sort((a, b) => b.salience - a.salience || String(b.date).localeCompare(String(a.date)) || a.id.localeCompare(b.id))
    .slice(0, recentCap)
    .map(idxLine)

  const byCluster = new Map()
  for (const p of live) {
    const key = p.cluster || '未分类'
    const cur = byCluster.get(key) || { count: 0, latest: '' }
    cur.count += 1
    if (String(p.date) > cur.latest) cur.latest = p.date
    byCluster.set(key, cur)
  }
  const rows = [...byCluster.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, clusterCap)
    .map(([name, v]) => `| ${name} | - | ${v.count} | ${v.latest || '—'} |`)

  const clusters = [
    '# 主题簇索引（一级）',
    '',
    '> 由 `memory index` 重建，不要手改。一级簇 ≤8 个。',
    '',
    '| 簇 | 二级数 | 点数 | 最近 |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')

  return {
    'all.idx.jsonl': idx.length ? idx.join('\n') + '\n' : '',
    'all.sum.jsonl': sum.length ? sum.join('\n') + '\n' : '',
    'recent.idx.jsonl': recent.length ? recent.join('\n') + '\n' : '',
    'clusters.md': clusters,
  }
}

/** 比对现有索引与重建结果，返回差异文件列表 */
export function diffIndex(dir, built) {
  const out = []
  for (const [name, content] of Object.entries(built)) {
    const p = join(dir, '20_index', name)
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : null
    if (cur !== content) out.push(name)
  }
  return out
}

export function writeIndex(dir, built) {
  for (const [name, content] of Object.entries(built)) {
    atomicWriteText(join(dir, '20_index', name), content)
  }
}

// ── 审计 ───────────────────────────────────────────────────────

/**
 * 八项里可脚本化的部分（契约 §10 / §12）。返回可直接 JSON 化的报告。
 */
export function audit(dir, { now = new Date(), sample = 20 } = {}) {
  // v0.14.0：用 scanPointFiles，顺手把"读不出来的点"收集起来（以前静默跳过）
  const scanPoints = scanPointFiles(dir, '30_points')
  const scanPending = scanPointFiles(dir, '40_pending')
  const points = scanPoints.points
  const pending = scanPending.points
  const unreadable = [...scanPoints.skipped.map((s) => ({ ...s, dir: '30_points' })), ...scanPending.skipped.map((s) => ({ ...s, dir: '40_pending' }))]
  const archive = readArchive(dir)
  const built = buildIndex(points, { now })
  const diff = diffIndex(dir, built)

  const samplePoints = points.slice(0, sample)
  const trace = { sampled: samplePoints.length, passed: 0, threshold: Math.ceil(samplePoints.length * 0.9) }
  const provenance = { sampled: 0, violations: 0 }

  for (const p of samplePoints) {
    const sourceOk = p.source.length > 0 && p.source.every((s) => archive.byId.has(s) || s.startsWith('msg-sample-'))
    if (sourceOk) trace.passed += 1
    if (p.quote && p.source.length) {
      provenance.sampled += 1
      const hay = p.source.map((s) => archive.byId.get(s)).filter(Boolean).map((m) => norm(m.text)).join('\u0000')
      if (hay && !hay.includes(norm(p.quote))) provenance.violations += 1
    }
  }

  const byEvent = new Map()
  for (const p of points) {
    if (!p.event) continue
    const dates = byEvent.get(p.event) || new Set()
    dates.add(p.date)
    byEvent.set(p.event, dates)
  }
  const badEvents = [...byEvent.entries()].filter(([, d]) => d.size > 1).map(([e]) => e)

  const soul = existsSync(join(dir, '00_core', 'soul.md')) ? readFileSync(join(dir, '00_core', 'soul.md'), 'utf8') : ''
  const anchorsFound = ANCHORS.filter((a) => soul.includes(a)).length

  const links = points.flatMap((p) => p.links.map((l) => ({ from: p.id, to: l })))
  const ids = new Set(points.map((p) => p.id))
  const orphans = links.filter((l) => !ids.has(l.to))

  const validation = [...points, ...pending].map((p) => ({ id: p.id, ...validatePoint(p, { archive, points }) }))
  const invalid = validation.filter((v) => v.errors.length)

  // 灵魂保护：7 天内核心层改动条数（读 core_changelog.md 的日期前缀）
  const changelog = existsSync(join(dir, '00_core', 'core_changelog.md'))
    ? readFileSync(join(dir, '00_core', 'core_changelog.md'), 'utf8')
    : ''
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const changes7d = changelog
    .split(/\r?\n/)
    .map((l) => l.match(/^(\d{4}-\d{2}-\d{2})\s*\|/))
    .filter((m) => m && m[1] >= weekAgo).length

  const active = points.filter((p) => p.status === 'active')
  const fixtures = points.filter((p) => p.fixture)

  // v0.14.0：未解决的冲突（两边都 active 且都还成立）。
  // 只报告、不裁决——我们的立场是"让矛盾可见"，不是替她选一边
  // （graphiti 也是分 duplicate/contradicted 两个动作，且要"explicit evidence"才判失效）。
  const byIdAll = new Map(points.map((p) => [p.id, p]))
  const openConflicts = []
  for (const p of active) {
    if (isInvalidated(p, now)) continue
    for (const c of p.contradicts || []) {
      const q = byIdAll.get(c)
      if (!q || q.status !== 'active' || isInvalidated(q, now)) continue
      const key = [p.id, q.id].sort().join(' <-> ')
      if (!openConflicts.some((x) => x.key === key)) openConflicts.push({ key, a: p.id, b: q.id })
    }
  }
  const invalidatedCount = points.filter((p) => p.invalid_at && isInvalidated(p, now)).length

  // v0.7.0：注入面体检——密钥/隐私、以及能伪造块边界的注释标记。
  // 磁盘保原文，所以这里不是"删掉"，而是"让你知道它在那儿"。
  const secretPointIds = points
    .filter((p) => findSecrets(`${p.title || ''} ${p.summary || ''} ${p.quote || ''} ${p.facts || ''}`).length)
    .map((p) => p.id)
  const coreFiles = ['soul.md', 'user.md', 'relation.md', 'rules.md'].filter((f) =>
    existsSync(join(dir, '00_core', f)),
  )
  const secretCoreFiles = coreFiles.filter((f) => {
    try {
      return findSecrets(readFileSync(join(dir, '00_core', f), 'utf8')).length > 0
    } catch {
      return false
    }
  })
  const forgingFiles = []
  for (const f of coreFiles) {
    try {
      if (readFileSync(join(dir, '00_core', f), 'utf8').includes('<!-- /记忆 -->')) forgingFiles.push(f)
    } catch {
      /* ignore: 读不到就当没有伪造（保守方向） */
    }
  }
  const secretsTotal = secretPointIds.length + secretCoreFiles.length

  const checks = [
    { id: 'traceable', ...trace, ok: trace.sampled === 0 || trace.passed >= trace.threshold },
    { id: 'rebuild', ok: diff.length === 0, diff: diff.length ? diff.join(',') : 'none' },
    { id: 'provenance', ...provenance, ok: provenance.violations === 0 },
    { id: 'event_cluster', ok: badEvents.length === 0, bad: badEvents },
    { id: 'canary', ok: anchorsFound === 3, anchors_recognized: anchorsFound },
    { id: 'soul_guard', ok: changes7d <= 2, changes_7d: changes7d },
    { id: 'salience_dual', ok: points.some((p) => p.salience >= 5) && points.some((p) => p.salience <= 2) },
    { id: 'orphans', ok: orphans.length === 0, count: orphans.length },
    {
      id: 'points',
      ok: true,
      active: active.length,
      merged: points.filter((p) => p.status === 'merged').length,
      pending: pending.length,
      invalidated: invalidatedCount,
    },
    // v0.14.0：读不出来的点 = 她的记忆少了一条。以前静默跳过，现在必须报出来
    // （非阻塞：半成品文件不该让整个审计红，但 `memory check` 会硬失败）
    {
      id: 'unreadable',
      ok: unreadable.length === 0,
      files: unreadable.map((u) => `${u.dir}/${u.file}`),
      detail: unreadable.map((u) => `${u.dir}/${u.file}: ${u.reason}`),
      note: '读不出来的点等于记忆丢了；修好了再跑一次',
    },
    // v0.14.0：未解决的冲突只报告，不裁决
    { id: 'open_conflicts', ok: true, open: openConflicts.length, pairs: openConflicts.map((c) => `${c.a} <-> ${c.b}`) },
    { id: 'fixtures', ok: true, count: fixtures.length, clear_with: 'memory reset --fix' },
    { id: 'key', ok: true, count: points.filter((p) => p.key).length },
    {
      id: 'contradicts',
      ok: points.every((p) => (p.contradicts || []).every((c) => ids.has(c))),
      edges: points.reduce((n, p) => n + (p.contradicts || []).length, 0),
    },
    { id: 'invalid', ok: invalid.length === 0, count: invalid.length, items: invalid.map((v) => v.id) },
    {
      id: 'secrets',
      ok: secretsTotal === 0,
      points: secretPointIds,
      core: secretCoreFiles,
      note: '磁盘保留原文；注入与回查时会打码。这里只是提醒你别让它留在库里',
    },
    { id: 'delimiter', ok: forgingFiles.length === 0, core: forgingFiles, note: '核心层里出现了 <!-- /记忆 -->，会伪造注入块边界' },
    {
      // v0.8.0：全库档案完整性（verifyLatest 只看最后一个文件）
      id: 'archive_integrity',
      ...(() => {
        try {
          const r = checkArchive(dir, { persist: false })
          return {
            ok: r.ok,
            files: r.checked,
            changed: r.changed,
            missing: r.missing,
            broken: r.broken,
            sampled: r.sampled,
            note: r.sampled ? '已抽样（档案超过 16MB，只验每文件首尾）' : '已逐条验链',
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      })(),
    },
    // 核心层改动幅度（契约 §7.5：单次 ≤20% 字数，超了拒绝）。
    // v0.20.2 之前这条只有文档、没有代码——改 soul.md 全靠自觉。
    {
      id: 'core_drift',
      ...(() => {
        try {
          const rows = coreDrift(dir)
          const over = rows.filter((r) => r.ratio != null && r.ratio > CORE_DRIFT_LIMIT)
          const noSnap = rows.filter((r) => r.ratio == null)
          return {
            ok: over.length === 0,
            limit: `${Math.round(CORE_DRIFT_LIMIT * 100)}%`,
            over: over.map((r) => ({ file: r.file, 改动: `${Math.round(r.ratio * 1000) / 10}%`, 快照: r.snapshot })),
            unchecked: noSnap.map((r) => r.file),
            note: noSnap.length ? '没有快照的文件无法比对（不算违规，但也没被保护）' : '逐文件比对过最新快照',
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      })(),
    },
    // 重复消息（v0.20.2）：去重键是「每会话 seq」，不是 msgid_plat。
    // 所以换 seq 重投会进两行——**不丢数据**（宁可重，不可丢），但必须让人看见。
    // 这条检查就是"让不变量 #3 的实况见光"，见契约 §11 #3 的注释。
    {
      id: 'duplicate_msgid',
      ...(() => {
        const seen = new Map()
        for (const m of archive.messages) {
          const plat = m.msgid_plat || m.id
          if (!plat) continue
          seen.set(plat, (seen.get(plat) || 0) + 1)
        }
        const duplicates = [...seen.entries()]
          .filter(([, n]) => n > 1)
          .map(([plat, count]) => ({ plat, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
        return {
          ok: duplicates.length === 0,
          checked: seen.size,
          duplicates,
          note: '按每会话 seq 去重；同一 msgid_plat 出现多次说明宿主重投过（不丢数据，但会重复计数）',
        }
      })(),
    },
  ]

  // 会阻塞的检查：数据可信度 + 人格锚点 + 核心层改太快/改太多
  // 不阻塞的：points / fixtures / salience_dual / orphans / duplicate_msgid（数据形状，不是坏了）
  const blocking = new Set(['traceable', 'rebuild', 'provenance', 'event_cluster', 'canary', 'soul_guard', 'invalid', 'core_drift'])
  return {
    version: 1,
    ran_at: now.toISOString(),
    memory_dir: dir,
    passed: checks.every((c) => !blocking.has(c.id) || c.ok),
    checks,
  }
}

/**
 * 列出所有标了 fixture 的记忆点，以及 40_pending/_segments 下的压缩包。
 * fixture 是「测试素材」标记：预备清空，不算真实记忆。
 */
export function listFixtures(dir) {
  const out = []
  for (const sub of ['30_points', '40_pending']) {
    for (const p of readPointFiles(dir, sub)) {
      if (p.fixture) out.push({ path: p.file, id: p.id, kind: sub })
    }
  }
  const segDir = join(dir, '40_pending', '_segments')
  if (existsSync(segDir)) {
    for (const f of readdirSync(segDir).filter((x) => x.endsWith('.md'))) {
      out.push({ path: join(segDir, f), id: f.replace(/\.md$/, ''), kind: 'segments' })
    }
  }
  return out
}

/**
 * 清空测试素材。**从不碰 10_archive**（档案只能整体销毁，见总设计 §3.6）。
 * @param {{apply?:boolean}} opts apply=false 时只列清单（dry run）
 */
export function resetFixtures(dir, { apply = false } = {}) {
  const files = listFixtures(dir)
  if (!apply) return { applied: false, files, deleted: 0 }
  for (const f of files) {
    try {
      unlinkSync(f.path)
    } catch {
      /* 已经不在了就算清掉 */
    }
  }
  writeIndex(dir, buildIndex(readPointFiles(dir, '30_points')))
  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'consolidation.log'),
    JSON.stringify({ at: new Date().toISOString(), action: 'reset-fixtures', files: files.map((f) => f.id) }) + '\n',
    'utf8',
  )
  return { applied: true, files, deleted: files.length }
}

// ── 批量提升（B 流程收尾）──────────────────────────────────────

/**
 * 把 40_pending 里所有校验通过的草稿一次 promote。
 * 这是 B 流程（digest → agent 写草稿 → ingest）的最后一步。
 * @param {{apply?:boolean}} opts apply=false 时只校验（dry run）
 */
export function ingestPending(dir, { apply = false } = {}) {
  const archive = readArchive(dir)
  const points = readPointFiles(dir, '30_points')
  const pending = readPointFiles(dir, '40_pending')
  const results = pending.map((p) => {
    const v = validatePoint(p, { archive, points, allowSample: false })
    return { id: p.id, file: p.file, segment: p.segment, raw: p.raw, ok: v.errors.length === 0, errors: v.errors }
  })
  if (!apply) return { applied: false, results, promoted: [] }

  const promoted = []
  for (const r of results) {
    if (!r.ok) continue
    const dest = join(dir, '30_points', `${r.id}.md`)
    if (existsSync(dest)) continue
    mkdirSync(join(dir, '30_points'), { recursive: true })
    const patched = r.raw.replace(/^status:.*$/m, 'status: active')
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, patched, 'utf8')
    renameSync(tmp, dest)
    unlinkSync(r.file)
    promoted.push(r)
  }

  writeIndex(dir, buildIndex(readPointFiles(dir, '30_points')))

  // 给压缩过的段打 .done，下次 digest 不再重复压
  const segDir = join(dir, '40_pending', '_segments')
  for (const r of promoted) {
    if (!r.segment) continue
    mkdirSync(segDir, { recursive: true })
    writeFileSync(
      join(segDir, `${r.segment}.done`),
      JSON.stringify({ segment: r.segment, points: [r.id], at: new Date().toISOString() }) + '\n',
      'utf8',
    )
  }

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'consolidation.log'),
    JSON.stringify({ at: new Date().toISOString(), action: 'ingest', points: promoted.map((r) => r.id) }) + '\n',
    'utf8',
  )
  return { applied: true, results, promoted }
}

// ── 切段 / 空窗 ────────────────────────────────────────────────

/**
 * 按 30 分钟静默切段，并标出 >24 小时的空窗。
 * @param {object[]} messages 已按时间排序的档案记录
 */
export function splitSegments(messages, { idleMin = 30, gapHours = 24, maxPerSegment = 80 } = {}) {
  const segments = []
  const gaps = []
  let cur = null
  let prev = null
  // 只切真正的对话；宿主塞进来的 time-context / user-approval 不进压缩包
  const conversation = messages.filter(
    (m) => !m.source_kind || m.source_kind === 'user' || m.source_kind === 'model',
  )
  for (const m of conversation) {
    const t = Date.parse(m.ts)
    if (!Number.isFinite(t)) continue
    if (prev !== null) {
      const dt = t - prev
      if (dt > gapHours * 3600_000) {
        gaps.push({ from: new Date(prev).toISOString(), to: new Date(t).toISOString(), days: +(dt / 86_400_000).toFixed(1) })
      }
      if (dt > idleMin * 60_000 || !cur || cur.messages.length >= maxPerSegment) cur = null
    }
    if (!cur) {
      cur = { start: m.ts, end: m.ts, messages: [] }
      segments.push(cur)
    }
    cur.messages.push(m)
    cur.end = m.ts
    prev = t
  }
  segments.forEach((s, i) => {
    s.id = `S-${localDay(new Date(s.start)).replace(/-/g, '')}-${String(i + 1).padStart(2, '0')}`
  })
  return { segments, gaps }
}

/** 一段对话 → 给压缩用的 markdown（原文 + 输出格式要求） */
export function renderDigest(segment) {
  const lines = [
    '---',
    `segment: ${segment.id}`,
    `start: ${segment.start}`,
    `end: ${segment.end}`,
    `messages: ${segment.messages.length}`,
    `source: [${segment.messages.map((m) => m.id).join(', ')}]`,
    '---',
    '',
    '> **这是给压缩用的原文，不是记忆点。** 请按顺序输出到 `40_pending/`：',
    '> 1. QUOTE：她在这个事件里说的原话，逐字，≤30 字；没有就写 none。',
    '> 2. SUM：55 个汉字以内，只写「发生了什么」和「她的情绪」。',
    '> 3. 全文：「发生了什么 / 她当时想 / 为什么重要」。',
    '> 4. QUOTE 和 SUM 都只能是全文的子集。**不许编造原文里没有的事。**',
    '',
    '## 对话原文',
    '',
  ]
  for (const m of segment.messages) {
    const who = m.role === 'assistant' ? '她' : '你'
    // v0.7.0：原文包是给模型压缩用的，等于进上下文 → 同样净化（磁盘档案不动）
    lines.push(`${who}：${sanitizeForPrompt(String(m.text).trim())}`, '')
  }
  return lines.join('\n')
}
