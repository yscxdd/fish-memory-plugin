// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 「差一点想起」要说出口 + 改口后旧问法不能断（v0.77.0）。
 *
 * 两件事的根是同一个：**话没说完 / 线断了一头**。
 *
 *   ① `nearMiss` 从 v0.73 就记了，但注入侧一个字都没有 →
 *      她查了、没查到、也不说，体感上就是"忘了"。
 *   ② `invalidate` 把一个点标失效时，**旧标题里的话题词跟着一起消失** →
 *      实测「我们约的哪天见面」在旧点失效后最高分 **0.000**（新旧标题零重叠）。
 *
 * 这两条都不需要真实对话就能测，所以它们不该排进"等数据"那一堆。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkLine, checkLineWithCooldown, looksLikeCheck } from '../lib/nearmiss.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-near-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

// ── ① 核对类判据：拿 97 条真消息量过的口径 ──────────────────────
test('核对类判据：两条真实空召回都要能认出来', () => {
  assert.equal(looksLikeCheck('我们约的哪天见面'), true)
  assert.equal(looksLikeCheck('见面改时间了吗'), true)
  assert.equal(looksLikeCheck('出差是周几走'), true)
})

test('核对类判据：「还是」不进判据（口语太多，会把闲聊判成核对）', () => {
  assert.equal(looksLikeCheck('我们还是朋友吧'), false, '这句话不是在核对一件具体的事')
})

test('核对类判据：任务/闲聊不算', () => {
  for (const s of ['把那个函数抽一下', '今天有点累', '在吗', '']) {
    assert.equal(looksLikeCheck(s), false, s)
  }
})

// ── nearMiss 到注入的那一行 ─────────────────────────────────────
test('没命中但有"差一点"：说出口，并指到那条点', () => {
  const r = checkLine({
    query: '见面改时间了吗',
    nearMiss: { id: 'M-2026-11-02-001', score: 0.74 },
    threshold: 0.8,
    pointCount: 3,
  })
  assert.equal(r.kind, 'near')
  assert.match(r.text, /M-2026-11-02-001/)
  assert.ok(r.text.length < 60, '一行要短')
})

test('没命中也没有"差一点"：也要说"没找到"，不许装懂', () => {
  const r = checkLine({ query: '我们约的哪天见面', nearMiss: null, threshold: 0.8, pointCount: 3 })
  assert.equal(r.kind, 'none')
  assert.match(r.text, /没找到/)
})

test('空库上完全不开口（每句都"没找到"不是诚实，是坏掉）', () => {
  assert.equal(checkLine({ query: '我们约的哪天见面', nearMiss: null, threshold: 0.8, pointCount: 0 }), null)
})

test('不是核对类问句：一个字都不加', () => {
  assert.equal(checkLine({ query: '今天有点累', nearMiss: { id: 'M-1', score: 0.75 }, pointCount: 5 }), null)
})

test('分数太低的不算"差一点"（那确实就是没找到）', () => {
  const r = checkLine({ query: '见面改时间了吗', nearMiss: { id: 'M-1', score: 0.2 }, threshold: 0.8, pointCount: 5 })
  assert.equal(r.kind, 'none', '0.2 分的"差一点"是假客气')
})

// ── 冷却：12 小时同一条只提一次 ─────────────────────────────────
test('冷却：同一条点 12 小时内只提一次', () => {
  const dir = lib()
  const now = new Date('2026-11-08T10:00:00Z')
  const args = { query: '见面改时间了吗', nearMiss: { id: 'M-1', score: 0.75 }, threshold: 0.8, pointCount: 3, now }

  const first = checkLineWithCooldown(dir, args)
  assert.equal(first.marked, true)
  assert.ok(first.text)

  const second = checkLineWithCooldown(dir, { ...args, now: new Date('2026-11-08T11:00:00Z') })
  assert.equal(second.kind, 'cooldown')
  assert.equal(second.text, '')

  const third = checkLineWithCooldown(dir, { ...args, now: new Date('2026-11-09T02:00:00Z') })
  assert.equal(third.marked, true, '过了 12 小时要能再说')
})

test('冷却记账落在 20_state/reminded.json（和到期提醒共用同一本账）', () => {
  const dir = lib()
  checkLineWithCooldown(dir, {
    query: '我们约的哪天见面',
    nearMiss: null,
    threshold: 0.8,
    pointCount: 2,
    now: new Date('2026-11-08T10:00:00Z'),
  })
  const raw = readFileSync(join(dir, '20_state/reminded.json'), 'utf8')
  assert.match(raw, /__check_none__/, '没有具体点的那句也要能被记住，否则每轮都说一遍')
})
