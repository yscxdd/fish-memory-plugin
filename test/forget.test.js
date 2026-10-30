// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 遗忘测试：公式 / 两步转换 / 墓碑 / 底线保护。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyForget, initialStability, planForget, retrievability } from '../lib/forget.js'
import { readPointFiles } from '../lib/toolkit.js'

function point(id, { salience = 2, status = 'active', date, pinned = false, type = 'event' } = {}) {
  return `---
id: ${id}
title: ${id}
quote: null
date: ${date}
salience: ${salience}
type: ${type}
cluster: 测试
event: null
tags: []
status: ${status}
source: []
links: []
${pinned ? 'pinned: true' : ''}
---

<!-- SUM -->
${id}
<!-- /SUM -->
`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-forget-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  writeFileSync(join(dir, '20_state/state.json'), '{}')
  return dir
}

const NOW = new Date('2026-10-30T00:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

test('R(t,S)：t=0 为 1，随时间单调下降', () => {
  assert.equal(retrievability(7, 0), 1)
  assert.ok(retrievability(7, 90) < retrievability(7, 30))
  assert.ok(Math.abs(retrievability(7, 90) - 0.499) < 0.01)
  assert.equal(initialStability(2), 7)
  assert.equal(initialStability(5), 16)
})

test('plan：active 90 天 → demote；demoted 200 天 → dormant；pinned 不动', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-07-01-001', { salience: 2, date: daysAgo(120) }))
  writeFileSync(
    join(dir, '30_points/B.md'),
    point('M-2026-03-01-002', { salience: 1, status: 'demoted', date: daysAgo(240) }),
  )
  writeFileSync(
    join(dir, '30_points/C.md'),
    point('M-2026-07-01-003', { salience: 1, date: daysAgo(240), pinned: true, type: 'boundary' }),
  )
  writeFileSync(join(dir, '30_points/D.md'), point('M-2026-10-20-004', { salience: 2, date: daysAgo(10) }))

  const { plan } = planForget(dir, { now: NOW })
  const by = Object.fromEntries(plan.map((x) => [x.id, x]))
  assert.equal(by['M-2026-07-01-001'].action, 'demote')
  assert.equal(by['M-2026-03-01-002'].action, 'dormant')
  assert.equal(by['M-2026-10-20-004'].action, 'keep')
  assert.equal(by['M-2026-07-01-003'], undefined, 'pinned/boundary 不参与计划')
})

test('apply：改 status、写墓碑含数值、索引重建、S 落 state', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-07-01-001', { salience: 2, date: daysAgo(120) }))
  const { changed } = applyForget(dir, { now: NOW })
  assert.equal(changed, 1)

  const p = readPointFiles(dir, '30_points')[0]
  assert.equal(p.status, 'demoted')

  const tomb = readFileSync(join(dir, '50_log/eviction.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(tomb.length, 1)
  assert.equal(tomb[0].point, 'M-2026-07-01-001')
  assert.equal(tomb[0].action, 'demote')
  assert.equal(typeof tomb[0].R, 'number')
  assert.equal(typeof tomb[0].S, 'number')

  const state = JSON.parse(readFileSync(join(dir, '20_state/state.json'), 'utf8'))
  assert.equal(state['M-2026-07-01-001'].S, 7)
  assert.equal(state['M-2026-07-01-001'].st, 'demoted')

  assert.equal(existsSync(join(dir, '20_index/all.idx.jsonl')), true)
})

test('apply：没有可动的点时不写墓碑', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-10-20-001', { salience: 3, date: daysAgo(5) }))
  const r = applyForget(dir, { now: NOW })
  assert.equal(r.changed, 0)
  assert.equal(existsSync(join(dir, '50_log/eviction.log')), false)
})
