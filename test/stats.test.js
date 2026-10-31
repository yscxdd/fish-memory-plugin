// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 真实账（v0.24.0）：`memory stats`。
 *
 * 阈值 0.8、预算 1700、情绪迟滞带……这些数字以前全靠拍。日志里其实已经有数据，
 * 这一版把它们加起来。钉四件事：
 *   ① 口径正确：`gate=skip`（query 没进来/纯语气）与 `rendered>0`（真命中）是两回事；
 *   ② 分层占比可读（core/header/…）；
 *   ③ 成本换算只用均值 × 单价，**不含对话历史与输出**（别把账算到插件头上）；
 *   ④ 明细只读日志，不写任何文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assetUsage, computeStats, estimateCost } from '../lib/stats.js'

const NOW = new Date('2026-11-01T00:00:00Z')
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString()

function fixture({ tokenRows = [], retrievalRows = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-stats-'))
  mkdirSync(join(dir, '50_log'), { recursive: true })
  writeFileSync(join(dir, '50_log', 'token.log'), tokenRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, '50_log', 'retrieval.log'), retrievalRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return dir
}

const T = (over = {}) => ({ at: at(1), total: 412, header: 82, core: 319, status: 6, footer: 5, turn: 0, mode: 'daily', gate: 'hit', rendered: 0, dropped: 0, ...over })
const R = (over = {}) => ({ at: at(1), gated: false, mode: 'daily', rendered: [], dropped: [], coreDropped: [], tokens: 412, ms: { retrieve: 1, total: 4 }, ...over })

test('均值/中位/峰值与分层占比', () => {
  const dir = fixture({
    tokenRows: [T({ total: 400, core: 300 }), T({ total: 600, core: 500 }), T({ total: 500, core: 400 })],
  })
  const s = computeStats(dir, { days: 7, now: NOW })
  assert.equal(s.turns, 3)
  assert.equal(s.injection.mean, 500)
  assert.equal(s.injection.median, 500)
  assert.equal(s.injection.max, 600)
  assert.equal(s.injection.layers.core, 400)
  assert.equal(s.injection.layers.header, 82)
})

test('门控与命中分开算：skip 不算命中，rendered 非空才算', () => {
  const dir = fixture({
    tokenRows: [T({ gate: 'skip' }), T({ gate: 'hit' }), T({ gate: 'hit' })],
    retrievalRows: [
      R({ gated: true }),
      R({ rendered: ['M-1'] }),
      R({ rendered: ['M-1', 'M-2'] }),
      R({ dropped: ['M-3'], coreDropped: ['M-4'] }),
    ],
  })
  const s = computeStats(dir, { days: 7, now: NOW })
  assert.equal(s.gate.skipped, 1)
  assert.equal(s.retrieval.gated, 1)
  assert.equal(s.retrieval.hits, 2)
  assert.equal(s.retrieval.hitPct, 50)
  assert.equal(s.retrieval.avgRendered, 1.5)
  assert.equal(s.retrieval.dropped, 1)
  assert.equal(s.retrieval.coreDropped, 1)
  assert.equal(s.retrieval.msMean, 4)
})

test('天数过滤：窗口外的行不算；坏行跳过不炸', () => {
  const dir = fixture({
    tokenRows: [T({ at: at(1) }), T({ at: at(24 * 10) })],
  })
  writeFileSync(join(dir, '50_log', 'token.log'), 'not json\n' + JSON.stringify(T({ at: at(1) })), 'utf8')
  const s = computeStats(dir, { days: 7, now: NOW })
  assert.equal(s.turns, 1, '10 天前的那行要被过滤掉，坏行要跳过')
})

test('空库：全 0，不抛', () => {
  const dir = fixture()
  const s = computeStats(dir, { days: 7, now: NOW })
  assert.equal(s.turns, 0)
  assert.equal(s.injection.mean, 0)
  assert.equal(s.retrieval.msMean, null)
})

test('成本换算：只按注入均值 × 单价，且明说口径', () => {
  const c = estimateCost({ mean: 412 }, { yuanPerMTok: 4, turnsPerDay: 100 })
  assert.ok(Math.abs(c.perTurn - 0.001648) < 1e-6)
  assert.ok(Math.abs(c.perDay - 0.1648) < 1e-6)
  assert.equal(c.turnsPerDay, 100)
})

test('assetUsage：从点里数素材，没被引用的素材显示 0 条', () => {
  const books = {
    'asset-a': { id: 'asset-a', title: '雨夜', kind: 'book' },
    'asset-b': { id: 'asset-b', title: '方案', kind: 'doc' },
  }
  const points = [
    { id: 'p1', source: ['asset:book:asset-a#L3'] },
    { id: 'p2', source: ['asset:book:asset-a#L9'] },
    { id: 'p3', source: ['msg-1'] },
  ]
  const rows = assetUsage(points, books)
  const a = rows.find((r) => r.id === 'asset-a')
  const b = rows.find((r) => r.id === 'asset-b')
  assert.equal(a.points, 2)
  assert.equal(b.points, 0)
  assert.ok(rows[0].points >= rows[1].points, '按点数降序')
})

test('只读：跑完 stats 不写任何文件', () => {
  const dir = fixture({ tokenRows: [T()], retrievalRows: [R()] })
  const before = readdirSync(join(dir, '50_log')).join(',')
  computeStats(dir, { days: 7, now: NOW })
  assert.equal(readdirSync(join(dir, '50_log')).join(','), before)
})
