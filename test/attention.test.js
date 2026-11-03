// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 注意力加权（v0.41.0，② 组）——借自 digital-life-core 的 `memory-affinity`。
 *
 * 他们：按情绪（皮质醇）把记忆分 `crisis | daily | neutral`，危机 ×3、日常 ×0.1。
 * 我们：**情绪层和检索是两条平行线**——她压力大时，检索不会偏向"危机"那类事。
 *
 * 钉住：
 *   ① 分类靠标签/簇（零依赖），不靠语义；
 *   ② 只在她"有压力"时加权；平静时全部 1（不偏袒）；
 *   ③ 只乘分数不过滤（×0.1 的点仍然能被搜到）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CRISIS_WEIGHT,
  DAILY_WEIGHT,
  attentionCounts,
  attentionMultiplier,
  classifyAttention,
  isStressed,
  stressFromEmotion,
} from '../lib/attention.js'

test('分类：危机 / 日常 / 中性', () => {
  assert.equal(classifyAttention({ cluster: '危机', tags: [] }), 'crisis')
  assert.equal(classifyAttention({ cluster: '日常', title: '吵架了' }), 'crisis', '标题里出现也算')
  assert.equal(classifyAttention({ cluster: '日常', tags: ['吃饭'] }), 'daily')
  assert.equal(classifyAttention({ cluster: '学习', title: '读完一本书' }), 'neutral')
})

test('压力判定：档位 ≤2 或他的效价 ≤ -0.5', () => {
  assert.equal(isStressed({ tier: 2 }), true)
  assert.equal(isStressed({ tier: 3 }), false)
  assert.equal(isStressed({ valence: -0.6 }), true)
  assert.equal(isStressed({ valence: -0.2 }), false)
  assert.equal(isStressed({}), false)
})

test('平静时不偏袒：全 1', () => {
  for (const k of ['crisis', 'daily', 'neutral']) assert.equal(attentionMultiplier(k, { stress: false }), 1)
})

test('有压力时：危机 ×3、日常 ×0.1、中性 1', () => {
  assert.equal(attentionMultiplier('crisis', { stress: true }), CRISIS_WEIGHT)
  assert.equal(attentionMultiplier('daily', { stress: true }), DAILY_WEIGHT)
  assert.equal(attentionMultiplier('neutral', { stress: true }), 1)
})

test('从情绪状态读压力（读不到就当没压力）', () => {
  assert.equal(stressFromEmotion({ tier: 1 }), true)
  assert.equal(stressFromEmotion({ tier: 4, host: { valence: 0.6 } }), false)
  assert.equal(stressFromEmotion({ tier: 4, host: { valence: -0.7 } }), true)
  assert.equal(stressFromEmotion(null), false)
})

test('三类计数（audit 用）', () => {
  const c = attentionCounts([
    { cluster: '危机' },
    { cluster: '日常', tags: ['吃饭'] },
    { cluster: '学习' },
  ])
  assert.deepEqual(c, { crisis: 1, daily: 1, neutral: 1 })
})
