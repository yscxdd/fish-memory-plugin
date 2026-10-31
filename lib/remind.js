// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * remind.js — 到期提醒（v0.21.0）。
 *
 * 为什么需要：`promise` 类型的点有"什么时候该办"的语义，但以前只有**被检索命中**
 * 才会进注入——于是就出现"答应过的事一直没被想起"。这不是遗忘曲线的问题，
 * 是**没有到期这个概念**。
 *
 * 三条约束（都为了不破坏契约）：
 *   ① **最多一行、≤40 tok**：只列 1–2 条，只给标题 + 天数，不写正文（正文在被命中时才有）；
 *   ② **不重复刷屏**：同一条点 12 小时内只提醒一次（`20_state/reminded.json`）；
 *   ③ **只读点，不改点**：不写 `30_points`，提醒记录是独立的瞬时状态。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, estTokens, localDay } from './util.js'

export const REMIND_FILE = join('20_state', 'reminded.json')
export const REMIND_COOLDOWN_MS = 12 * 3600_000
export const DUE_SOON_DAYS = 3

const dayDiff = (a, b) => {
  const ta = new Date(`${a}T00:00:00Z`).getTime()
  const tb = new Date(`${b}T00:00:00Z`).getTime()
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.round((ta - tb) / 86_400_000)
}

export function loadReminded(dir) {
  const p = join(dir, REMIND_FILE)
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * 挑出"该被想起来"的承诺/事件。
 * @returns {{id:string, title:string, type:string, due:string, days:number}[]} 逾期最久的在前
 */
export function duePoints(points, now = new Date(), { soonDays = DUE_SOON_DAYS } = {}) {
  const today = localDay(now)
  const out = []
  for (const p of points) {
    if (!p.due || (p.type !== 'promise' && p.type !== 'event')) continue
    if (p.status && p.status !== 'active') continue
    if (Number.isFinite(Date.parse(p.invalid_at)) && Date.parse(p.invalid_at) <= now.getTime()) continue
    const days = dayDiff(p.due, today)
    if (days == null) continue
    if (days > soonDays) continue // 还早，别提前吵
    out.push({ id: p.id, title: p.title || p.id, type: p.type, due: p.due, days })
  }
  return out.sort((a, b) => a.days - b.days)
}

/**
 * 拼那一行。返回 `{ text, tokens, ids }`——`ids` 由调用方决定要不要落盘标记。
 */
export function remindLine(due, { max = 2 } = {}) {
  if (!due.length) return { text: '', tokens: 0, ids: [] }
  const picked = due.slice(0, max)
  const parts = picked.map((d) => {
    const when = d.days === 0 ? '今天' : d.days === 1 ? '明天' : d.days < 0 ? `逾期${-d.days}天` : `${d.days}天后`
    return `${d.title}（${when}）`
  })
  const more = due.length > picked.length ? ` 等${due.length}条` : ''
  const text = `<!-- 该办了 -->承诺：${parts.join('、')}${more}<!-- /该办了 -->`
  return { text, tokens: estTokens(text), ids: picked.map((d) => d.id) }
}

/** 12 小时冷却：同一条点别每轮都提 */
export function freshDue(due, reminded, now = new Date()) {
  const t = now.getTime()
  return due.filter((d) => {
    const last = Number(reminded?.[d.id]?.at_ms)
    return !Number.isFinite(last) || t - last >= REMIND_COOLDOWN_MS
  })
}

/** 记下"提过了"。只写计数与时间，不写原文。 */
export function markReminded(dir, ids, now = new Date()) {
  const cur = loadReminded(dir)
  for (const id of ids) cur[id] = { at: now.toISOString(), at_ms: now.getTime() }
  atomicWriteJson(join(dir, REMIND_FILE), cur)
  return cur
}

/** 一步到位：给定点表，返回要注入的那一行（并落盘冷却标记）。 */
export function dueLine(dir, points, now = new Date()) {
  const due = freshDue(duePoints(points, now), loadReminded(dir), now)
  const line = remindLine(due)
  if (line.text) markReminded(dir, line.ids, now)
  return line
}
