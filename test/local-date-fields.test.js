// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 裸日期字段的时区（v0.54.0，H5）。
 *
 * 语义（**沿用现有代码，不新发明**）：`invalid_at` / `expires_at` 是"从这一刻起失效"的**瞬间**；
 * 裸日期就按**本地那天的 00:00** 算。真正的 bug 是它以前按 UTC 00:00 算：
 * +08:00 下差 8 小时看不出来，**UTC-5 下变成前一天 19:00** → 前一天晚上就判失效。
 *
 * 这些断言全部用**本地时间**构造 now，所以在任何时区跑都必须过
 * （`npm run test:tz` 三个时区各跑一遍）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TIME_FUTURE, TIME_PAST, timeBucket } from '../lib/time.js'
import { duePoints } from '../lib/remind.js'

test('valid_from 是裸日期：当天就是当天（不提前一天变「计划」）', () => {
  const p = { date: '2026-11-01', valid_from: '2026-11-05' }
  assert.notEqual(timeBucket(p, new Date(2026, 10, 5, 12, 0, 0)), TIME_FUTURE, '当天不该是「计划」')
  assert.equal(timeBucket(p, new Date(2026, 10, 4, 12, 0, 0)), TIME_FUTURE, '前一天才是「计划」')
})

test('expires_at 是裸日期：从前一天晚上不该算「已过期」', () => {
  const p = { date: '2026-11-01', expires_at: '2026-11-05' }
  // 关键断言：11-04 23:00（本地）还没到 11-05，绝不能算过期。
  // 旧代码按 UTC 解析，UTC-5 下 11-05T00:00Z = 11-04T19:00 本地 → 这一条会红。
  assert.notEqual(timeBucket(p, new Date(2026, 10, 4, 23, 0, 0)), TIME_PAST, '前一天晚上不该过期')
  assert.equal(timeBucket(p, new Date(2026, 10, 5, 0, 30, 0)), TIME_PAST, '到期日 00:00 起才过期')
})

test('invalid_at 是裸日期：同样从前一天晚上不该算「已失效」', () => {
  const p = { date: '2026-11-01', invalid_at: '2026-11-05' }
  assert.notEqual(timeBucket(p, new Date(2026, 10, 4, 23, 30, 0)), TIME_PAST)
  assert.equal(timeBucket(p, new Date(2026, 10, 5, 9, 0, 0)), TIME_PAST)
})

test('due 是裸日期：当天到期是「今天」，不是「逾期一天」', () => {
  const point = { id: 'M1', title: '答应他的事', type: 'promise', due: '2026-11-05', status: 'active' }
  const rows = duePoints([point], new Date(2026, 10, 5, 10, 0, 0))
  assert.equal(rows.length, 1, '当天到期应该被提醒')
  assert.equal(rows[0].days, 0, `当天应是 0 天，实际 ${rows[0].days}`)
})

test('due 是裸日期：前一天晚上不该算「逾期」', () => {
  const point = { id: 'M1', title: '答应他的事', type: 'promise', due: '2026-11-05', status: 'active' }
  const rows = duePoints([point], new Date(2026, 10, 4, 23, 0, 0))
  const row = rows.find((r) => r.id === 'M1')
  assert.ok(row, '前一天晚上也该在提醒窗口里（明天到期）')
  assert.equal(row.days, 1, `前一天应是 1 天（明天），实际 ${row.days}`)
})
