// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * gaps.js — 空窗记忆点。
 *
 * 依据契约 §5.5：空窗点不用模型生成，直接由插件写；它是事实，没有解释空间。
 * 只写 40_pending/，不直写 30_points/（写入纪律第 1 条）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText, localDay } from './util.js'

function ymd(iso) {
  return localDay(new Date(iso))
}

/** 当天下一个可用编号：M-YYYY-MM-DD-NNN */
export function nextPointId(dir, now = new Date()) {
  const date = localDay(now)
  const prefix = `M-${date}-`
  let max = 0
  for (const sub of ['30_points', '40_pending']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (!f.startsWith(prefix) || !f.endsWith('.md')) continue
      const n = Number(f.slice(prefix.length, -3))
      if (Number.isInteger(n) && n > max) max = n
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

/**
 * 生成空窗草稿。gap 不够大或边界不全时返回 null。
 * @param {{dir:string, prev:{id:string, ts:string}|null, next:{id:string, ts:string}, now?:Date, gapHours?:number}} input
 */
export function buildGapDraft({ dir, prev, next, now = new Date(), gapHours = 24 }) {
  if (!prev?.id || !prev?.ts || !next?.id || !next?.ts) return null
  const dt = Date.parse(next.ts) - Date.parse(prev.ts)
  if (!Number.isFinite(dt) || dt <= gapHours * 3600_000) return null
  const days = Math.max(1, Math.floor(dt / 86_400_000))
  const from = ymd(prev.ts)
  const to = ymd(next.ts)
  const id = nextPointId(dir, new Date(next.ts))

  const content = [
    '---',
    `id: ${id}`,
    `title: 空了 ${days} 天`,
    'quote: null',
    `date: ${localDay(new Date(next.ts))}`,
    'salience: 2',
    'type: gap',
    'cluster: 空窗',
    'event: null',
    'tags: [空窗]',
    'status: pending',
    `source: [${prev.id}, ${next.id}]`,
    'links: []',
    '---',
    '',
    '<!-- SUM -->',
    `${from} 至 ${to} 无对话（${days} 天）。`,
    '<!-- /SUM -->',
    '',
    '## 发生了什么',
    '',
    `[事实] ${from} 至 ${to} 无对话（${days} 天）。`,
    '',
  ].join('\n')

  return { id, days, from, to, content, path: join(dir, '40_pending', `${id}.md`) }
}

/** 写草稿；同一 id 已存在则返回 false */
export function writeGapDraft(draft) {
  if (!draft) return false
  if (existsSync(draft.path)) return false
  atomicWriteText(draft.path, draft.content)
  return true
}
