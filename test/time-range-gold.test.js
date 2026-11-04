// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 相对时间窗（v0.49.0，A3）+ 金标 pass^k（C3）。
 *
 * 钉住：
 *   ① 时间窗按**本地日期**算，不是 UTC（差 8 小时会把"今天"算到昨天）；
 *   ② 中文数字也要认（"最近三天""两周前"）；
 *   ③ 解不出就返回 null，**不要猜**——猜错会把无关的点拉上来；
 *   ④ 加权不过滤：窗外 ×0.8，窗内 ×1.25，没日期的不动；
 *   ⑤ pass^k 用固定种子，同一版本跑两次结果必须一致。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cnNumber, inRange, parseTimeRange, rangeWeight } from '../lib/time.js'
import { goldStability, perturb } from '../scripts/gold-stability.mjs'

const NOW = new Date(2026, 10, 4, 22, 0, 0) // 2026-11-04 周三，本地时间
const d = (dt) => dt.toLocaleDateString('zh-CN')

test('中文数字', () => {
  assert.equal(cnNumber('三'), 3)
  assert.equal(cnNumber('十'), 10)
  assert.equal(cnNumber('十二'), 12)
  assert.equal(cnNumber('两'), 2)
  assert.equal(cnNumber('三十'), 30)
  assert.equal(cnNumber('7'), 7)
  assert.equal(cnNumber('什么'), null)
})

test('时间窗：上周三 / 上周 / 今天 / 昨天', () => {
  assert.equal(parseTimeRange('上周三聊的那个', NOW).label, '上周三')
  const wed = parseTimeRange('上周三', NOW)
  assert.deepEqual([wed.from.getDate(), wed.from.getMonth() + 1], [28, 10], '上周三应是 2026-10-28')

  const week = parseTimeRange('上周那个事', NOW)
  assert.equal(d(week.from), '2026/10/26', '上周从周一开始')
  assert.equal(d(week.to), '2026/11/1')

  assert.equal(d(parseTimeRange('今天', NOW).from), '2026/11/4')
  assert.equal(d(parseTimeRange('昨天', NOW).from), '2026/11/3')
  assert.equal(d(parseTimeRange('大前天', NOW).from), '2026/11/1')
})

test('时间窗：最近 N / N 前 / 上个月（中文数字也认）', () => {
  assert.equal(d(parseTimeRange('最近三天', NOW).from), '2026/11/1')
  assert.equal(d(parseTimeRange('最近一周', NOW).from), '2026/10/28')
  assert.equal(d(parseTimeRange('两周前', NOW).from), '2026/10/21')
  assert.equal(d(parseTimeRange('3天前', NOW).from), '2026/11/1')
  assert.equal(d(parseTimeRange('上个月', NOW).from), '2026/10/1')
  assert.equal(d(parseTimeRange('上个月', NOW).to), '2026/10/31')
})

test('解不出就不猜', () => {
  for (const q of ['他膝盖疼', '那个文件在哪', '今天天气不错']) {
    if (q === '今天天气不错') continue // 这个确实含"今天"，会解出窗
    assert.equal(parseTimeRange(q, NOW), null, q)
  }
})

test('加权：窗内 ×1.25 · 窗外 ×0.8 · 没日期不动 · 不过滤', () => {
  const range = parseTimeRange('上周三', NOW)
  assert.equal(rangeWeight({ date: '2026-10-28' }, range), 1.25)
  assert.equal(rangeWeight({ date: '2026-11-04' }, range), 0.8)
  assert.equal(rangeWeight({ date: null }, range), 1)
  assert.equal(inRange({ date: null }, range), null)
})

test('pass^k：固定种子，同参数跑两次结果一致', () => {
  const a = goldStability({ repeat: 3, jitter: 0.05 })
  const b = goldStability({ repeat: 3, jitter: 0.05 })
  assert.deepEqual(a.detail, b.detail)
  assert.deepEqual(a.runs.map((r) => r.threshold), b.runs.map((r) => r.threshold))
})

test('pass^k：i=0 是基线（不扰动），其余在阈值上有抖动', () => {
  const base = perturb(0, { threshold: 0.8 })
  assert.equal(base.threshold, 0.8)
  assert.deepEqual(base.weights, { title: 3, tags: 3, cluster: 1, summary: 1, unigram: 1 })
  const j1 = perturb(1, { threshold: 0.8 })
  assert.notEqual(j1.threshold, 0.8)
})

test('pass^k：当前金标在 ±5% 扰动下 20/20 稳定', () => {
  const r = goldStability({ repeat: 4, jitter: 0.05 })
  assert.equal(r.detail.length, 20)
  assert.equal(r.stable, 20, `不稳的有：${r.worst.map((w) => `${w.query}(${w.hits}/${w.of})`).join('、')}`)
  assert.equal(r.alwaysMiss, 0)
})
