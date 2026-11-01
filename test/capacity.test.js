// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 从"遗忘补丁"（孔月，2026-11-01）借来的三条（v0.29.1）：
 *
 *   ① 容量上限（他们有 maxLines=200）：我们只有"索引层 700 tok"的隐式上限，
 *      超了是降级显示而不是淘汰 → 加 MAX_ACTIVE，超了按最低 R 下沉到遗忘层。
 *   ② `(已取代)` 优先忘（他们的 supersededStabilityDays=14）：
 *      我们 `invalid_at` 根本没进遗忘逻辑 → 标了失效的点还占着位置。
 *   ③ `--recall` 先搜（他们的两段式）：我们只有 `revive <id>`，没法按关键词找。
 *
 * 不抄的三条也写在文档里：行式 memory.md / R<0.1 才忘 / 内容 hash 当身份。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_ACTIVE, SUPERSEDED_MIN_AGE_DAYS, findDormant, planForget } from '../lib/forget.js'

const NOW = new Date('2026-11-01T00:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

function point(id, { salience = 2, date, invalid_at = null, extra = '' } = {}) {
  return `---
id: ${id}
title: ${id}
quote: null
date: ${date}
salience: ${salience}
type: event
cluster: 测试
event: null
tags: []
status: active
source: []
links: []
${invalid_at ? `invalid_at: ${invalid_at}` : ''}
${extra}
---

<!-- SUM -->
${id}
<!-- /SUM -->
`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-superseded-'))
  for (const d of ['00_core', '20_state', '20_index', '30_points', '31_dormant', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

test('已取代：invalid_at 满 7 天 → 直接进遗忘层（不听 R）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/S.md'), point('M-2026-10-20-001', { date: daysAgo(20), invalid_at: daysAgo(10) }), 'utf8')
  const { plan } = planForget(dir, { now: NOW })
  const s = plan.find((x) => x.id === 'M-2026-10-20-001')
  assert.equal(s.action, 'dormant')
  assert.match(s.reason, /已取代/)
})

test('已取代：刚标失效（不满 7 天）先留着', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/S.md'), point('M-2026-10-30-001', { date: daysAgo(2), invalid_at: daysAgo(1) }), 'utf8')
  const s = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2026-10-30-001')
  assert.equal(s.action, 'keep', `满 ${SUPERSEDED_MIN_AGE_DAYS} 天才让位`)
})

test('容量上限：active 超 MAX_ACTIVE 时，按最低 R 下沉（保护类除外）', () => {
  const dir = fixture()
  const n = MAX_ACTIVE + 5
  for (let i = 0; i < n; i++) {
    const id = `M-2026-10-01-${String(i).padStart(3, '0')}`
    // 全部 20 天：R 都一样，所以"谁被下沉"不该由顺序决定——只验数量
    writeFileSync(join(dir, '30_points/' + id + '.md'), point(id, { date: daysAgo(20) }), 'utf8')
  }
  // 一条底线类：永不被容量规则挤掉
  writeFileSync(
    join(dir, '30_points/B.md'),
    point('M-2026-10-01-999', { date: daysAgo(400), extra: 'pin: hard' }).replace('type: event', 'type: boundary'),
    'utf8',
  )

  const { plan, capEvicted } = planForget(dir, { now: NOW })
  assert.ok(capEvicted >= 5, `至少下沉 5 条，实际 ${capEvicted}`)
  assert.equal(plan.find((x) => x.id === 'M-2026-10-01-999'), undefined, 'pin hard/boundary 不参与')

  const leftActive = plan.filter((x) => x.status === 'active' && x.action === 'keep').length
  assert.ok(leftActive <= MAX_ACTIVE, `active 应压到 ${MAX_ACTIVE} 以内，实际 ${leftActive}`)
  const reasons = plan.filter((x) => x.action === 'dormant' && /超上限/.test(x.reason)).length
  assert.ok(reasons >= 5)
})

test('findDormant：按关键词找（只读），能按标题/正文命中', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/A.md'), point('M-2026-06-01-001', { date: daysAgo(200) }).replace('title: M-2026-06-01-001', 'title: 很久以前看海'), 'utf8')
  writeFileSync(join(dir, '31_dormant/B.md'), point('M-2026-06-02-002', { date: daysAgo(200) }).replace('title: M-2026-06-02-002', 'title: 第一次做饭'), 'utf8')

  const hits = findDormant(dir, '看海')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'M-2026-06-01-001')
  assert.equal(findDormant(dir, '').length, 0, '空关键词不返回')
  assert.equal(findDormant(dir, '不存在的词').length, 0)
})
