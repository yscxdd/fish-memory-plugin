// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 习惯权重（v0.36.0）——借自"天上鱼"的习惯层，但按我们的规矩裁剪。
 *
 * 他们解决的是"她越来越像客服"：开头"好的"、一说三句、结尾带句号。
 * 他们把"说话方式"变成可积累、可衰减、有门限的**权重**——我们照做，但只做**可检测**的部分。
 *
 * 三条硬规矩：
 *   ① **文本人写**：habit 的文字是种子/人加的，代码只动 `w`（和 soul 文本 / origin 权重同一个模式）；
 *   ② **只测能测的**：一句一条 / 结尾不用句号 / ≤40 字。 "不重复问"、"不为留人编话" 规则判断不了，不硬上；
 *   ③ **权重只影响"提不提醒"，不影响"怎么写"**——它进注入只占一小块。
 *
 * 演化（他们的公式）：
 *   命中 w += 0.06 × (1 − w)
 *   违反 w −= 0.05 × w
 *   每天 w × 0.98
 *   单日上限：同一习惯最多计 3 次
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, localDay, readJsonSafe } from './util.js'

export const HABITS_FILE = join('20_state', 'habits.json')
export const HIT_GAIN = 0.06
export const VIOLATE_LOSS = 0.05
export const DAILY_DECAY = 0.98
export const DAILY_CAP = 3
export const INJECT_HARD = 0.75 // ≥ 硬性
export const INJECT_NORMAL = 0.5 // ≥ 平时
export const ARCHIVE_BELOW = 0.3 // < 归档（不再注入）
export const MAX_INJECT = 4
export const MAX_HABIT_CHARS = 16

/** 三条可检测的种子（文本是给人看的，不是代码拼的） */
export const SEED_HABITS = [
  { id: 'one-sentence', text: '一句一条，说完就停' },
  { id: 'no-period', text: '结尾不用句号' },
  { id: 'short', text: '单条不超过 40 字' },
]

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const round3 = (v) => Math.round(v * 1000) / 1000

/** 空状态：三条种子，初始权重 0.5（不预设"她已经会了"） */
export function emptyHabits() {
  return {
    version: 1,
    items: SEED_HABITS.map((h) => ({
      id: h.id,
      text: h.text,
      w: 0.45, // 还没证明她做得到 → 先不提醒；做到几次自然浮上来
      hits: 0,
      violations: 0,
      lastHit: null,
      lastViolation: null,
      day: null,
      dayCount: 0,
    })),
  }
}

export function loadHabits(dir) {
  const p = join(dir, HABITS_FILE)
  if (!existsSync(p)) return emptyHabits()
  const raw = readJsonSafe(p, null)
  if (!raw || !Array.isArray(raw.items) || !raw.items.length) return emptyHabits()
  return {
    version: 1,
    items: raw.items
      .filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({
        id: x.id,
        text: x.text,
        w: clamp01(Number(x.w) || 0),
        hits: Number(x.hits) || 0,
        violations: Number(x.violations) || 0,
        lastHit: x.lastHit || null,
        lastViolation: x.lastViolation || null,
        day: x.day || null,
        dayCount: Number(x.dayCount) || 0,
      })),
  }
}

export function saveHabits(dir, state) {
  atomicWriteJson(join(dir, HABITS_FILE), { version: 1, items: state.items })
}

/** 一次回复的"体检"：哪几条命中、哪几条违反（纯函数，不写盘） */
export function inspectReply(text) {
  const t = String(text || '').trim()
  const chars = [...t].length
  // 句子数：句末标点的个数（末尾没有标点也算一句）
  const ends = (t.match(/[。！？!?…]/g) || []).length
  const sentences = ends === 0 ? 1 : ends
  const endsWithPeriod = /[。]\s*$/.test(t)
  return {
    chars,
    sentences,
    endsWithPeriod,
    verdict: {
      'one-sentence': sentences <= 1,
      'no-period': !endsWithPeriod,
      short: chars <= 40,
    },
  }
}

/**
 * 记一次样本：命中加、违反减、单日最多计 3 次、跨天先衰减。
 * @returns {{changed:Array<{id:string,from:number,to:number}>, day:string}}
 */
export function recordReply(dir, text, { now = new Date() } = {}) {
  const state = loadHabits(dir)
  const day = localDay(now)
  const v = inspectReply(text)
  const changed = []

  for (const item of state.items) {
    // 跨天：先衰减，再重置当日计数
    if (item.day !== day) {
      if (item.day) item.w = round3(clamp01(item.w * DAILY_DECAY))
      item.day = day
      item.dayCount = 0
    }
    if (item.dayCount >= DAILY_CAP) continue
    const ok = v.verdict[item.id]
    if (ok === undefined) continue // 不可检测的习惯，永远不动
    const from = item.w
    if (ok) {
      item.w = round3(clamp01(item.w + HIT_GAIN * (1 - item.w)))
      item.hits += 1
      item.lastHit = now.toISOString()
    } else {
      item.w = round3(clamp01(item.w - VIOLATE_LOSS * item.w))
      item.violations += 1
      item.lastViolation = now.toISOString()
    }
    item.dayCount += 1
    if (item.w !== from) changed.push({ id: item.id, from, to: item.w })
  }

  saveHabits(dir, state)
  return { changed, day }
}

/** 读状态并按"门限"挑出该提醒的（只读，不改权重） */
export function habitsBlock(dir, { max = MAX_INJECT } = {}) {
  const state = loadHabits(dir)
  const rank = (a, b) => b.w - a.w
  const hi = state.items.filter((x) => x.w >= INJECT_HARD).sort(rank)
  const mid = state.items.filter((x) => x.w >= INJECT_NORMAL && x.w < INJECT_HARD).sort(rank)
  const picked = [...hi, ...mid].slice(0, max)
  if (!picked.length) return { text: '', picked: [], tokens: 0 }
  const lines = picked.map((x) => x.text)
  const text = `<!-- 习惯 -->${lines.join('；')}<!-- /习惯 -->`
  const tokens = Math.max(1, Math.round([...text].length / 1.7))
  return { text, picked: picked.map((x) => ({ id: x.id, w: x.w })), tokens }
}

/** 状态一览（给 CLI / audit） */
export function habitsSummary(dir) {
  const state = loadHabits(dir)
  return state.items
    .map((x) => ({
      id: x.id,
      text: x.text,
      w: x.w,
      level: x.w >= INJECT_HARD ? '硬性' : x.w >= INJECT_NORMAL ? '平时' : x.w >= ARCHIVE_BELOW ? '偏低' : '归档',
      hits: x.hits,
      violations: x.violations,
    }))
    .sort((a, b) => b.w - a.w)
}

/** 加一条习惯（文本人写；默认 w=0.4，还没证明她做得到） */
export function addHabit(dir, text, { w = 0.4, id = null } = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: '习惯文本不能为空' }
  if ([...t].length > MAX_HABIT_CHARS * 2) return { ok: false, reason: `太长（>${MAX_HABIT_CHARS * 2} 字），注入会挤` }
  const state = loadHabits(dir)
  if (state.items.some((x) => x.text === t)) return { ok: false, reason: '已经有这一条' }
  state.items.push({
    id: id || `custom-${state.items.length + 1}`,
    text: t,
    w: clamp01(w),
    hits: 0,
    violations: 0,
    lastHit: null,
    lastViolation: null,
    day: null,
    dayCount: 0,
  })
  saveHabits(dir, state)
  return { ok: true, count: state.items.length }
}
