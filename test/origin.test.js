// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * origin 四分类（v0.28.0）——借"没有卡的鱼"的 experiences 四类：
 *   told 他说的 / chosen 她挑的 / insight 她想通的 / observed 她观察自己
 *
 * 为什么要这一列：我们的点以前只记"内容类型"（event/preference/…），没有"**谁给的**"。
 * 有了它，"她自己的声音"才被数得出来，`soul propose` 挑证据也才分得清
 * "他说的"和"她想通的"——后者才是人格变化的凭据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ORIGINS, normalizeOrigin, validatePoint } from '../lib/toolkit.js'
import { MemoryStore } from '../lib/store.js'
import { selfMaterial } from '../lib/soul.js'

const point = (id, extra = {}) => ({
  id,
  title: 'x',
  quote: null,
  date: '2026-11-01',
  salience: 3,
  type: 'event',
  cluster: '日常',
  status: 'active',
  source: ['msg-1'],
  links: [],
  summary: 'x',
  ...extra,
})

test('四类齐全，且每类有中文标签与权重', () => {
  assert.deepEqual(Object.keys(ORIGINS).sort(), ['chosen', 'insight', 'observed', 'told'])
  assert.equal(ORIGINS.told.label, '他说的')
  assert.equal(ORIGINS.chosen.label, '她挑的')
  assert.equal(ORIGINS.insight.label, '她想通的')
  assert.equal(ORIGINS.observed.label, '她观察自己')
  assert.ok(ORIGINS.insight.weight > ORIGINS.told.weight, '她想通的要比他说的重')
})

test('推导：没写 origin 时按来源推（素材→她挑的，消息→他说的）', () => {
  assert.equal(normalizeOrigin({}, ['msg-1']), 'told')
  assert.equal(normalizeOrigin({}, ['asset:book:asset-abc#L3']), 'chosen')
  assert.equal(normalizeOrigin({}, ['book:book-abc#L3']), 'chosen')
  assert.equal(normalizeOrigin({ origin: 'insight' }, ['msg-1']), 'insight', '写了的优先')
  assert.equal(normalizeOrigin({ origin: 'OBSERVED' }, []), 'observed', '大小写不敏感')
  assert.equal(normalizeOrigin({ origin: '瞎写' }, ['msg-1']), 'told', '非法值退回推导')
})

test('validatePoint：非法 origin 是硬错误', () => {
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: 'x' }]]) }
  const bad = validatePoint(point('M-2026-11-01-001', { origin: 'guess' }), { archive })
  assert.ok(bad.errors.some((e) => e.field === 'origin'), JSON.stringify(bad.errors))
  assert.equal(bad.errors.length, 1)

  const ok = validatePoint(point('M-2026-11-01-002', { origin: 'insight' }), { archive })
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors))
})

test('store 与 toolkit 对 origin 的认知一致（两套映射不能各说各话）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-origin-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    `---\nid: M-2026-11-01-001\ntitle: x\nquote: null\ndate: 2026-11-01\nsalience: 3\ntype: event\ncluster: 日常\nstatus: active\norigin: observed\nsource: []\nlinks: []\n---\n\n<!-- SUM -->\nx\n<!-- /SUM -->\n`,
    'utf8',
  )
  const store = new MemoryStore(dir)
  const p = store.fullPoint({ id: 'M-2026-11-01-001' })
  assert.equal(p.origin, 'observed')
  store.dispose()
})

test('soul 挑证据：她想通的/她观察的排在他说的前面', () => {
  const points = [
    point('M-2026-11-01-001', { origin: 'told', date: '2026-11-01' }),
    point('M-2026-11-01-002', { origin: 'insight', date: '2026-10-01' }),
    point('M-2026-11-01-003', { origin: 'observed', date: '2026-09-01' }),
  ]
  const picked = selfMaterial('/tmp', points, 3).map((p) => p.origin)
  assert.deepEqual(picked.slice(0, 2).sort(), ['insight', 'observed'], `实际 ${picked.join(',')}`)
})
