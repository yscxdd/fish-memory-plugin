// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 第二轮遗忘：purge（v0.30）。
 *
 * 规则（"按你的建议来"）：
 *   · 只删**从没被复活过**的（resurrections > 0 永远留着）
 *   · 层内待满 PURGE_DAYS=180 天，或 R<PURGE_R=0.2
 *   · 一次最多 PURGE_BATCH=10 条
 *   · 墓碑（eviction.log）带 S/R/年龄 + **残片 ≤12 字**
 *   · `32_purged/index.md` 一行一条，方便日后 grep "有没有记过"
 *   · **档案 10_archive 一个字不动**
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FRAGMENT_MAX, PURGE_BATCH, PURGE_DAYS, applyForget, fragmentOf, planForget } from '../lib/forget.js'

const NOW = new Date('2026-11-01T00:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

function dormantPoint(id, { title = id, summary = '一件早就过去的小事', resurrections = 0, dormantDays = 200 } = {}) {
  return `---
id: ${id}
title: ${title}
quote: null
date: ${daysAgo(400)}
salience: 2
type: event
cluster: 日常
event: null
tags: []
status: dormant
dormant_at: ${new Date(NOW.getTime() - dormantDays * 86_400_000).toISOString()}
dormant_reason: 第一轮
resurrections: ${resurrections}
source: []
links: []
---

<!-- SUM -->
${summary}
<!-- /SUM -->
`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-purge-'))
  for (const d of ['00_core', '10_archive', '10_archive/messages', '20_state', '20_index', '30_points', '31_dormant', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  writeFileSync(join(dir, '10_archive/messages/0001.jsonl'), '{"id":"msg-1","text":"原始对话"}\n', 'utf8')
  return dir
}

test('第二轮：层内满 180 天 → purge；墓碑带残片（≤12 字）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/O.md'), dormantPoint('M-2025-09-01-001', { dormantDays: PURGE_DAYS + 1 }), 'utf8')

  const p = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2025-09-01-001')
  assert.equal(p.action, 'purge', JSON.stringify(p))
  assert.match(p.reason, /第二轮/)
  assert.ok(p.fragment.length <= FRAGMENT_MAX + 1, `残片应 ≤${FRAGMENT_MAX} 字（带省略号）：${p.fragment}`)

  applyForget(dir, { now: NOW })
  assert.equal(existsSync(join(dir, '31_dormant/O.md')), false, '点文件要真的删掉')

  const tomb = readFileSync(join(dir, '50_log/eviction.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop()
  assert.equal(tomb.action, 'purge')
  assert.equal(typeof tomb.R, 'number')
  assert.equal(typeof tomb.S, 'number')
  assert.equal(typeof tomb.age, 'number')
  assert.ok(tomb.fragment && tomb.fragment.length <= FRAGMENT_MAX + 1)

  const index = readFileSync(join(dir, '32_purged/index.md'), 'utf8')
  assert.match(index, /2026-11-01 \| M-2025-09-01-001 \|/)
  assert.match(index, /一件早就过去的小事|一件早就过去的/)

  // 档案一个字不动（这是"敢删"的前提）
  assert.equal(readFileSync(join(dir, '10_archive/messages/0001.jsonl'), 'utf8'), '{"id":"msg-1","text":"原始对话"}\n')
})

test('复活过的永不 purge', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/R.md'), dormantPoint('M-2025-09-01-002', { resurrections: 1, dormantDays: 400 }), 'utf8')
  const p = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2025-09-01-002')
  assert.equal(p, undefined, '复活过的点不该出现在 purge 计划里')
})

test('刚进层的不 purge（层内天数不够）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/F.md'), dormantPoint('M-2025-09-01-003', { dormantDays: 10 }), 'utf8')
  const p = planForget(dir, { now: NOW }).plan.find((x) => x.id === 'M-2025-09-01-003')
  assert.equal(p, undefined)
})

test('一次最多删 10 条（PURGE_BATCH）', () => {
  const dir = fixture()
  for (let i = 0; i < PURGE_BATCH + 5; i++) {
    const id = `M-2025-09-01-1${String(i).padStart(2, '0')}`
    writeFileSync(join(dir, '31_dormant/' + id + '.md'), dormantPoint(id, { dormantDays: PURGE_DAYS + 1 }), 'utf8')
  }
  const purges = planForget(dir, { now: NOW }).plan.filter((x) => x.action === 'purge')
  assert.equal(purges.length, PURGE_BATCH, `一次最多 ${PURGE_BATCH} 条，实际 ${purges.length}`)
})

test('fragmentOf：长摘要截到 12 字并加省略号；空摘要给空串', () => {
  const long = fragmentOf({ summary: '很早就过去的一件小事，细节已经模糊。' })
  assert.ok(long.endsWith('…'))
  assert.equal([...long].length, FRAGMENT_MAX + 1)
  assert.equal(fragmentOf({ summary: '' }), '')
})
