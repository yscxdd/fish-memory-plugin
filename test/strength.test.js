// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyReview, initialS, nextReview, retrievability, weight } from '../lib/strength.js'

test('六维：R 单调下降，arousal 抬初始强度', () => {
  assert.equal(retrievability(7, 0), 1)
  assert.ok(retrievability(7, 90) < retrievability(7, 30))
  assert.equal(initialS(2), 7)
  assert.equal(initialS(2, 0.9), 12.6)
})

test('复习点：R=0.9 时约等于 S 天', () => {
  assert.ok(Math.abs(nextReview(7, 0.9) - 7) < 0.2)
})

test('权重：强（近、常提、有链接、高显著）> 弱', () => {
  const now = Date.now()
  const strong = weight(
    { salience: 5, date: new Date(now).toISOString(), event: 'E1', links: ['a', 'b', 'c'] },
    { S: 16, r: 3, ll: new Date(now).toISOString() },
    now,
  )
  const weak = weight({ salience: 1, date: new Date(now - 400 * 86400000).toISOString() }, { S: 4, r: 0 }, now)
  assert.ok(strong > weak, `${strong} vs ${weak}`)
  assert.ok(strong <= 1 && weak >= 0)
})

test('applyReview：提到则 S↑、D↓、r+1', () => {
  const next = applyReview({ S: 7, D: 6, r: 1 }, 0.5, { mentioned: true })
  assert.equal(next.S, 8.05)
  assert.equal(next.D, 5.5)
  assert.equal(next.r, 2)
  assert.ok(next.ll)
})
