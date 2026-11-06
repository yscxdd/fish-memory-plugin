// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * alias.js — 别名半自动（v0.48.0）：从他自己的措辞里挖候选，人点头才写回点。
 *
 * 为什么需要（这是本库召回率的天花板，不是调参问题）：
 *   检索靠字面重合。点的 title/tags 是**她**的措辞（"他膝盖疼"），
 *   他的说法是另一套（"关节不舒服"）。两套词零重合，字级词级都救不回来——
 *   实测（`docs/RESEARCH-2026-11-04-upstream-optimizations.md` §A1）：
 *   同义改述的二字组重合与词级重合**都是 0.00**。分词治词形和切分，
 *   治不了"换个说法"。唯一能连上两套措辞的东西是**别名**。
 *
 * 为什么是"半自动"：
 *   自动写别名 = 让模型猜同义词 = 猜错就永久污染检索（而且无法归因）。
 *   所以这里只做两件确定性的事：① 从档案里**数**出候选词；② 人 accept 后写回。
 *   全程没有一个模型调用，候选的每一条都能指回具体的 message。
 *
 * 候选怎么来的（三条件，缺一不算）：
 *   1. 出现在**同一条消息**里，且那条消息里还出现了该点已有的词（seed）——共现；
 *   2. 至少 minSupport 条**不同**消息里都这样共现——不是一次口误；
 *   3. 不在该点现有词表里，也不包含现有词（否则加进去不增加任何召回路径）。
 *
 * 排序：共现条数 ↓ → 他说的条数 ↓ → 词更短 ↑。**不按 idf 排**：
 * 稀有词多是错别字，先给人看他真在反复说的那些。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, atomicWriteText, localDay, readJsonSafe } from './util.js'
import { readArchive, scanPointFiles } from './toolkit.js'

/** 拒绝表：人否掉的候选不再提（`20_state/alias-reject.json`） */
export const REJECT_FILE = '20_state/alias-reject.json'
/** 流水（只追加，只有点 id 与词，不含原话） */
export const ALIAS_LOG = '50_log/alias.log'

/**
 * 功能词表：不作为候选，也不作为 seed。
 * 这份表只影响"提议什么"，不影响检索——漏掉几个不致命，多写几个也不脏数据。
 */
const STOP = new Set(
  (
    '的 了 是 在 我 你 他 她 它 们 和 与 就 都 也 不 没 有 这 那 个 一 上 下 吗 呢 吧 啊 呀 哦 嗯 得 地 着 过 把 被 给 让 还 又 很 太 要 会 能 说 去 来 吃 好 什么 怎么 这样 那样 ' +
    '自己 我们 你们 他们 她们 因为 所以 但是 可是 如果 就是 还是 已经 可以 一个 这个 那个 现在 时候 一下 有点 一点 知道 觉得 应该 可能 真的 其实 然后 而且 或者 ' +
    'the a an and or but if then of to in on at is are was were be been it this that i you he she we they my your his her'
  ).split(/\s+/).filter(Boolean),
)

/** 一段文本 → 内容词（去停用词、去单字虚词、去纯数字） */
export function contentWords(text) {
  const t = String(text || '').normalize('NFKC').toLowerCase()
  if (!t) return []
  const out = []
  // Node 18+ 自带 Intl.Segmenter；ICU 裁剪过的构建里没有，退回按字切
  let pieces = null
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' })
    pieces = [...seg.segment(t)].map((x) => x.segment)
  } catch {
    pieces = t.split('')
  }
  for (const raw of pieces) {
    const w = raw.replace(/[^\u4e00-\u9fffa-z0-9]/g, '')
    if (!w) continue
    if (STOP.has(w)) continue
    if (/^[0-9]+$/.test(w)) continue
    out.push(w)
  }
  return out
}

/**
 * 一条点已有的"表面形式"（surface forms）：title / tags / aliases / cluster。
 * 这些词已经能被检索命中，所以不能再当候选。
 */
export function pointVocab(point) {
  const set = new Set()
  for (const s of [point?.title || '', point?.cluster || '', ...(point?.tags || []), ...(point?.aliases || [])]) {
    for (const w of contentWords(s)) set.add(w)
    const compact = String(s).replace(/\s+/g, '')
    if (compact) set.add(compact)
  }
  return set
}

/** 候选词的形状校验：accept 也走这一条，保证写进 front matter 的东西是安全的 */
export function validTerm(term) {
  const t = String(term || '').trim()
  if (!t) return { ok: false, reason: '空词' }
  if (t.length > 12) return { ok: false, reason: '太长（>12 字），不像一个别名' }
  if (/[,[\]{}"'\n\r\t:|]/.test(t)) return { ok: false, reason: '含分隔符（, [ ] { } " \' | :），会破坏 front matter' }
  if (STOP.has(t.toLowerCase())) return { ok: false, reason: '功能词，不能当别名' }
  if (!/[\u4e00-\u9fffa-z0-9]/i.test(t)) return { ok: false, reason: '没有可用字符' }
  return { ok: true, term: t }
}

function archiveTexts(dir) {
  const { messages } = readArchive(dir)
  return messages
    .filter((m) => String(m.text || '').trim())
    .map((m) => ({
      id: m.id || '',
      role: m.role === 'user' ? 'user' : 'model',
      ts: String(m.ts || ''),
      text: String(m.text || ''),
      // v0.65.0（S5）：会话 id 必须带下来，否则"跨会话"判据拿不到证据
      session: m.session ? String(m.session) : null,
    }))
}

function dayDiff(a, b) {
  const t1 = Date.parse(a)
  const t2 = Date.parse(b)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Infinity
  return Math.abs(t1 - t2) / 86_400_000
}

/**
 * 挖一个点的别名候选。
 *
 * @param {string} dir 记忆库根目录
 * @param {object} point 记忆点（至少需要 id/title/tags/aliases/cluster/date）
 * @param {{minSupport?:number, windowDays?:number, limit?:number, messages?:object[]}} [opts]
 *   windowDays = 0 表示不限时间窗；messages 可传入已解析的档案（批量跑时复用）
 * @returns {{point:string, seeds:string[], candidates:object[], scanned:number}}
 */
export function mineAliases(dir, point, { minSupport = 3, windowDays = 0, limit = 8, messages } = {}) {
  const vocab = pointVocab(point)
  const seeds = [...vocab].filter((w) => w.length >= 2 || /[\u4e00-\u9fff]/.test(w))
  const msgs = messages || archiveTexts(dir)
  const rejected = new Set(loadRejections(dir)[String(point?.id || '')] || [])
  // v0.65.0：没有 session 信息的旧档案不过会话闸
  const anySession = msgs.some((m) => m.session)
  const pointDate = point?.date || point?.valid_from || ''

  const inWindow = (m) => !windowDays || !pointDate || dayDiff(m.ts, pointDate) <= windowDays

  /** term → {support, sessions:Set, inUser, firstAt, sample} */
  const acc = new Map()
  let scanned = 0
  for (const m of msgs) {
    if (!inWindow(m)) continue
    // 这条消息里得有该点的某个 seed，才谈得上"共现"
    const hitSeed = seeds.some((s) => m.text.includes(s))
    if (!hitSeed) continue
    scanned += 1
    const seen = new Set()
    for (const w of contentWords(m.text)) {
      if (seen.has(w)) continue
      seen.add(w)
      if (vocab.has(w)) continue
      // 包含现有词 = 已被现有词覆盖，加进来不增加召回路径
      if ([...vocab].some((v) => v.length >= 2 && w.includes(v))) continue
      if (rejected.has(w)) continue
      const cur = acc.get(w) || { support: 0, sessions: new Set(), inUser: 0, firstAt: m.ts, sample: '' }
      cur.support += 1
      // v0.65.0（S5）：数**会话**不数消息——同一场任务里刷三遍就能产出假别名，
      // 一旦 accept 就写进点文件，检索永久漂移。
      if (m.session) cur.sessions.add(String(m.session))
      if (m.role === 'user') cur.inUser += 1
      if (!cur.sample) cur.sample = m.text.slice(0, 40)
      acc.set(w, cur)
    }
  }

  const candidates = [...acc.entries()]
    // v0.65.0（S5）：证据要跨会话。support 仍是条数（保留信息量），但入口条件是不同会话数。
    .filter(([, v]) => v.support >= minSupport && (!anySession || v.sessions.size >= Math.min(minSupport, 3)))
    .map(([term, v]) => ({ term, support: v.support, sessions: v.sessions.size, inUser: v.inUser, sample: v.sample, firstAt: v.firstAt }))
    .sort((a, b) => b.support - a.support || b.inUser - a.inUser || a.term.length - b.term.length || a.term.localeCompare(b.term))
    .slice(0, limit)

  return { point: String(point?.id || ''), seeds, candidates, scanned }
}

/** 批量：所有 active 点各挖一遍，只留挖出候选的 */
export function mineAll(dir, { minSupport = 3, windowDays = 0, limit = 8, sub = '30_points' } = {}) {
  const points = scanPointFiles(dir, sub).points.filter((p) => p.status === 'active')
  const messages = archiveTexts(dir)
  const rows = []
  for (const p of points) {
    const r = mineAliases(dir, p, { minSupport, windowDays, limit, messages })
    if (r.candidates.length) rows.push(r)
  }
  rows.sort((a, b) => b.candidates[0].support - a.candidates[0].support)
  return rows
}

// ── front matter 写回 ─────────────────────────────────────────

/** 读一条点的 aliases（不依赖 store 的缓存，离线命令用） */
export function readAliases(point) {
  return Array.isArray(point?.aliases) ? point.aliases : []
}

/**
 * 把 aliases 写回 front matter 的**那一行**，正文一个字节都不动。
 *
 * 三种现状都要处理：行内 `aliases: [a, b]`、块状 `aliases:` + `- a`、以及没有这个键。
 * 换行风格跟原文件走（CRLF 的文件写回还是 CRLF）。
 */
export function setAliasesInText(raw, aliases) {
  const text = String(raw || '')
  const m = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { ok: false, reason: '没有 front matter' }
  const eol = m[1]
  const lines = m[2].split(/\r?\n/)
  const value = `aliases: [${aliases.join(', ')}]`

  const idx = lines.findIndex((l) => /^aliases\s*:/.test(l))
  if (idx >= 0) {
    const inline = /^aliases\s*:\s*(\[.*\])?\s*$/.exec(lines[idx])
    if (inline && inline[1] !== undefined) {
      lines[idx] = value
    } else if (/^aliases\s*:\s*$/.test(lines[idx])) {
      // 块状：吃掉后面的 `- x` 行
      let j = idx + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) j += 1
      lines.splice(idx, j - idx, value)
    } else {
      lines[idx] = value
    }
  } else {
    // 没有这个键：插在最后一个非空行之后（保持人写的字段顺序直觉）
    let at = lines.length
    while (at > 0 && !String(lines[at - 1]).trim()) at -= 1
    lines.splice(at, 0, value)
  }
  const body = text.slice(m[0].length)
  return { ok: true, text: `---${eol}${lines.join(eol)}${eol}---${eol}${body}` }
}

/**
 * 人点头 → 写回。只加不覆盖；重复的静默跳过（幂等）。
 * @returns {{ok:boolean, reason?:string, aliases?:string[], added?:boolean, file?:string}}
 */
export function acceptAlias(dir, pointId, term, { sub = '30_points', now = new Date() } = {}) {
  const v = validTerm(term)
  if (!v.ok) return { ok: false, reason: v.reason }
  const hit = scanPointFiles(dir, sub).points.find((p) => p.id === pointId || p.filename === pointId)
  if (!hit) return { ok: false, reason: `找不到点 ${pointId}` }
  const cur = readAliases(hit)
  if (cur.includes(v.term)) return { ok: true, added: false, aliases: cur, file: hit.file }
  const next = [...cur, v.term]
  const w = setAliasesInText(hit.raw, next)
  if (!w.ok) return { ok: false, reason: w.reason }
  atomicWriteText(hit.file, w.text)
  logAlias(dir, { at: now.toISOString(), day: localDay(now), point: pointId, term: v.term, action: 'accept' })
  return { ok: true, added: true, aliases: next, file: hit.file }
}

/** 人否掉 → 进拒绝表，以后不再提（不写点文件） */
export function rejectAlias(dir, pointId, term, { now = new Date() } = {}) {
  const v = validTerm(term)
  if (!v.ok) return { ok: false, reason: v.reason }
  const all = loadRejections(dir)
  const list = Array.isArray(all[pointId]) ? all[pointId] : []
  if (!list.includes(v.term)) list.push(v.term)
  all[pointId] = list
  atomicWriteJson(join(dir, REJECT_FILE), all)
  logAlias(dir, { at: now.toISOString(), day: localDay(now), point: pointId, term: v.term, action: 'reject' })
  return { ok: true, rejected: list }
}

export function loadRejections(dir) {
  const v = readJsonSafe(join(dir, REJECT_FILE), {})
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function logAlias(dir, row) {
  try {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, ALIAS_LOG), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    /* 记不上流水不影响这次写入 */
  }
}

/** 全部点的别名一览（`memory alias list`） */
export function aliasOverview(dir, sub = '30_points') {
  const points = scanPointFiles(dir, sub).points
  return points
    .map((p) => ({ id: p.id, title: p.title, aliases: readAliases(p) }))
    .filter((r) => r.aliases.length)
    .sort((a, b) => b.aliases.length - a.aliases.length)
}

/** 覆盖率：有至少一条别名的点占多少（`memory alias` 的头部数字） */
export function aliasCoverage(dir, sub = '30_points') {
  const points = scanPointFiles(dir, sub).points.filter((p) => p.status === 'active')
  const withAlias = points.filter((p) => readAliases(p).length > 0).length
  return { points: points.length, withAlias, rate: points.length ? withAlias / points.length : 0 }
}

/** 拒绝表里是否有这条（测试与 CLI 展示用） */
export function isRejected(dir, pointId, term) {
  return (loadRejections(dir)[String(pointId || '')] || []).includes(String(term || ''))
}

