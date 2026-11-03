// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 时间轴（v0.40.0，① 组）——补 `valid_from`。
 *
 * 原来只有三样：`date`（发生日）、`invalid_at`（**已经**失效）、`expires_at`（**将会**失效）。
 * 缺的是"**从什么时候开始成立**"。
 *
 * 没有它的后果：隔两个月翻到「我下个月要去广州」，分不清这是**计划**还是**已完成**。
 *
 * 钉住：
 *   ① 三个桶：current / past / future；
 *   ② 只有非"现在"的才在注入里打标（[过去] / [计划]），现在的不标（省 token）；
 *   ③ 问过去就偏过去、问将来就偏将来、没问就偏现在（乘 0.6，不过滤）；
 *   ④ `valid_from` 晚于 `invalid_at` 是硬错误（还没开始就失效）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TIME_CURRENT, TIME_FUTURE, TIME_PAST, queryIntent, timelineCounts, timeBucket, timeLabel, timeMarker, timeWeight } from '../lib/time.js'
import { renderPoint } from '../lib/render.js'
import { validatePoint } from '../lib/toolkit.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const at = (s) => new Date(s).toISOString()

test('三个桶：现在 / 过去 / 计划', () => {
  assert.equal(timeBucket({ date: '2026-11-01' }, NOW), TIME_CURRENT)
  assert.equal(timeBucket({ date: '2026-11-01', invalid_at: at('2026-11-02') }, NOW), TIME_PAST)
  assert.equal(timeBucket({ date: '2026-11-01', expires_at: at('2026-11-02') }, NOW), TIME_PAST)
  assert.equal(timeBucket({ date: '2026-11-01', valid_from: at('2026-12-01') }, NOW), TIME_FUTURE)
  assert.equal(timeBucket({ valid_from: '2026-10-01' }, NOW), TIME_CURRENT, '没有 date 就用 valid_from')
})

test('标记：只有过去/计划才带，现在的不带', () => {
  assert.equal(timeMarker(TIME_CURRENT), '')
  assert.equal(timeMarker(TIME_PAST), '[过去]')
  assert.equal(timeMarker(TIME_FUTURE), '[计划]')
  assert.equal(timeLabel(TIME_FUTURE), '计划')
})

test('注入：过去的点带 [过去]，计划带 [计划]', () => {
  const past = renderPoint({ date: '2026-10-01', title: '那次台风', invalid_at: at('2026-10-02') }, 'idx')
  assert.match(past, /\[过去\]/)
  const future = renderPoint({ date: '2026-11-01', title: '下月去广州', valid_from: at('2026-12-01') }, 'idx')
  assert.match(future, /\[计划\]/)
  const now = renderPoint({ date: '2026-11-01', title: '今天下雨' }, 'idx')
  assert.doesNotMatch(now, /\[过去\]|\[计划\]/)
})

test('他这句话在问哪个时间段', () => {
  assert.equal(queryIntent('上次那个台风你还记得吗'), TIME_PAST)
  assert.equal(queryIntent('我们下次去哪'), TIME_FUTURE)
  assert.equal(queryIntent('今天吃什么'), null)
})

test('时间权重：问过去偏过去；没问偏现在；不过滤', () => {
  const past = { date: '2026-10-01', invalid_at: at('2026-10-02') }
  const cur = { date: '2026-11-01' }
  assert.equal(timeWeight(cur, null, NOW), 1)
  assert.equal(timeWeight(past, null, NOW), 0.85)
  assert.equal(timeWeight(past, TIME_PAST, NOW), 1.1)
  assert.equal(timeWeight(cur, TIME_PAST, NOW), 1, '问过去也不把现在压成 0')
  assert.ok(timeWeight(past, TIME_PAST, NOW) > timeWeight(cur, TIME_PAST, NOW))
})

test('timelineCounts：三个桶都数得到', () => {
  const c = timelineCounts(
    [
      { date: '2026-11-01' },
      { date: '2026-10-01', invalid_at: at('2026-10-02') },
      { date: '2026-11-01', valid_from: at('2026-12-01') },
    ],
    NOW,
  )
  assert.deepEqual(c, { current: 1, past: 1, future: 1 })
})

test('validatePoint：valid_from 必须是合法时间；晚于 invalid_at 是错误', () => {
  const base = {
    id: 'M-2026-11-03-001',
    title: 'x',
    quote: null,
    date: '2026-11-03',
    salience: 2,
    type: 'event',
    cluster: '日常',
    status: 'active',
    source: ['msg-1'],
    links: [],
    summary: 'x',
  }
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: 'x' }]]) }
  assert.equal(validatePoint({ ...base, valid_from: '2026-11-01' }, { archive }).errors.length, 0)
  assert.ok(validatePoint({ ...base, valid_from: '明天' }, { archive }).errors.some((e) => e.field === 'valid_from'))
  const bad = validatePoint({ ...base, valid_from: '2026-11-05', invalid_at: '2026-11-04' }, { archive })
  assert.ok(bad.errors.some((e) => e.field === 'valid_from'))
})
