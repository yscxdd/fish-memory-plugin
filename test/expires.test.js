// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情境过期 `expires_at`（v0.34.0）——借自"天上鱼"的 `valid_until`。
 *
 * 为什么需要：`invalid_at` 是"**已经**失效"（要人回来改），`expires_at` 是"**将会**失效"。
 * 没有后者，三个月后她还会以为你在加班。
 *
 * 钉住：
 *   ① 合法时间才能写；
 *   ② 底线/承诺不许写（它们没有"到期"）；
 *   ③ 到点自动进遗忘层（理由写"情境过期"），不用人记得；
 *   ④ `pin: hard` 不受影响（钉住的永不让位）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planForget } from '../lib/forget.js'
import { MemoryStore } from '../lib/store.js'
import { readPointFiles, validatePoint } from '../lib/toolkit.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600_000).toISOString()

function point(id, { salience = 2, date, extra = '', type = 'event' } = {}) {
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
status: active
source: []
links: []
${extra}
---

<!-- SUM -->
${id}
<!-- /SUM -->
`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-expires-'))
  for (const d of ['00_core', '20_state', '20_index', '30_points', '31_dormant', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

const base = {
  id: 'M-2026-11-03-001',
  title: 'x',
  quote: null,
  date: '2026-11-03',
  salience: 2,
  type: 'event',
  cluster: '日常',
  status: 'active',
  source: [],
  links: [],
  summary: 'x',
}

test('validatePoint：合法时间通过；非法时间报错', () => {
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: 'x' }]]) }
  assert.equal(validatePoint({ ...base, source: ['msg-1'], expires_at: '2026-11-04T08:00:00Z' }, { archive }).errors.length, 0)
  const bad = validatePoint({ ...base, source: ['msg-1'], expires_at: '明天早上' }, { archive })
  assert.ok(bad.errors.some((e) => e.field === 'expires_at'), JSON.stringify(bad.errors))
})

test('validatePoint：底线/承诺不许写 expires_at', () => {
  const archive = { byId: new Map() }
  const r = validatePoint({ ...base, source: ['msg-1'], type: 'boundary', expires_at: '2026-11-04T08:00:00Z' }, { archive })
  assert.ok(r.errors.some((e) => e.field === 'expires_at'), JSON.stringify(r.errors))
})

test('点到点：expires_at 到点 → 进遗忘层，理由写"情境过期"', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/E.md'), point('M-2026-11-02-001', { date: daysAgo(1), extra: `expires_at: ${hoursFromNow(-2)}` }), 'utf8')
  const { plan } = planForget(dir, { now: NOW })
  const e = plan.find((x) => x.id === 'M-2026-11-02-001')
  assert.equal(e.action, 'dormant', JSON.stringify(e))
  assert.match(e.reason, /情境过期/)
})

test('还没到点的不动（不是"提前忘"）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/E.md'), point('M-2026-11-02-002', { date: daysAgo(1), extra: `expires_at: ${hoursFromNow(6)}` }), 'utf8')
  const e = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2026-11-02-002')
  assert.equal(e.action, 'keep')
})

test('pin: hard 的点即使过期也不让位（钉住的优先）', () => {
  const dir = fixture()
  writeFileSync(
    join(dir, '30_points/E.md'),
    point('M-2026-11-02-003', { date: daysAgo(1), extra: `expires_at: ${hoursFromNow(-2)}\npin: hard` }),
    'utf8',
  )
  const e = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2026-11-02-003')
  assert.equal(e, undefined, '这条不该出现在计划里')
})

test('store 与 toolkit 都认 expires_at（两套映射一致）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/M-2026-11-02-004.md'), point('M-2026-11-02-004', { date: daysAgo(1), extra: `expires_at: ${hoursFromNow(6)}` }), 'utf8')
  const p = readPointFiles(dir, '30_points')[0]
  assert.ok(p.expires_at, 'toolkit 要解析')
  const store = new MemoryStore(dir)
  const sp = store.fullPoint({ id: 'M-2026-11-02-004' })
  assert.ok(sp.expiresAt, 'store 要解析')
  store.dispose()
})
