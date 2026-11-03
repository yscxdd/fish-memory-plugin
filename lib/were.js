// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 「上次聊到哪儿」的纸条（v0.37.0）——借自《AI伙伴运行机制》。
 *
 * 他们的做法：**两三百字，只写"最后一句原话 + 没说完的那半句"，不写结论**；
 * 醒了先读这张纸，不读历史。给"轻唤醒"读，省 token，也不会把结论当事实。
 *
 * 四条硬规矩：
 *   ① **只摘原话**，一个字不改（截断就加省略号）；
 *   ② **没写完的半句单独留**（以 ，、——… 结尾时），因为"没说完"本身就是信息；
 *   ③ **不写结论**——不总结、不评价、不推断；
 *   ④ 零 LLM，纯拼装；文件小到人一眼能看完（≤300 字）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteText, localDay } from './util.js'
import { readArchive } from './toolkit.js'
import { LINE_MIN_TENSION, rankedQuestions, tensionOf } from './questions.js'

export const WERE_FILE = join('20_state', 'where-we-were.md')
export const WERE_MAX_CHARS = 300
export const QUOTE_MAX = 60
export const HALF_ENDINGS = /[，、,;；—…\-]$/

// 只去 markdown 强调/列表标记（那不是字），不删字
const cleanMarkup = (s) =>
  String(s || '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s, n = QUOTE_MAX) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n) + '…'
}

/** 从档案里挑"最后一句": 他说的、她说的（优先短的那条：长回复往往是清单） */
export function lastExchanges(dir) {
  const { messages } = readArchive(dir)
  let user = null
  let assistant = null
  let fallbackAssistant = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const text = typeof m.text === 'string' ? m.text : ''
    if (!text) continue
    if (m.role === 'user' && !user) user = cleanMarkup(text)
    if (m.role === 'assistant') {
      const clean = cleanMarkup(text)
      if (!fallbackAssistant) fallbackAssistant = clean
      if (!assistant && clean.length <= 200) assistant = clean
    }
    if (user && assistant) break
  }
  if (!assistant) assistant = fallbackAssistant
  return { user, assistant }
}

/** 拼纸条内容（纯函数，返回 markdown 文本） */
export function renderWere(dir, { now = new Date(), points = null, gap = null } = {}) {
  const { user, assistant } = lastExchanges(dir)
  const lines = ['# 上次聊到哪儿', '', '> 给"轻唤醒"读的：只有原话与没说完的半句，不写结论。', '', `day: ${localDay(now)}`, '']

  if (user) lines.push(`他最后说：「${clip(user)}」`, '')
  if (assistant) {
    const a = String(assistant).replace(/\s+/g, ' ').trim()
    lines.push(`她最后说：「${clip(a)}」`, '')
    if (HALF_ENDINGS.test(a)) lines.push(`没说完：「${clip(a.slice(-24), 24)}」`, '')
  }

  // 她惦记着的那件事（张力够重才写）
  try {
    const top = rankedQuestions(dir)[0]
    if (top && tensionOf(top, now) >= LINE_MIN_TENSION) lines.push(`她惦记：${clip(top.text, 40)}`, '')
  } catch {
    /* 缺口读不出来就不写这一行 */
  }

  // 最近一条要到期的承诺
  try {
    const pts = points || []
    const due = pts
      .filter((p) => p.due && p.status === 'active' && (p.type === 'promise' || p.type === 'event'))
      .map((p) => ({ p, d: Date.parse(p.due) }))
      .filter((x) => Number.isFinite(x.d))
      .sort((a, b) => a.d - b.d)[0]
    if (due) lines.push(`该办：${clip(due.p.title || due.p.id, 40)}（${String(due.p.due).slice(0, 10)}）`, '')
  } catch {
    /* 没有就到这 */
  }

  if (gap != null && gap >= 6) lines.push(`（他隔了 ${Math.round(gap)} 小时才回来）`, '')

  const text = lines.join('\n').replace(/\s+$/, '') + '\n'
  // 保底：超过 300 字就砍掉"该办/惦记"之后的行，保证人一眼能看完
  if ([...text].length > WERE_MAX_CHARS) {
    const kept = []
    let n = 0
    for (const line of text.split('\n')) {
      if (n + [...line].length + 1 > WERE_MAX_CHARS) break
      kept.push(line)
      n += [...line].length + 1
    }
    return kept.join('\n') + '\n'
  }
  return text
}

/** 写纸条（原子写）。@returns {{path:string, chars:number}} */
export function writeWere(dir, opts = {}) {
  const text = renderWere(dir, opts)
  const path = join(dir, WERE_FILE)
  atomicWriteText(path, text)
  return { path, chars: [...text].length }
}

/** 读纸条（没有就返回空串） */
export function readWere(dir) {
  const path = join(dir, WERE_FILE)
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 纸条是不是今天写的（跨天要重写） */
export function wereIsToday(dir, now = new Date()) {
  const text = readWere(dir)
  if (!text) return false
  const m = /^day:\s*(\S+)$/m.exec(text)
  return Boolean(m && m[1] === localDay(now))
}

/**
 * 什么时候重写：① 没有；② 跨天；③ 他隔了一阵回来（gap ≥ 6 小时）。
 * @returns {{written:boolean, chars:number, reason:string}}
 */
export function maybeWriteWere(dir, { now = new Date(), gap = null, points = [] } = {}) {
  const text = readWere(dir)
  if (!text) {
    const r = writeWere(dir, { now, points, gap })
    return { written: true, chars: r.chars, reason: 'first' }
  }
  if (!wereIsToday(dir, now)) {
    const r = writeWere(dir, { now, points, gap })
    return { written: true, chars: r.chars, reason: 'new-day' }
  }
  if (gap != null && gap >= 6) {
    const r = writeWere(dir, { now, points, gap })
    return { written: true, chars: r.chars, reason: 'back' }
  }
  return { written: false, chars: [...text].length, reason: 'fresh' }
}
