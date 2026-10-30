// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * recall.js — 翻档案：只在 10_archive 里找原话，返回带 msg_id 的片段。
 * 用途：她找不到记忆点时，用"查"代替"编"。
 */

import { readArchive } from './toolkit.js'
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
