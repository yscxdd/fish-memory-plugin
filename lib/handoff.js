// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * handoff.js — 到上限时"换窗"的交接包。
 *
 * 宿主会压缩上下文；压缩后最近几轮就没了。这里在压缩开始时（compaction/start）
 * 把"停在哪、没做完什么、关键的事"落成一份小包；新会话第一轮读一次，读后不删，
 * 靠 24 小时过期。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPointFiles } from './toolkit.js'

const FILE = '20_state/handoff.json'

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

  const lines = ['<!-- 接上次 -->', `上次停在这里（${now.toISOString().slice(0, 16).replace('T', ' ')}）：`]
  for (const m of tail.slice(-4)) lines.push(`${m.role === 'assistant' ? '她' : '你'}：${String(m.text).slice(0, 80)}`)
  if (threads.length) lines.push('', '没做完的事：', ...threads.map((t) => `- ${t}`))
  if (key.length) lines.push('', '不能忘的：', ...key.map((p) => `- ${p.title}`))
  lines.push('（接着聊，不要重新自我介绍。）', '<!-- /接上次 -->')

  const payload = { at: now.toISOString(), from: sid, text: lines.join('\n'), tail }
  mkdirSync(join(dir, '20_state'), { recursive: true })
  writeFileSync(join(dir, FILE), JSON.stringify(payload, null, 2), 'utf8')
  return { text: payload.text, tail: tail.length, threads: threads.length, from: sid }
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
