// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪字段（总设计 §5.2 第 11 项，v0.18.0）。
 *
 * 三个"必须成立"：
 *   ① **两种写法都认**——缩进块（设计文档 §4.2 的样子）与单行 JSON；
 *   ② **只有 `user` 侧进遗忘权重**（审计清单 #12：用旁白情绪驱动遗忘是自我矛盾）；
 *   ③ **写错要报错，不 clamp**——把 valence 写成 3.0 还当没事，等于账本失真。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeEmotion, parseFrontMatter } from '../lib/util.js'
import { arousalFor, initialS } from '../lib/strength.js'
import { renderPoint } from '../lib/render.js'
import { scanPointFiles, validatePoint } from '../lib/toolkit.js'

const NESTED = `---
id: M-2026-10-28-001
title: 台风天看海
date: 2026-10-28
salience: 4
type: event
cluster: 出行
emotion:
  self: {valence: 0.4, arousal: 0.8, label: 又怕又兴奋}
  user: {valence: 0.8, arousal: 0.6, label: 开心}
source: [msg-1]
---
`

const INLINE = NESTED.replace(
  /emotion:\n {2}self: .*\n {2}user: .*\n/,
  'emotion: {"self":{"valence":0.4,"arousal":0.8,"label":"又怕又兴奋"},"user":{"valence":0.8,"arousal":0.6,"label":"开心"}}\n',
)

const LEGACY = `---
id: M-2026-10-28-002
title: 旧写法
date: 2026-10-28
salience: 3
type: event
valence: -0.5
arousal: 0.9
source: [msg-1]
---
`

test('两种写法都解析成同一个形状（缩进块 / 单行 JSON）', () => {
  const a = normalizeEmotion(parseFrontMatter(NESTED).meta.emotion, parseFrontMatter(NESTED).meta)
  const b = normalizeEmotion(parseFrontMatter(INLINE).meta.emotion, parseFrontMatter(INLINE).meta)
  assert.deepEqual(a, b)
  assert.deepEqual(a.user, { valence: 0.8, arousal: 0.6, label: '开心' })
  assert.deepEqual(a.self, { valence: 0.4, arousal: 0.8, label: '又怕又兴奋' })
})

test('老写法（扁平 valence/arousal）归到 self：不给记忆加强度', () => {
  const meta = parseFrontMatter(LEGACY).meta
  const e = normalizeEmotion(meta.emotion, meta)
  assert.equal(e.user, null)
  assert.equal(e.self.arousal, 0.9)
  assert.equal(arousalFor({ emotion: e }), null, 'self 不进遗忘')
})

test('arousalFor 只认 user；越界值不采信（不 clamp、不崩）', () => {
  assert.equal(arousalFor({ emotion: { user: { arousal: 0.9 } } }), 0.9)
  assert.equal(arousalFor({ emotion: { self: { arousal: 0.9 }, user: null } }), null)
  assert.equal(arousalFor({ emotion: { user: { arousal: 1.7 } } }), null)
  assert.equal(arousalFor({}), null)
  // 0.9 的 user 唤醒 → S₀ ×1.8（这条规则从 v0.5 就写着，v0.18.0 才第一次真的能用）
  assert.equal(initialS(2, 0.9), 12.6)
  assert.equal(initialS(2, 0.6), 7)
})

test('validatePoint：量程写错 = 硬错误（不悄悄改成边界值）', () => {
  const base = {
    id: 'M-2026-10-28-009',
    title: 't',
    date: '2026-10-28',
    salience: 3,
    type: 'event',
    cluster: 'c',
    status: 'active',
    source: ['msg-1'],
    summary: '一句话。',
    quote: '',
    links: [],
    contradicts: [],
    event: null,
    invalid_at: null,
  }
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: '原文' }]]) }

  const ok = validatePoint({ ...base, emotion: { user: { valence: 0.5, arousal: 0.5, label: '开心' } } }, { archive })
  assert.deepEqual(ok.errors, [])

  const bad = validatePoint({ ...base, emotion: { user: { valence: 3, arousal: -1 } } }, { archive })
  assert.equal(bad.errors.filter((e) => e.field === 'emotion').length, 2, JSON.stringify(bad.errors))

  const longLabel = validatePoint({ ...base, emotion: { user: { label: '一二三四五六七八九十十一十二三' } } }, { archive })
  assert.ok(longLabel.errors.some((e) => e.field === 'emotion' && /label/.test(e.message)))
})

test('validatePoint：只有 self 时给一条 warning（#12：这条不会因情绪更牢）', () => {
  const p = {
    id: 'M-2026-10-28-010',
    title: 't',
    date: '2026-10-28',
    salience: 3,
    type: 'event',
    cluster: 'c',
    status: 'active',
    source: ['msg-1'],
    summary: '一句话。',
    quote: '',
    links: [],
    contradicts: [],
    event: null,
    invalid_at: null,
    emotion: { self: { valence: -0.5, arousal: 0.9 }, user: null },
  }
  const r = validatePoint(p, { archive: { byId: new Map([['msg-1', { id: 'msg-1', text: '原文' }]]) } })
  assert.ok(r.warnings.some((w) => w.field === 'emotion' && /user 侧/.test(w.message)), JSON.stringify(r.warnings))
})

test('注入：只有 user 的 label 会进那一行，self 的不进', () => {
  const p = {
    id: 'M-1',
    date: '2026-10-28',
    title: '台风天看海',
    summary: '台风夜绕路看海。',
    quote: '这种天气看海才有意思',
    quoteBy: 'her',
    facts: '积水到小腿。',
    thoughts: '有点怕。',
    emotion: { self: { label: '又怕又兴奋' }, user: { label: '开心' } },
  }
  const sum = renderPoint(p, 'sum')
  assert.match(sum, /（他那时：开心）/)
  assert.doesNotMatch(sum, /又怕又兴奋/)
  const full = renderPoint(p, 'full')
  assert.match(full, /（他那时：开心）/)
  assert.doesNotMatch(renderPoint(p, 'idx'), /他那时/)
})

test('scanPointFiles 也认 emotion（草稿阶段就能校验，不必等到注入）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-emo-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points', 'M-2026-10-28-001.md'), NESTED, 'utf8')
  const scan = scanPointFiles(dir, '30_points')
  assert.equal(scan.points.length, 1)
  assert.deepEqual(scan.points[0].emotion.user, { valence: 0.8, arousal: 0.6, label: '开心' })
})

test('没有情绪的点一个字都不多（不能给旧点加噪音）', () => {
  const p = { id: 'M-1', date: '2026-10-28', title: 'x', summary: 'y', quote: '', links: [], contradicts: [] }
  assert.equal(renderPoint(p, 'sum'), '2026-10-28 x\ny')
})
