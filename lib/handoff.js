// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * handoff.js — 到上限时"换窗"的交接包。
 *
 * 宿主会压缩上下文；压缩后最近几轮就没了。这里在压缩开始时（compaction/start）
 * 把"停在哪、没做完什么、关键的事"落成一份小包；新会话第一轮读一次，读后不删，
 * 靠 24 小时过期。
 *
 * v0.52.0 按 `docs/RESEARCH-2026-11-05-context-handoff.md` 补了两栏
 * （方案二"五栏"里最值钱的「已否决」+ 方案四"她本人写"的关系状态）：
 *   · **我还惦记着**（regrets）：开放问题里张力最高的 1–2 条——她放不下的事；
 *   · **别再提**（doNotMention）：最近 7 天 resolved/dropped 的 1–2 条——说好了不再翻的。
 *
 * 这两栏机器拼不出"意思"，但**素材现成**（`20_state/questions.json`），而且只有它们
 * 才让下一棒知道"哪件事别踩"。
 *
 * 三条硬约束：
 *   ① 每栏最多 2 条（"下一步只写一件"，写多件等于没写）；
 *   ② 顶部带一行"这是线索不是结论"——她写的/机器拼的都可能在压力下走形，细节回点链核；
 *   ③ 老包能读（没有新栏就照旧），不要求迁移。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadQuestions, tensionOf } from './questions.js'
import { readArchive, readPointFiles } from './toolkit.js'

export const FILE = join('20_state', 'handoff.json')
export const MAX_PER_SECTION = 2
export const CAVEAT = '（这是线索，不是结论；细节回点链核）'
export const DONT_MENTION_DAYS = 7

const clip = (s, n = 40) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 她放不下的事：开放问题里张力最高的（只读，不 touch） */
export function regrets(dir, now = new Date(), { limit = MAX_PER_SECTION } = {}) {
  const items = loadQuestions(dir).items || []
  return items
    .filter((q) => (q.status || 'open') === 'open')
    .map((q) => ({ text: q.text, tension: Math.round(tensionOf(q, now)) }))
    .sort((a, b) => b.tension - a.tension)
    .slice(0, limit)
    .map((x) => clip(x.text))
}

/** 说好了不再提的：最近 N 天解决或放下的 */
export function doNotMention(dir, now = new Date(), { limit = MAX_PER_SECTION, days = DONT_MENTION_DAYS } = {}) {
  const items = loadQuestions(dir).items || []
  const floor = now.getTime() - days * 86_400_000
  return items
    .filter((q) => q.status === 'resolved' || q.status === 'dropped')
    .filter((q) => {
      const t = Date.parse(q.resolved_at || q.dropped_at || '')
      return Number.isFinite(t) && t >= floor
    })
    .sort((a, b) => Date.parse(b.resolved_at || b.dropped_at || '') - Date.parse(a.resolved_at || a.dropped_at || ''))
    .slice(0, limit)
    .map((q) => clip(q.text))
}

/**
 * 写「换窗交接包」。
 *
 * `session` 有两种形状，**两种都要认**：
 *   - 宿主的会话对象：`{ id, ... }`
 *   - 库里的会话文件：`{ session_id, tail, open_threads, ... }`（`store.session()` 给的就是这个）
 *
 * v0.20.0 之前只看 `session?.id`，于是传进来的是库里的会话文件时**静默返回 null**——
 * 也就是说这条交接链一直是断的（`compaction/start` 和压力换窗两条路都没写成过包）。
 * 是 v0.20.0 的端到端测试先把它照出来的。
 */
export function buildHandoff(dir, session, now = new Date()) {
  const sid = session?.id ?? session?.session_id
  if (!sid) return null
  const tail = (session.tail || []).slice(-8)
  const threads = (session.open_threads || []).filter(Boolean).slice(0, 5)
  const key = readPointFiles(dir, '30_points')
    .filter((p) => p.status === 'active' && p.key)
    .slice(0, 5)
  const reg = regrets(dir, now)
  const dont = doNotMention(dir, now)

  const lines = ['<!-- 接上次 -->', `上次停在这里（${now.toISOString().slice(0, 16).replace('T', ' ')}）：`]
  for (const m of tail.slice(-4)) lines.push(`${m.role === 'assistant' ? '她' : '你'}：${clip(m.text, 60)}`)
  if (threads.length) lines.push('', '没做完的事：', ...threads.map((t) => `- ${clip(t, 40)}`))
  if (key.length) lines.push('', '不能忘的：', ...key.map((p) => `- ${clip(p.title, 30)}`))
  if (reg.length) lines.push('', '我还惦记着：', ...reg.map((t) => `- ${t}`))
  if (dont.length) lines.push('', '别再提：', ...dont.map((t) => `- ${t}`))
  lines.push('', CAVEAT, '（接着聊，不要重新自我介绍。）', '<!-- /接上次 -->')

  const payload = {
    version: 2,
    at: now.toISOString(),
    from: sid,
    text: lines.join('\n'),
    tail,
    regrets: reg,
    doNotMention: dont,
  }
  mkdirSync(join(dir, '20_state'), { recursive: true })
  writeFileSync(join(dir, FILE), JSON.stringify(payload, null, 2), 'utf8')
  return {
    text: payload.text,
    tail: tail.length,
    threads: threads.length,
    regrets: reg.length,
    doNotMention: dont.length,
    from: sid,
  }
}

/**
 * 从档案尾部拼一份交接包（没有会话对象时用：CLI `memory handoff --write`）。
 * 只读档案；"没做完的事"留空——编一条比留空糟。
 */
export function buildHandoffFromArchive(dir, now = new Date(), { tailSize = 8 } = {}) {
  const { messages } = readArchive(dir)
  const tail = messages.slice(-tailSize).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }))
  return buildHandoff(dir, { id: 'cli-manual', tail, open_threads: [] }, now)
}

/** @returns {string|null} 同一会话不读自己的交接包；超过 24h 过期 */
export function takeHandoff(dir, currentSession, { maxAgeHours = 24 } = {}) {
  const p = join(dir, FILE)
  if (!existsSync(p)) return null
  try {
    const h = JSON.parse(readFileSync(p, 'utf8'))
    if (!h?.text || !h?.at) return null
    if (currentSession && h.from === currentSession) return null
    if (Date.now() - Date.parse(h.at) > maxAgeHours * 3600_000) return null
    return h.text
  } catch {
    return null
  }
}

/** 读当前交接包（CLI 看用）；没有就 null */
export function readHandoff(dir) {
  const p = join(dir, FILE)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 清掉交接包（CLI 用） */
export function clearHandoff(dir) {
  const p = join(dir, FILE)
  if (!existsSync(p)) return { ok: true, removed: false }
  try {
    unlinkSync(p)
    return { ok: true, removed: true }
  } catch (e) {
    return { ok: false, removed: false, reason: String(e?.message || e) }
  }
}
