// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 难题组（v0.50.0，C1 小步）。
 *
 * 主金标是 20/20——一把测不出任何改进的尺子。这组题**允许它输**，当前 6/10。
 *
 * 钉住：
 *   ① 判定顺序：top-1 对就是 hit，哪怕错条也在候选里（候选含错条很正常）；
 *      只有"top-1 给了错条"才算 bad——那比 miss 更糟，因为她答了一个错的事；
 *   ② 时序两题必须 hit：这是 A3 时间窗的**端到端**证据（不只是解析层的单测）；
 *   ③ 同义一题必须 miss（"关节不舒服"对"膝盖疼"）——这是别名的活，证明缺口真实存在；
 *   ④ 否定题现在会答错（"讨厌香菜吗" → 命中"他讨厌香菜"）——**记录在案**，不遮掩；
 *   ⑤ 日期相对 now 生成，题目不随真实日期过期。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHardSet } from '../lib/goldhard.js'
import { runHard } from '../scripts/gold-hard.mjs'
import { retrievalWeight } from '../lib/rank.js'

test('题目结构：四类都在，日期相对 now', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const { points, queries } = buildHardSet(now)
  assert.equal(points.length, 11)
  assert.equal(queries.length, 10)
  const cats = new Set(queries.map((q) => q.category))
  assert.deepEqual([...cats].sort(), ['同义', '否定', '指代', '时序'].sort())
  // 日期都早于 now
  for (const p of points) assert.ok(Date.parse(p.date) < now.getTime(), p.id)
})

test('跑分：当前 7/10（会输的尺子）', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const r = runHard({ now })
  assert.equal(r.total, 10)
  assert.equal(r.hit, 7, `实际 ${r.hit}/10：${r.rows.map((x) => x.query + '→' + x.got).join(' | ')}`)
})

test('时序两题必须 hit——这是 A3 时间窗的端到端证据', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const r = runHard({ now })
  const t1 = r.rows.find((x) => x.query.includes('上周三'))
  const t2 = r.rows.find((x) => x.query.includes('最近三天'))
  assert.equal(t1.verdict, 'hit', '"上周三"应命中 T1（8 天前那条），而不是文字更像的 T2')
  assert.equal(t2.verdict, 'hit', '"最近三天"应命中 T2（昨天那条）')
  assert.ok(t1.range && t1.range.includes('上周'), '要解出时间窗')
})

test('同义确实会空：这是别名的活，不是打分的活', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const r = runHard({ now })
  const syn = r.rows.find((x) => x.query === '关节不舒服')
  assert.equal(syn.verdict, 'miss', '字面完全不重合，本来就该空')
  assert.equal(syn.ids.length, 0)
})

test('否定题现在会答错——记录下来，不遮掩', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const r = runHard({ now })
  const neg = r.rows.find((x) => x.category === '否定')
  assert.equal(neg.verdict, 'bad', '当前会答成"他讨厌香菜"那条：否定词读反')
  assert.deepEqual(neg.badHit, ['N2'])
})

test('判定顺序：top-1 对就算 hit，哪怕错条也在候选里', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const r = runHard({ now })
  const t3 = r.rows.find((x) => x.expect === 'T3')
  // T3 那条不一定 hit，但无论如何不该被记成 bad（bad 只给 top-1 是错条的情况）
  assert.notEqual(t3.verdict, 'bad')
})

test('权重单源：rank.retrievalWeight 与线上同一条链', () => {
  const p = { date: '2026-10-28', cluster: '日常', tags: [] }
  const plain = retrievalWeight(p, {})
  assert.equal(plain, 1)
  const range = { from: new Date(2026, 9, 28, 0, 0, 0), to: new Date(2026, 9, 28, 23, 59, 59), label: '上周三' }
  assert.equal(retrievalWeight(p, { range }), 1.25)
  assert.equal(retrievalWeight({ date: '2026-11-04', cluster: '日常', tags: [] }, { range }), 0.8)
})


test('尺子不许随时刻漂：凌晨和深夜跑，结果必须一样', () => {
  const midnight = runHard({ now: new Date(2026, 10, 5, 1, 0, 0) })
  const late = runHard({ now: new Date(2026, 10, 5, 23, 30, 0) })
  assert.equal(midnight.hit, late.hit, '差 8 小时就变，说明日期格式化又用了 UTC')
})
