// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * "回来第一句"（v0.35.0）——借自"天上鱼"的念头层，但**不做心跳**。
 *
 * 他们有心跳，浏览器会自己冒念头；我们的宿主是对话驱动的，假装"她一直在想"是假的。
 * 我们只做诚实的那一半：**他离开一段时间再回来时**，她记得"上次说到哪"，
 * 并且（如果张力够）知道"自己还惦记着什么"。
 *
 * 三条规矩：
 *   ① 一次离开只说一次（`returnedAt` 记账），不刷屏；
 *   ② 没有"上次"就只说时长，不编；
 *   ③ ≤60 tok，独立短块，不进 core/index/body 预算。
 */

import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe, sanitizeForPrompt } from './util.js'

export const PRESENCE_FILE = join('20_state', 'presence.json')
export const RETURN_GAP_HOURS = 6 // 离开多久算"回来"
export const RETURN_LINE_MAX_TOK = 60

/** 读在场记录：坏文件当"没记录"（记忆坏了不该影响对话） */
export function loadPresence(dir) {
  const raw = readJsonSafe(join(dir, PRESENCE_FILE), null)
  if (!raw || typeof raw !== 'object') return { lastSeen: null, returnedAt: null, sessions: 0 }
  return {
    lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : null,
    returnedAt: typeof raw.returnedAt === 'string' ? raw.returnedAt : null,
    sessions: Number(raw.sessions) || 0,
  }
}

export function savePresence(dir, state) {
  atomicWriteJson(join(dir, PRESENCE_FILE), { version: 1, ...state })
}

const hours = (ms) => Math.max(0, ms / 3600_000)

/** 多久没来了（小时，保留一位）；没有记录返回 null */
export function gapHours(state, now = new Date()) {
  if (!state?.lastSeen) return null
  const t = Date.parse(state.lastSeen)
  if (!Number.isFinite(t)) return null
  return Math.round(hours(now.getTime() - t) * 10) / 10
}

const humanGap = (h) => {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟`
  if (h < 24) return `${Math.round(h)} 小时`
  const d = h / 24
  return d < 2 ? '一天多' : `${Math.round(d)} 天`
}

/**
 * 生成"回来"那一行（不写盘；写盘由 markSeen 做）。
 *
 * @param {{state:object, lastTopic?:string, question?:string, now?:Date, gapHours?:number}} args
 * @returns {{text:string, tokens:number, gapHours:number|null, shown:boolean}}
 */
export function returnLine({ state, lastTopic = '', question = '', now = new Date(), gapHours: g = null } = {}) {
  const gap = g != null ? g : gapHours(state, now)
  if (gap == null || gap < RETURN_GAP_HOURS) return { text: '', tokens: 0, gapHours: gap, shown: false }

  // 这次离开已经说过了 → 不再说
  if (state?.returnedAt && state.lastSeen) {
    const seen = Date.parse(state.lastSeen)
    const said = Date.parse(state.returnedAt)
    if (Number.isFinite(seen) && Number.isFinite(said) && said >= seen) {
      return { text: '', tokens: 0, gapHours: gap, shown: false }
    }
  }

  const parts = [`他隔了 ${humanGap(gap)}才回来。`]
  // v0.54.0（H1）：他那半句原话进 prompt 前净化
  if (lastTopic) parts.push(`上次说到「${sanitizeForPrompt(String(lastTopic).slice(0, 18))}」。`)
  if (question) parts.push('她心里还惦记着一件事。')
  const text = `<!-- 接着上次 -->${parts.join('')}<!-- /接着上次 -->`
  const tokens = Math.max(1, Math.round([...text].length / 1.7))
  return { text, tokens, gapHours: gap, shown: true }
}

/**
 * 每轮调用：更新 lastSeen；若这次已经说过"回来"，把 returnedAt 记上。
 * @returns {{gap:number|null, shown:boolean}}
 */
export function markSeen(dir, { now = new Date(), shown = false } = {}) {
  const state = loadPresence(dir)
  const gap = gapHours(state, now)
  const next = { ...state, lastSeen: now.toISOString() }
  if (shown) next.returnedAt = now.toISOString()
  else if (gap != null && gap < RETURN_GAP_HOURS) next.returnedAt = null // 正常对话 → 清掉"刚回来"标记
  next.sessions = (Number(state.sessions) || 0) + (gap != null && gap >= RETURN_GAP_HOURS ? 1 : 0)
  savePresence(dir, next)
  return { gap, shown }
}

/** 给 CLI 看的一行 */
export function presenceSummary(dir, now = new Date()) {
  const state = loadPresence(dir)
  const gap = gapHours(state, now)
  if (gap == null) return '还没有记录（第一次运行时才会写）。'
  const h = (ms) => {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s} 秒`
    if (s < 3600) return `${Math.round(s / 60)} 分钟`
    if (s < 86400) return `${Math.round(s / 3600)} 小时`
    return `${Math.round(s / 86400)} 天`
  }
  return `上次在场：${gap < 1 ? h(gap * 3600_000) + '前' : Math.round(gap * 10) / 10 + ' 小时前'} · 累计离开次数 ${state.sessions || 0}`
}
