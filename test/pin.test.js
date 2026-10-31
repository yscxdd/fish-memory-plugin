// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * pin 两档（v0.25.0）—— 从 vMem 的 `mlock` hard/soft 语义借来的那一条。
 *
 *   pin: hard  = 老的 `pinned: true`：永不降级、永不丢弃、永不遗忘（底线、承诺）
 *   pin: soft  = 重要但**可以被压缩**：那一轮挤不下时降成摘要，但不会被遗忘、不会被普通点挤掉
 *
 * 钉住四件事：
 *   ① 老写法 `pinned: true` 仍然等于 hard（不逼用户改历史）；
 *   ② 预算紧张时：soft 排在普通点之前占位，普通点先被丢；
 *   ③ soft **不会被遗忘**（forget 里也算 isProtected）——"留着她会想不起来"和"她忘了"是两回事；
 *   ④ 非法 pin 值是硬错误（不静默降级成普通点）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isProtected as forgetProtected } from '../lib/forget.js'
import { layoutBody, isProtected, isSoftPinned, depthOf } from '../lib/render.js'
import { MemoryStore } from '../lib/store.js'
import { normalizePin, validatePoint } from '../lib/toolkit.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-pin-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  return dir
}

const pointFile = (meta, body = '正文') => `---
id: ${meta.id || 'M-2026-11-01-001'}
title: ${meta.title || '标题'}
quote: null
date: 2026-11-01
salience: ${meta.salience ?? 3}
type: ${meta.type || 'event'}
cluster: 测试
event: null
tags: []
status: active
source: []
links: []
${meta.pinned ? 'pinned: true' : ''}
${meta.pin ? `pin: ${meta.pin}` : ''}
---

<!-- SUM -->
摘要
<!-- /SUM -->

${body}
`

test('解析：pinned: true = hard；pin: soft 单独成立；两者冲突按 hard', () => {
  assert.equal(normalizePin({ pinned: true }), 'hard')
  assert.equal(normalizePin({ pin: 'soft' }), 'soft')
  assert.equal(normalizePin({ pin: 'HARD' }), 'hard')
  assert.equal(normalizePin({}), null)

  const dir = tmp()
  writeFileSync(join(dir, '30_points/P1.md'), pointFile({ id: 'P1', pinned: true }), 'utf8')
  writeFileSync(join(dir, '30_points/P2.md'), pointFile({ id: 'P2', pin: 'soft' }), 'utf8')
  const store = new MemoryStore(dir)
  const [p1, p2] = ['P1', 'P2'].map((id) => store.fullPoint({ id }))
  assert.equal(p1.pin, 'hard')
  assert.equal(p1.pinned, true)
  assert.equal(p2.pin, 'soft')
  assert.equal(p2.pinned, false, 'soft 不是 pinned（pinned 仍表示"永不降级"）')
  store.dispose()
})

test('protect：hard 永不降级；soft 可压缩但不是"受保护"', () => {
  assert.equal(isProtected({ pin: 'hard' }), true)
  assert.equal(isProtected({ pinned: true }), true)
  assert.equal(isProtected({ pin: 'soft' }), false, 'soft 允许被降档')
  assert.equal(isSoftPinned({ pin: 'soft' }), true)
  assert.equal(depthOf({ pin: 'soft', salience: 1 }), 'full', '平时还是全文')
})

test('预算紧张：soft 排在普通点前面占位，普通点先被丢', () => {
  const big = '很长的正文'.repeat(120)
  const soft = { id: 'S', pin: 'soft', salience: 2, title: '软钉', type: 'event', date: '2026-11-01', summary: '摘要', raw: big }
  const normal = { id: 'N', pin: null, salience: 5, title: '普通', type: 'event', date: '2026-11-01', summary: '摘要', raw: big }
  const r = layoutBody([normal, soft], { budget: 120 })
  assert.ok(r.rendered.includes('S'), `soft 应当先占位，实际 rendered=${JSON.stringify(r.rendered)}`)
})

test('遗忘：soft 也不会被遗忘（≠ 会降级）', () => {
  assert.equal(forgetProtected({ pin: 'soft', type: 'event' }), true)
  assert.equal(forgetProtected({ pin: 'hard', type: 'event' }), true)
  assert.equal(forgetProtected({ pin: null, type: 'event' }), false)
})

test('validatePoint：非法 pin 值 = 硬错误；pinned+soft 冲突 = 警告', () => {
  const base = {
    id: 'M-2026-11-01-001',
    title: 'x',
    date: '2026-11-01',
    salience: 3,
    type: 'event',
    cluster: '测试',
    status: 'active',
    source: ['msg-sample-001'],
    links: [],
    summary: 'x',
    quote: '',
  }
  const bad = validatePoint({ ...base, pin: 'forever' }, { archive: { byId: new Map() } })
  assert.ok(bad.errors.some((e) => e.field === 'pin'), JSON.stringify(bad.errors))

  const conflict = validatePoint({ ...base, pin: 'soft', pinned: true }, { archive: { byId: new Map() } })
  assert.equal(conflict.errors.length, 0)
  assert.ok(conflict.warnings.some((w) => w.field === 'pin'), JSON.stringify(conflict.warnings))
})
