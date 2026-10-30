// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 检索的局部行为。**金标不在这里**——20 条查询 + 6 条负例统一放在
 * `lib/goldset.js`，由 `test/gold.test.js` 与 `memory gold` 共用一份，
 * 免得"测试里一套、命令行里另一套"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bigrams, isGated, overlap, pickByEvent, rankHybrid } from '../lib/retrieve.js'

test('别名只影响检索，不改原文', () => {
  const p = {
    id: 'M1',
    title: '台风天看海',
    tags: ['台风'],
    aliases: ['海边', '看海'],
    cluster: '出行',
    salience: 4,
    date: '2026-10-20',
    summary: '台风夜去海边。',
  }
  const top = rankHybrid([p], '海边', { threshold: 0.3 })
  assert.equal(top.length, 1)
  assert.deepEqual(p.aliases, ['海边', '看海'], '检索不能写回 aliases')
  assert.deepEqual(p.tags, ['台风'], '检索不能把 aliases 并进 tags 本体')
})

test('重合率除以较小集合：长查询不该因为查询变长而稀释', () => {
  // 契约 §14 第 4 条：overlap = |Q∩P| / min(|Q|,|P|)
  // 若按 |Q| 除，短字段里的强信号会被长查询稀释成 0.09；按 min 除是 0.25。
  const q = bigrams('晚上想吃点什么，别带香菜的')
  const p = bigrams('他讨厌香菜')
  assert.equal(overlap(q, p), 0.25)
  const point = { id: 'M', title: '他讨厌香菜', tags: ['香菜', '忌口'], aliases: [], cluster: '偏好', salience: 3, summary: '' }
  assert.equal(rankHybrid([point], '晚上想吃点什么，别带香菜的', { threshold: 0.8 }).length, 1, '长查询仍应命中')
})

test('门控：嗯 / 在吗 这类不触发检索', () => {
  for (const q of ['嗯', '在吗', '哈哈哈', '好的', '？']) assert.equal(isGated(q), true, q)
  assert.equal(isGated('上次台风天你去海边了吗'), false)
})

test('事件簇：同 event 只留分最高的一条，没有 event 用 id 当自己那条', () => {
  const mk = (id, score, event) => ({ point: { id, event }, score })
  const ranked = [mk('A', 5, 'E1'), mk('B', 4, 'E1'), mk('C', 3, 'E2'), mk('D', 2, null)]
  const picked = pickByEvent(ranked, 3)
  assert.deepEqual(picked.map((p) => p.id), ['A', 'C', 'D'])
})
