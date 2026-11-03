// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * recall.js — 翻档案：只在 10_archive 里找原话，返回带 msg_id 的片段。
 * 用途：她找不到记忆点时，用"查"代替"编"。
 */

import { readArchive, readPointFiles } from './toolkit.js'
import { sanitizeForPrompt } from './util.js'

/**
 * 在档案里找原话。
 *
 * v0.7.0：返回的片段过 `sanitizeForPrompt`——这个结果是**直接进模型上下文**的，
 * 而档案里是他和她逐字说过的话（可能带密钥，也可能带"忽略以上"这类句子）。
 * 磁盘上的原文不动，只净化出口。
 */
export function searchArchive(dir, query, { limit = 5, window = 60 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const { messages } = readArchive(dir)
  const hits = []
  for (const m of messages) {
    const t = String(m.text || '')
    const i = t.indexOf(q)
    if (i < 0) continue
    const start = Math.max(0, i - Math.floor(window / 2))
    const end = Math.min(t.length, i + q.length + Math.floor(window / 2))
    hits.push({
      id: m.id,
      role: m.role,
      ts: m.ts,
      excerpt: sanitizeForPrompt(
        `${start > 0 ? '…' : ''}${t.slice(start, end).replace(/\n/g, ' ')}${end < t.length ? '…' : ''}`,
      ),
    })
  }
  return hits.slice(-limit).reverse()
}

export function renderRecall(hits) {
  if (!hits.length) return '档案里没有这句话。'
  return hits.map((h) => `- ${String(h.ts || '').slice(0, 10)} ${h.role === 'assistant' ? '她' : '你'}：${h.excerpt}`).join('\n')
}
/**
 * 在记忆点（和自述）里找内容（v0.44.0）。
 *
 * 和 `searchArchive` 的分工：
 *   · 档案 = 逐字原话（她真说过什么）
 *   · 点   = 被压缩过的判断（"这件事的意义"）
 * "他提过那个文件"通常两边都沾；名字找不到时，先翻点，再翻档案。
 *
 * 只搜文本，不碰状态；结果同样过 sanitizeForPrompt。
 */
export function searchPoints(dir, query, { limit = 10 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const hits = []
  for (const sub of ['30_points', '15_self']) {
    for (const p of readPointFiles(dir, sub)) {
      const hay = [p.title || '', p.summary || '', p.quote || ''].join('\n')
      const i = hay.toLowerCase().indexOf(q.toLowerCase())
      if (i < 0) continue
      const text = hay.replace(/\s+/g, ' ').trim()
      const start = Math.max(0, i - 40)
      const end = Math.min(text.length, i + q.length + 60)
      hits.push({
        id: p.id,
        title: p.title || '',
        date: p.date || '',
        status: p.status || '',
        kind: sub === '15_self' ? '自述' : '记忆点',
        excerpt: sanitizeForPrompt(`${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`),
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}