// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 她得知道"今天是哪天"（v0.64.0，A）。
 *
 * 为什么重要：她要记住生日、约定、纪念日，却**没有任何绝对时间来源**——
 * 注入里只有"你上次来是今天"这种相对说法（`presence.js`），问她"今天几号"她答不出。
 *
 * 为什么放在**状态块**：
 *   核心层是稳定前缀（99.5% 缓存命中靠它字节不变，v0.61 有测试钉着）；
 *   状态块本来就每轮可能变，时间挂在这里**不损失任何缓存**。
 *
 * 钉住：
 *   ① 时间行格式固定（不带秒、不带"凌晨/深夜"这种会被她当表演素材的形容）；
 *   ② 本地时区（三时区跑）；
 *   ③ **核心层（前缀）里仍然不含时间**——这条最容易被将来的人破坏；
 *   ④ 状态块预算够放（60 → 80）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nowLine } from '../lib/store.js'
import { assemble, DEFAULT_BUDGET } from '../lib/render.js'
import { estTokens } from '../lib/util.js'

test('时间行格式：今天是 YYYY-MM-DD 周X HH:MM（不带秒）', () => {
  const s = nowLine(new Date(2026, 10, 6, 1, 8, 0))
  assert.equal(s, '今天是 2026-11-06 周五 01:08')
  assert.doesNotMatch(s, /\d{2}:\d{2}:\d{2}/, '不该带秒')
  assert.doesNotMatch(s, /凌晨|深夜|早上/, '不该带会被当表演素材的时段词')
})

test('时间行：坏日期不炸，回落到"现在"', () => {
  const s = nowLine(new Date('nope'))
  assert.match(s, /^今天是 \d{4}-\d{2}-\d{2} 周[日一二三四五六] \d{2}:\d{2}$/)
})

test('周一/周日 的星期字对得上（最容易差一位）', () => {
  assert.match(nowLine(new Date(2026, 10, 2, 9, 0)), /周一/) // 2026-11-02 是周一
  assert.match(nowLine(new Date(2026, 10, 8, 9, 0)), /周日/) // 2026-11-08 是周日
})

test('核心层（前缀）里仍然不含时间——缓存靠它字节不变', () => {
  // 假 store 的状态块要**跟着传进来的 now 走**，否则测不出"状态块每轮变"。
  let current = new Date(2026, 10, 6, 1, 8)
  const store = {
    coreParts: () => [{ name: 'soul', text: '她不会说"作为一个AI"。' }],
    coreStatus: () => `【我们现在】常态。\n${nowLine(current)}`,
    index: () => '',
    points: () => [],
    state: () => ({ tick: 1 }),
    memoryWeight: () => 1,
    fullPoint: (p) => p,
    session: () => null,
    previousSession: () => null,
    markWorkInjected: () => {},
  }
  const early = assemble({ store, query: '在吗', now: current })
  current = new Date(2026, 10, 6, 23, 40)
  const late = assemble({ store, query: '在吗', now: current })

  // 状态块（含时间）会变……
  assert.notEqual(early.text, late.text, '状态块里的时间该每轮变')
  // ……但核心层那段不能变（它在状态块之前）。这里按"今天是"切：那句话只该出现在状态块里。
  const coreOf = (s) => s.split('今天是')[0]
  assert.equal(coreOf(early.text), coreOf(late.text), '核心层必须保持字节稳定')
  assert.doesNotMatch(coreOf(late.text), /今天是/)
})

test('状态块预算 80 够放"状态 + 时间"', () => {
  assert.equal(DEFAULT_BUDGET.status, 80)
  const sample = '【我们现在】常态。\n' + nowLine(new Date(2026, 10, 6, 1, 8))
  assert.ok(estTokens(sample) <= DEFAULT_BUDGET.status, `实测 ${estTokens(sample)} tok`)
})
