#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 难题组跑分（v0.50.0）。和主金标共用 `rankHybrid` + `lib/rank.js` 的权重合成，
 * 所以这里跑的就是线上那套（v0.50.0 把权重抽成单源就是为了这个）。
 *
 * 计分：
 *   hit   = top-1 就是期望那条
 *   near  = 期望的在前 3（但没 top-1）
 *   miss  = 期望的根本没进来
 *   bad   = 命中了 `mustNot`（比 miss 更糟：给了错的那条）
 */

import { buildHardSet } from '../lib/goldhard.js'
import { rankHybrid } from '../lib/retrieve.js'
import { retrievalWeight } from '../lib/rank.js'
import { parseTimeRange, queryIntent } from '../lib/time.js'

/**
 * @param {{now?:Date, threshold?:number, limit?:number}} [opts]
 */
export function runHard({ now = new Date(), threshold = 0.5, limit = 3 } = {}) {
  const { points, queries } = buildHardSet(now)
  const rows = []
  let hit = 0
  let near = 0
  let miss = 0
  let bad = 0

  for (const q of queries) {
    const range = parseTimeRange(q.query, now)
    const intent = queryIntent(q.query)
    const ranked = rankHybrid(points, q.query, {
      threshold,
      limit,
      // 和 index.js 同一个函数、同一套参数（无压力、无记忆强度）
      weight: (p) => retrievalWeight(p, { intent, range, stress: false, memoryWeight: 1 }),
    })
    const ids = ranked.map((r) => r.point.id)
    const top = ids[0] || null
    const forbidden = q.mustNot || []
    // 判定顺序很重要：top-1 对，就是 hit——哪怕错条也进了候选（候选里有它很正常）
    // 只有"top-1 给了错条"才算 bad（那比 miss 更糟：她答了一个错的事）
    let verdict = 'miss'
    let badHit = []
    if (top === q.expect) {
      verdict = 'hit'
      hit += 1
    } else if (top && forbidden.includes(top)) {
      verdict = 'bad'
      badHit = [top]
      bad += 1
    } else if (ids.includes(q.expect)) {
      verdict = 'near'
      near += 1
    } else {
      miss += 1
    }
    rows.push({
      query: q.query,
      category: q.category,
      expect: q.expect,
      got: top,
      ids,
      verdict,
      badHit,
      range: range ? `${range.label}` : null,
    })
  }

  const byCategory = {}
  for (const r of rows) {
    const c = (byCategory[r.category] ||= { total: 0, hit: 0, near: 0, miss: 0, bad: 0 })
    c.total += 1
    c[r.verdict] += 1
  }

  const total = rows.length
  return {
    total,
    hit,
    near,
    miss,
    bad,
    rate: total ? hit / total : 0,
    byCategory,
    rows,
  }
}

if (process.argv[1] && process.argv[1].endsWith('gold-hard.mjs')) {
  const r = runHard()
  console.log(`难题组：${r.hit}/${r.total} top-1（${Math.round(r.rate * 100)}%）· 近 3 ${r.near} · 未进 ${r.miss} · 命中错条 ${r.bad}`)
  for (const [cat, c] of Object.entries(r.byCategory)) {
    console.log(`  ${cat}：${c.hit}/${c.total} top-1` + (c.bad ? ` · 错条 ${c.bad}` : '') + (c.near ? ` · 近 3 ${c.near}` : ''))
  }
  console.log('')
  for (const row of r.rows) {
    const mark = row.verdict === 'hit' ? '✓' : row.verdict === 'near' ? '~' : row.verdict === 'bad' ? '✗错条' : '✗'
    console.log(`  ${mark.padEnd(4)} ${row.query} → ${row.got ?? '空'}（期望 ${row.expect}）${row.range ? ' · 窗 ' + row.range : ''}`)
  }
  process.exit(0)
}
