// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * token 账（《本地模型与 Token 预算设计》§10.2，v0.18.0）。
 *
 * 为什么测：那句"没有记账的优化等于没优化"——你只会"感觉变快了"，
 * 然后某天质量掉了却找不到是哪一刀砍的。
 *
 * 这组钉三件：分块数对得上总数、按天过滤、坏行不许把汇总弄崩。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendTokenLog, readTokenLog, summarizeTokenLog } from '../lib/toklog.js'
import { DEFAULT_BUDGET, assemble } from '../lib/render.js'
import { estTokens } from '../lib/util.js'

const store = ({ core = '# SOUL\n\n- 不给人建议', status = '' } = {}) => ({
  coreParts: () => [{ name: 'soul', text: core }],
  coreStatus: () => status,
  index: () => ({ clusters: [], recent: [] }),
  points: () => [],
  session: () => null,
  previousSession: () => null,
  markWorkInjected: () => {},
  state: () => ({ tick: 1 }),
  injectionCount: () => 0,
})

test('assemble 返回分块 token，且加起来对得上总数', () => {
  const r = assemble({ store: store({ status: '【我们现在】常态。' }), budget: DEFAULT_BUDGET, retrieve: () => [] })
  assert.ok(r.tokens.total > 0)
  assert.equal(r.tokens.total, estTokens(r.text))
  assert.ok(r.tokens.core > 0 && r.tokens.status > 0 && r.tokens.header > 0)

  // 分块之和不超过总数（块之间还有分隔符，总数只会更大）
  const sum = Object.entries(r.tokens)
    .filter(([k]) => k !== 'total')
    .reduce((n, [, v]) => n + v, 0)
  assert.ok(sum <= r.tokens.total, `分块和 ${sum} 应 ≤ 总数 ${r.tokens.total}`)
})

test('记两轮 → 读得回来，均值和分块都算得对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tok-'))
  const now = new Date('2026-10-31T22:00:00+08:00')
  appendTokenLog(dir, { turn: 1, mode: 'daily', gate: 'hit', core: 300, index: 100, body: 50, total: 500, rendered: 2 }, now)
  appendTokenLog(dir, { turn: 2, mode: 'task', gate: 'skip', core: 300, index: 0, body: 150, total: 700, rendered: 3 }, now)

  const { rows } = readTokenLog(dir, { days: 7, now })
  assert.equal(rows.length, 2)

  const s = summarizeTokenLog(dir, { days: 7, now })
  assert.equal(s.turns, 2)
  assert.equal(s.avg, 600)
  assert.equal(s.max, 700)
  assert.equal(s.gated, 1)
  assert.deepEqual(s.modes, { daily: 1, task: 1 })
  assert.equal(s.blocks.core.avg, 300)
  assert.equal(s.blocks.body.avg, 100)
  assert.equal(s.by_day.length, 1)
  assert.equal(s.by_day[0].turns, 2)
})

test('按天过滤：7 天外的账不算进汇总', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tok2-'))
  const now = new Date('2026-10-31T22:00:00+08:00')
  appendTokenLog(dir, { turn: 1, total: 999 }, new Date(now.getTime() - 30 * 86_400_000))
  appendTokenLog(dir, { turn: 2, total: 400 }, now)
  const s = summarizeTokenLog(dir, { days: 7, now })
  assert.equal(s.turns, 1)
  assert.equal(s.avg, 400)
})

test('坏行跳过，不把汇总弄崩（审计里能看到 bad_lines）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tok3-'))
  appendTokenLog(dir, { turn: 1, total: 300 }, new Date())
  mkdirSync(join(dir, '50_log'), { recursive: true })
  // 手写两行：一行合法（缺 at 也算坏行，见下）、一行根本不是 JSON
  const at = new Date().toISOString()
  writeFileSync(join(dir, '50_log/token.log'), `{"at":"${at}","turn":2,"total":300}\nnot-json\n`, {
    encoding: 'utf8',
    flag: 'a',
  })
  const s = summarizeTokenLog(dir, { days: 7 })
  assert.equal(s.turns, 2, '一条是 append 写的、一条是手写的合法行')
  assert.equal(s.bad_lines, 1)
  assert.equal(s.avg, 300)
})
