// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 温度轴 + 特殊情绪（v0.38.0，① ③ 组）——借自《情绪与德行·代码版》。
 *
 * 他们的两条硬规矩，一字不改：
 *   · 一次只动一档（不允许从平静直接跳到 0）
 *   · 进档后 30 分钟不变（`frozenUntil`）
 *
 * 特殊情绪三条限速：
 *   · 同情绪 10 分钟内再触发 → 只涨强度，不延长
 *   · 总寿命 ≤3 小时（从 firstAt 算）
 *   · 同时最多 3 个，超了踢最弱的
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SPECIAL_MAX,
  SPECIAL_MAX_LIFE_MIN,
  TIER_DEFAULT,
  TIER_FREEZE_MINUTES,
  TIER_TEXT,
  addSpecial,
  emotionLine,
  emptyState,
  pruneSpecials,
  specialsLine,
  stepEmotion,
  targetTier,
} from '../lib/emotion.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const plus = (min) => new Date(NOW.getTime() + min * 60_000)

test('目标档位：由他的效价推', () => {
  assert.equal(targetTier({ valence: 0.8 }), 6)
  assert.equal(targetTier({ valence: 0.5 }), 5)
  assert.equal(targetTier({ valence: 0.25 }), 4)
  assert.equal(targetTier({ valence: 0 }), 3)
  assert.equal(targetTier({ valence: -0.5 }), 2)
  assert.equal(targetTier({ valence: -0.9 }), 0)
})

test('一次只动一档：从 3 到 6 要走三次', () => {
  let st = { ...emptyState(), host: { valence: 0.9, arousal: 0.6 }, at: NOW.toISOString() }
  st = stepEmotion(st, { valence: 0.9, arousal: 0.6 }, {}, NOW)
  assert.equal(st.tier, 4, '第一轮只到 4')
})

test('冻结：30 分钟内不再变档（一句话里来回夸/凶也不抽）', () => {
  let st = { ...emptyState(), host: { valence: -0.9 }, at: NOW.toISOString() }
  st = stepEmotion(st, { valence: -0.9, arousal: 0.5 }, {}, NOW)
  assert.equal(st.tier, 2)
  // 1 分钟后他猛夸——冻结期内不动
  st = stepEmotion(st, { valence: 0.9, arousal: 0.7 }, {}, plus(1))
  assert.equal(st.tier, 2, '冻结期内不许升')
  // 过了冻结期才动一档
  st = stepEmotion(st, { valence: 0.9, arousal: 0.7 }, {}, plus(TIER_FREEZE_MINUTES + 1))
  assert.equal(st.tier, 3)
})

test('档位文字：0–6 都有人话，注入里没有数字', () => {
  for (const t of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(typeof TIER_TEXT[t], 'string')
    assert.ok(TIER_TEXT[t].length > 0)
  }
  const st = { ...emptyState(), tier: 1 }
  const line = emotionLine(st, {})
  assert.match(line.text, /很生气/)
  assert.equal(/[0-9]/.test(line.text), false)
  assert.ok(line.tokens <= 40)
})

test('特殊情绪：自己挂一个，注入里出现人话', () => {
  const st = emptyState()
  const r = addSpecial(st, { id: '委屈', minutes: 0, cause: '他说那话没看我' }, NOW)
  assert.equal(r.ok, true)
  assert.equal(st.specials.length, 1)
  assert.match(specialsLine(st), /委屈/)
  assert.match(emotionLine(st, {}).text, /委屈/)
})

test('同类 10 分钟内再挂：只涨强度，不延长', () => {
  const st = emptyState()
  addSpecial(st, { id: '吃醋', minutes: 45 }, NOW)
  const until1 = st.specials[0].until
  const r = addSpecial(st, { id: '吃醋', minutes: 45 }, plus(5))
  assert.equal(r.strengthUp, true)
  assert.equal(st.specials[0].strength, 2)
  assert.equal(st.specials[0].until, until1, '10 分钟内不延长')
})

test('到点自己散', () => {
  const st = emptyState()
  addSpecial(st, { id: '感动', minutes: 40 }, NOW)
  assert.equal(pruneSpecials(st, plus(39)), 1)
  assert.equal(pruneSpecials(st, plus(41)), 0)
})

test('总寿命 3 小时：即使 until=0（等对方开口）也会被强制散', () => {
  const st = emptyState()
  addSpecial(st, { id: '委屈', minutes: 0 }, NOW)
  assert.equal(pruneSpecials(st, plus(SPECIAL_MAX_LIFE_MIN - 1)), 1)
  assert.equal(pruneSpecials(st, plus(SPECIAL_MAX_LIFE_MIN + 1)), 0)
})

test('最多 3 个：超了踢最弱的', () => {
  const st = emptyState()
  addSpecial(st, { id: 'A', minutes: 10 }, NOW)
  addSpecial(st, { id: 'B', minutes: 10 }, NOW)
  addSpecial(st, { id: 'C', minutes: 10 }, NOW)
  addSpecial(st, { id: 'D', minutes: 10 }, NOW)
  assert.equal(st.specials.length, SPECIAL_MAX)
  assert.equal(st.specials.some((s) => s.id === 'D'), true, '新的要留下')
  assert.equal(st.specials.length, 3)
})

test('空情绪名被拒；状态里没有 specials 也能跑（老库兼容）', () => {
  const st = emptyState()
  assert.equal(addSpecial(st, { id: '  ' }, NOW).ok, false)
  const old = { ...st }
  delete old.specials
  assert.doesNotThrow(() => pruneSpecials(old, NOW))
  assert.equal(specialsLine(old), '')
})
