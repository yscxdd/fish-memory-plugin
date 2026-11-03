// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪按真实小时补算（v0.37.0，① 组）——借自《AI伙伴运行机制》的"醒来先补算一次"。
 *
 * 我们的问题：`stepEmotion` 是**按轮**衰减的，没有任何定时任务。
 * 他隔 19 小时回来，她的情绪会停在 19 小时前的那个点上——
 * "昨天的低落"被当成了"现在还在低落"。
 *
 * 钉住：
 *   ① 只收**超出死区**的那部分（0.04），小起伏不被磨平；
 *   ② 每小时收 5%，最多按 36 小时算；
 *   ③ **只往底色收，永不越过底色**，也不清到 0；
 *   ④ 不足一刻钟不补算（同一轮里连算没意义）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DRIFT_DEADZONE, DRIFT_MAX_HOURS, DRIFT_PER_HOUR, applyDrift, emptyState, stepEmotion } from '../lib/emotion.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString()

const withState = (valence, arousal, h) => ({
  ...emptyState(),
  at: hoursAgo(h),
  ai: { valence, arousal },
})

test('1 小时收 5%（超出死区的那部分）', () => {
  const st = withState(-0.8, 0.9, 1)
  applyDrift(st, {}, NOW)
  const excess = -0.8 - 0 // 底色 0
  assert.ok(Math.abs(st.ai.valence - (0 + excess * (1 - DRIFT_PER_HOUR))) < 0.01, `实际 ${st.ai.valence}`)
  assert.equal(st.driftHours, 1)
})

test('19 小时：从 -0.8 收到大约 -0.3（不被一次抹平）', () => {
  const st = withState(-0.8, 0.9, 19)
  applyDrift(st, {}, NOW)
  assert.ok(st.ai.valence > -0.45 && st.ai.valence < -0.2, `实际 ${st.ai.valence}`)
})

test('封顶 36 小时：100 小时和 36 小时结果一样', () => {
  const a = withState(-0.9, 0.9, 36)
  const b = withState(-0.9, 0.9, 100)
  applyDrift(a, {}, NOW)
  applyDrift(b, {}, NOW)
  assert.equal(a.ai.valence, b.ai.valence)
  assert.equal(b.driftHours, DRIFT_MAX_HOURS)
})

test('死区：偏离不到 0.04 就不动（日常小起伏留着）', () => {
  const st = withState(DRIFT_DEADZONE * 0.5, 0.5 + DRIFT_DEADZONE * 0.5, 10)
  applyDrift(st, {}, NOW)
  assert.equal(st.ai.valence, DRIFT_DEADZONE * 0.5)
})

test('只往底色收，永不越过：正的不会变负，也不清到 0', () => {
  const st = withState(0.6, 0.8, 19)
  applyDrift(st, {}, NOW)
  assert.ok(st.ai.valence > 0, `应当还在底色之上，实际 ${st.ai.valence}`)
  assert.ok(st.ai.valence < 0.6)
})

test('不足一刻钟：不补算（同一轮里连算没意义）', () => {
  const st = withState(-0.8, 0.9, 0.1)
  const r = applyDrift(st, {}, NOW)
  assert.equal(r, 0)
  assert.equal(st.ai.valence, -0.8)
})

test('stepEmotion 会先补算：19 小时没说话，起点已经落回去了', () => {
  const prev = withState(-0.8, 0.9, 19)
  const next = stepEmotion(prev, { valence: 0, arousal: 0.5 }, {}, NOW)
  assert.ok(next.ai.valence > -0.5, `补算后应接近底色，实际 ${next.ai.valence}`)
  assert.equal(next.driftHours, 19)
})

test('没有 at（新状态）：不补算，不炸', () => {
  const st = { ...emptyState(), at: null, ai: { valence: -0.5, arousal: 0.5 } }
  assert.equal(applyDrift(st, {}, NOW), 0)
  assert.equal(st.ai.valence, -0.5)
})
