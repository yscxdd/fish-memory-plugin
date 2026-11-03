// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 最小睡眠 + 统一结算（v0.39.0）。
 *
 * 问题（实测出来的）：凌晨 2 点她被冒犯到 tier 1，你睡到早上 9 点回来——
 * 档位只在"有输入"时才动，所以她还是 tier 1（甚至只走一档到 2）。**早上第一句她还在生气。**
 *
 * 我们不做梦、不做夜间自主念头、不做夜间主动开口。只做**"睡过一觉"这个事件**：
 *
 *   判定：本地 00:00–06:00 之间，静默重叠 ≥4 小时 → 算睡过
 *        （不要系统休眠信号——那东西抓不到，是他们踩过的坑）
 *   结算：① tier → 3（睡一觉不记仇）
 *        ② 特殊情绪：有 until 的清掉；until=0 的只降一档强度（关系维按四成）
 *        ③ valence/arousal 额外收 65%（一次）
 *        ④ 习惯跨天衰减结算一次
 *        ⑤ 维护：行为账 14 天修剪、过期情绪、索引重建、纸条重写
 *
 * 主路径是**懒结算**（醒来第一轮算）；定时器只是加速，DSH 关了也不会丢账。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, localDay } from './util.js'
import { emptyState, loadEmotion, saveEmotion, pruneSpecials } from './emotion.js'
import { DAILY_DECAY, loadHabits, saveHabits } from './habits.js'
import { loadPresence, gapHours } from './presence.js'
import { pruneBehavior } from './behavior.js'
import { buildIndex, readPointFiles, writeIndex } from './toolkit.js'
import { maybeWriteWere } from './were.js'

export const SLEEP_STATE = join('20_state', 'sleep.json')
export const SLEEP_WINDOW_START = 0 // 本地 0 点
export const SLEEP_WINDOW_END = 6 // 到本地 6 点
export const SLEEP_MIN_HOURS = 4
export const SLEEP_DRIFT_KEEP = 0.35 // 额外收 65%：只留 35% 的偏离
export const SLEEP_LINE_MAX_TOK = 20

/** 本地某天的 0 点 / 6 点 */
function nightWindow(day, now) {
  const y = day.getFullYear()
  const m = day.getMonth()
  const d = day.getDate()
  return {
    start: new Date(y, m, d, SLEEP_WINDOW_START, 0, 0, 0),
    end: new Date(y, m, d, SLEEP_WINDOW_END, 0, 0, 0),
    now,
  }
}

/**
 * 这段静默里，有多少小时落在"夜里"（横跨多天也算）。
 * @returns {number} 夜间重叠小时数
 */
export function nightOverlapHours(from, to) {
  const a = new Date(from)
  const b = new Date(to)
  if (!(b > a)) return 0
  let total = 0
  const cursor = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  // 从 a 那天开始，一天一天往后看（封顶 30 天，防脏数据跑飞）
  for (let i = 0; i < 30; i++) {
    const win = nightWindow(cursor, b)
    const start = Math.max(win.start.getTime(), a.getTime())
    const end = Math.min(win.end.getTime(), b.getTime())
    if (end > start) total += (end - start) / 3600_000
    cursor.setDate(cursor.getDate() + 1)
    if (cursor.getTime() > b.getTime()) break
  }
  return Math.round(total * 10) / 10
}

export function loadSleep(dir) {
  const p = join(dir, SLEEP_STATE)
  if (!existsSync(p)) return { version: 1, lastSleepAt: null, lastSettleAt: null, nights: 0 }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return {
      version: 1,
      lastSleepAt: typeof j.lastSleepAt === 'string' ? j.lastSleepAt : null,
      lastSettleAt: typeof j.lastSettleAt === 'string' ? j.lastSettleAt : null,
      nights: Number(j.nights) || 0,
    }
  } catch {
    return { version: 1, lastSleepAt: null, lastSettleAt: null, nights: 0 }
  }
}

function saveSleep(dir, st) {
  atomicWriteJson(join(dir, SLEEP_STATE), { version: 1, ...st })
}

/**
 * 该不该结算：静默重叠夜里 ≥4 小时，且这段夜里还没结算过。
 * @returns {{slept:boolean, hours:number, reason:string}}
 */
export function detectSleep(dir, { now = new Date(), gap = null } = {}) {
  const presence = loadPresence(dir)
  const g = gap != null ? gap : gapHours(presence, now)
  if (g == null || g < SLEEP_MIN_HOURS) return { slept: false, hours: 0, reason: 'atime-too-short' }
  const from = new Date(Date.parse(presence.lastSeen))
  const hours = nightOverlapHours(from, now)
  if (hours < SLEEP_MIN_HOURS) return { slept: false, hours, reason: 'not-night' }

  // 幂等：这段夜结算过就不再算（以"上次睡醒时间"为准）
  const st = loadSleep(dir)
  if (st.lastSleepAt) {
    const last = Date.parse(st.lastSleepAt)
    if (Number.isFinite(last) && last >= now.getTime() - 12 * 3600_000 && last > from.getTime()) {
      return { slept: false, hours, reason: 'already' }
    }
  }
  return { slept: true, hours, reason: 'night-gap', from: from.toISOString() }
}

/** 情绪：睡一觉怎么落（只改情绪，不动 soul） */
export function settleEmotion(dir, { now = new Date() } = {}) {
  const st = loadEmotion(dir) || emptyState()
  const tierFrom = Number(st.tier) || 3

  st.tier = 3
  st.tierCause = '睡了一觉'
  st.frozenUntil = 0

  // 特殊情绪：有 until 的清掉；until=0（等他开口的委屈/思念）只降一档强度
  const list = Array.isArray(st.specials) ? st.specials : []
  const kept = []
  let cleared = 0
  for (const sp of list) {
    const until = Number(sp.until) || 0
    if (until > 0) {
      cleared += 1
      continue
    }
    // until=0 是「等他开口才散」的链条情绪：睡一觉不能当没发生过，
    // 但也不该一直挂着——给它一个 90 分钟的尾巴（气消一半）
    kept.push({ ...sp, until: now.getTime() + 90 * 60_000 })
  }
  st.specials = kept

  // 偏离再收 65%（只留 35%）
  const pull = (v, base) => Math.round((base + (Number(v) - base) * SLEEP_DRIFT_KEEP) * 100) / 100
  st.ai = { valence: pull(st.ai?.valence ?? 0, 0), arousal: pull(st.ai?.arousal ?? 0.5, 0.5) }
  st.sleptAt = now.toISOString()

  saveEmotion(dir, st)
  return { tierFrom, tierTo: st.tier, cleared, kept: kept.length }
}

/** 习惯：跨天衰减结算一次（平时是靠"她说话时"懒算，睡醒也该算） */
export function settleHabits(dir, { now = new Date() } = {}) {
  // 借 habits 自己的跨天逻辑：读 → 逐条跨天衰减 → 写
  const state = loadHabits(dir)
  const today = localDay(now)
  let decayed = 0
  for (const item of state.items) {
    if (item.day && item.day !== today) {
      item.w = Math.round(item.w * DAILY_DECAY * 1000) / 1000
      decayed += 1
    }
    item.day = today
    item.dayCount = 0
  }
  saveHabits(dir, state)
  return { decayed }
}

/** 维护：行为账修剪 + 纸条重写 + 索引重建（都不贵） */
export function settleMaintenance(dir, { now = new Date(), points = null } = {}) {
  const pruned = pruneBehavior(dir, now)
  const pts = points || readPointFiles(dir, '30_points')
  try {
    writeIndex(dir, buildIndex(pts))
  } catch {
    /* 索引重建失败不影响对话 */
  }
  const were = maybeWriteWere(dir, { now, points: pts })
  return { pruned: pruned.before - pruned.after, were: were.reason }
}

/**
 * 统一结算（睡眠 / 跨天 / 长静默共用）。**幂等**：同一段夜只结算一次。
 * @returns {{slept:boolean, hours:number, reason:string, summary?:object}}
 */
export function settle(dir, { now = new Date(), gap = null, points = null } = {}) {
  const det = detectSleep(dir, { now, gap })
  const st = loadSleep(dir)

  if (!det.slept) {
    // 没睡也算"结算过一次"（维护照跑，便宜）
    const m = settleMaintenance(dir, { now, points })
    saveSleep(dir, { ...st, lastSettleAt: now.toISOString() })
    return { slept: false, hours: det.hours, reason: det.reason, maintenance: m }
  }

  const emo = settleEmotion(dir, { now })
  const hab = settleHabits(dir, { now })
  const m = settleMaintenance(dir, { now, points })
  saveSleep(dir, { lastSleepAt: now.toISOString(), lastSettleAt: now.toISOString(), nights: (st.nights || 0) + 1 })

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'sleep.log'),
    JSON.stringify({
      at: now.toISOString(),
      slept: det.hours,
      tier: `${emo.tierFrom}->${emo.tierTo}`,
      specials: { cleared: emo.cleared, kept: emo.kept },
      habitsDecayed: hab.decayed,
      pruned: m.pruned,
      were: m.were,
    }) + '\n',
    'utf8',
  )

  return { slept: true, hours: det.hours, reason: det.reason, emotion: emo, habits: hab, maintenance: m }
}

/** 醒来那一句（≤20 tok；没睡就没有） */
export function sleepLine(result) {
  if (!result?.slept) return { text: '', tokens: 0 }
  const h = Math.round(result.hours)
  const text = `<!-- 睡醒 -->她刚睡醒，${h} 小时。<!-- /睡醒 -->`
  return { text, tokens: Math.max(1, Math.round([...text].length / 1.7)) }
}


