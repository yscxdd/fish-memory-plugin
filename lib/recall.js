// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * recall.js — 翻档案：只在 10_archive 里找原话，返回带 msg_id 的片段。
 * 用途：她找不到记忆点时，用"查"代替"编"。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readArchive, readPointFiles } from './toolkit.js'
import { sanitizeData, sanitizeForPrompt } from './util.js'

/**
 * 在档案里找原话。
 *
 * v0.7.0：返回的片段过 `sanitizeForPrompt`——这个结果是**直接进模型上下文**的，
 * 而档案里是他和她逐字说过的话（可能带密钥，也可能带"忽略以上"这类句子）。
 * 磁盘上的原文不动，只净化出口。
 */
/**
 * 解析过的旧日文件缓存（P1）。键 = 文件绝对路径，值 = { mtimeMs, size, records }。
 *
 * 为什么只缓存"旧"的：今天的文件一直在追加，缓存它等于每次都读旧快照。
 * 判断"今天是哪天"用本地日期——和分文件时用的口径一致。
 */
const JSONL_CACHE = new Map()
const CACHE_MAX = 64

function cachedRecords(file, isToday) {
  try {
    const st = statSync(file)
    if (isToday) return null
    const hit = JSONL_CACHE.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records
    const records = []
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 坏行跳过：审计会报，检索不该因此失败 */
      }
    }
    if (JSONL_CACHE.size >= CACHE_MAX) JSONL_CACHE.clear()
    JSONL_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, records })
    return records
  } catch {
    return null
  }
}

/** 当前本地日期（YYYY-MM-DD）——和 archive 分文件的口径一致 */
function todayYmd(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function searchArchive(dir, query, { limit = 5, window = 60, scope = null } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  // P1：倒着扫（文件名即日期），够 limit 就停；旧文件用 mtime 缓存跳过重复解析。
  const hits = []
  const msgDir = join(dir, '10_archive', 'messages')
  const files = (() => {
    try {
      return readdirSync(msgDir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
    } catch {
      return []
    }
  })()
  const today = todayYmd()
  const pools = []
  if (files.length) {
    for (const f of files) {
      const isToday = f.startsWith(today)
      const recs = cachedRecords(join(msgDir, f), isToday)
      if (recs) {
        pools.push(recs)
        continue
      }
      // 今天的文件（或缓存坏了）：走读全库的老路，但只读这一个文件
      try {
        const recs = []
        for (const line of readFileSync(join(msgDir, f), 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue
          try {
            recs.push(JSON.parse(line))
          } catch {
            /* skip */
          }
        }
        pools.push(recs)
      } catch {
        /* 读不出来就跳过这个文件 */
      }
    }
  } else {
    pools.push(readArchive(dir).messages)
  }

  const NEED = Math.max(limit * 4, 20) // 多攒一点再做时间排序，避免边界抖动
  outer: for (const messages of pools) for (const m of messages) {
    if (hits.length >= NEED) break outer
    // R2（审计 v0781）：档案也要认作用域。老记录没有 scope → 当主人私聊。
    if (scope) {
      const s = m.scope || 'dm:master'
      if (s !== scope && s !== 'global') continue
    }
    const t = String(m.text || '')
    const i = t.indexOf(q)
    if (i < 0) continue
    const start = Math.max(0, i - Math.floor(window / 2))
    const end = Math.min(t.length, i + q.length + Math.floor(window / 2))
    hits.push({
      id: m.id,
      role: m.role,
      ts: m.ts,
      // N1（审计 v0782）：档案原话是**最大的"别人说过的话"**，标题也要拆。
      // 以前靠 `replace(/\n/g, ' ')` 把换行压掉才没出事——那是巧合，不是设计。
      excerpt: sanitizeData(
        `${start > 0 ? '…' : ''}${t.slice(start, end).replace(/\n/g, ' ')}${end < t.length ? '…' : ''}`,
      ),
    })
  }
  // P1：倒着扫，所以最新的命中在**后面**；凑够 limit 之后再多攒一点再停没有意义，
  // 这里保持原来的语义（取最后 limit 条，按时间倒序）。
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
      // B5（评审 v0.80.1）：indexOf 在 hay 上找、切片却对折叠空白后的 text 做——
      // 两个坐标不一致，命中靠后时摘录会切偏（关键词可能不在摘录里）。
      // 现在**先折叠再找**，两步用同一份字符串。
      const hay = [p.title || '', p.summary || '', p.quote || ''].join(' ').replace(/\s+/g, ' ')
      const text = hay.trim()
      const i = Math.max(0, text.toLowerCase().indexOf(q.toLowerCase()))
      if (text.toLowerCase().indexOf(q.toLowerCase()) < 0) continue
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