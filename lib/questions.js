// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * questions.js — 缺口 / 放不下的事（v0.27.0）。
 *
 * 借自"没有卡的鱼"那套 `gaps`：**想不起来的事不是"忘了"，而是会一直惦记**。
 * 我们旧立场是"找不到就说找不到"——干净，但没有"她放不下什么"。
 * 而她惦记什么，恰恰是"她是谁"的证据。
 *
 * 名字说明：本仓库的 `lib/gaps.js` 是"空窗草稿"（两句话之间隔了多久），
 * 跟"缺口/执念"不是一回事，所以这里叫 `questions`（她一直没弄明白的事）。
 *
 * 与他们刻意的三处差异：
 *   ① 他们每 30 秒 tick 推进张力；我们**按需投影**（读的时候按时间算、不写回）——
 *      插件不在跑的那些小时不该凭空攒张力，我们又不是常驻进程。
 *   ② 他们"说出来会松"是主动开口触发；我们只有**显式** `memory question touch` 才松，
 *      **渲染注入不算说过**（契约不变量 #11：渲染不写回）。
 *   ③ 上限 20 条；满了淘汰张力最低的一条并记 `50_log/question.log`（不静默丢）。
 *
 * 存哪：`20_state/questions.json`。它不是记忆点（没有 msg 来源、不该走 validatePoint），
 * 是"此刻惦记着的事"，跟 inj10 一样属于状态层。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, estTokens, localDay } from './util.js'

export const QUESTIONS_FILE = join('20_state', 'questions.json')
export const TENSION_PER_HOUR = 1.5
export const TOUCH_RELIEF = 25
export const TOUCH_FLOOR = 45
export const MAX_OPEN = 20
export const LINE_MIN_TENSION = 60

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const hoursSince = (ts, now) => {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now.getTime() - t) / 3600_000)
}

export function loadQuestions(dir) {
  const p = join(dir, QUESTIONS_FILE)
  if (!existsSync(p)) return { version: 1, items: [] }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] }
  } catch {
    return { version: 1, items: [] }
  }
}

export function saveQuestions(dir, items) {
  atomicWriteJson(join(dir, QUESTIONS_FILE), { version: 1, items })
}

/** 当前张力：落盘值 + 从 at 起按小时增长（只算，不写回） */
export function tensionOf(item, now = new Date()) {
  const b = Number(item.tension)
  const base = Number.isFinite(b) ? b : 0
  return Math.round(clamp(base + TENSION_PER_HOUR * hoursSince(item.at || item.created_at, now), 0, 100) * 10) / 10
}

export function openQuestions(dir) {
  return loadQuestions(dir).items.filter((q) => (q.status || 'open') === 'open')
}

/** 按当前张力排序（最重的在前；同分按更早创建） */
export function rankedQuestions(dir, now = new Date()) {
  return openQuestions(dir)
    .map((q) => ({ ...q, now_tension: tensionOf(q, now) }))
    .sort((a, b) => b.now_tension - a.now_tension || String(a.created_at).localeCompare(String(b.created_at)))
}

/**
 * 记一条"放不下的事"。
 * @param {{text:string, from?:string}} input from: recall | look | read | dream | self
 */
export function addQuestion(dir, { text, from = 'self' }, now = new Date()) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: '内容不能为空' }
  const store = loadQuestions(dir)
  const day = localDay(now).replace(/-/g, '')
  const sameDay = store.items.filter((q) => String(q.id).startsWith(`Q-${day}`)).length
  const id = `Q-${day}-${String(sameDay + 1).padStart(2, '0')}`

  const item = {
    id,
    text: t.slice(0, 80),
    from,
    tension: 0,
    at: now.toISOString(),
    created_at: now.toISOString(),
    last_touch_at: null,
    status: 'open',
  }
  store.items.push(item)

  const dropped = []
  // 满了就一直淘汰到不超（可能一次加进来后又降过 MAX_OPEN，所以要 while）
  let open = store.items.filter((q) => (q.status || 'open') === 'open')
  while (open.length > MAX_OPEN) {
    const lowest = open
      .filter((q) => q.id !== id)
      .map((q) => ({ q, t: tensionOf(q, now) }))
      .sort((a, b) => a.t - b.t)[0]
    if (!lowest) break
    lowest.q.status = 'dropped'
    lowest.q.dropped_at = now.toISOString()
    dropped.push(lowest.q.id)
    open = store.items.filter((q) => (q.status || 'open') === 'open')
  }
  saveQuestions(dir, store.items)
  return { ok: true, item, dropped }
}

/** 说出来会松：显式调用才降；渲染不算说过 */
export function touchQuestion(dir, id, now = new Date()) {
  const store = loadQuestions(dir)
  const q = store.items.find((x) => x.id === id)
  if (!q) return { ok: false, reason: `没有这一条：${id}` }
  const before = tensionOf(q, now)
  // 松，但别把"本来就很轻"的抬到地板——touch 不该让它反而变重
  q.tension = Math.round(Math.min(before, Math.max(TOUCH_FLOOR, before - TOUCH_RELIEF)) * 10) / 10
  q.at = now.toISOString()
  q.last_touch_at = now.toISOString()
  q.touches = (Number(q.touches) || 0) + 1
  saveQuestions(dir, store.items)
  return { ok: true, item: q, before }
}

/** 想通了：转 resolved，记下被哪个点解决 */
export function resolveQuestion(dir, id, { by = null } = {}, now = new Date()) {
  const store = loadQuestions(dir)
  const q = store.items.find((x) => x.id === id)
  if (!q) return { ok: false, reason: `没有这一条：${id}` }
  q.status = 'resolved'
  q.resolved_at = now.toISOString()
  q.resolved_by = by || null
  saveQuestions(dir, store.items)
  return { ok: true, item: q }
}

/**
 * 注入用的那一行：只带**最重**的一条，且张力要够。
 * 只读——不 touch、不落盘（不变量 #11）。
 */
export function questionLine(dir, now = new Date(), { minTension = LINE_MIN_TENSION } = {}) {
  const top = rankedQuestions(dir, now).filter((q) => q.now_tension >= minTension)[0]
  if (!top) return { text: '', tokens: 0, id: null, tension: 0 }
  const text = `<!-- 放不下 -->她一直没弄明白：${top.text}<!-- /放不下 -->`
  return { text, tokens: estTokens(text), id: top.id, tension: top.now_tension }
}

/** 长期没碰的（audit 用） */
export function staleQuestions(dir, now = new Date(), { days = 30 } = {}) {
  return rankedQuestions(dir, now).filter((q) => hoursSince(q.last_touch_at || q.created_at, now) > days * 24)
}
