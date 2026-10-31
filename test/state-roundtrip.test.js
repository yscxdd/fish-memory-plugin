// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 存档往返测试（v0.20.2，借鉴自《性格与记忆情绪系统 v2》的事故）。
 *
 * 他们踩过的坑（`性格系统/personality.mjs:172` 的注释）：
 *   "原来存的是 ln(weight)，load 时被 clamp 到 ln(0.6)，一重载就变 25/25/25/25"
 * ——**写进去的单位/形状，读回来时必须一模一样**；这类 bug 不会在"跑一次"里露头，
 *   只会在"重启一次"之后悄悄改变她的状态。
 *
 * 所以这里钉四组：tick/注入计数、last_message、会话 tail、FSRS 状态、档案清单。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter } from '../lib/archive.js'
import { applyForget, planForget } from '../lib/forget.js'
import { checkArchive } from '../lib/integrity.js'
import { MemoryStore } from '../lib/store.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-roundtrip-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '20_index', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n', 'utf8')
  writeFileSync(join(dir, '00_core/rules.md'), '# 规则\n\n1. 找不到就说找不到。\n', 'utf8')
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

function point(id, { salience = 2, date = '2026-10-20', type = 'event' } = {}) {
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
---

<!-- SUM -->
${id}
<!-- /SUM -->
`
}

test('往返 ①：tick 与注入计数写出去、读回来一致', () => {
  const dir = fixture()
  const a = new MemoryStore(dir)
  const t0 = a.state().tick
  a.bumpTick()
  a.bumpTick()
  a.recordInjection(['M-1', 'M-2'], a.state().tick)
  a.flush()
  a.dispose()

  const b = new MemoryStore(dir)
  assert.equal(b.state().tick, t0 + 2, 'tick 不能变')
  assert.equal(b.injectionCount('M-1', b.state().tick), 1, '注入计数要读得回来')
  assert.equal(b.injectionCount('M-2', b.state().tick), 1)
  assert.equal(b.injectionCount('M-3', b.state().tick), 0)
  b.dispose()
})

test('往返 ②：last_message 写出去、读回来一致', () => {
  const dir = fixture()
  const msg = { id: 'msg-9', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '夜深了' }
  const a = new MemoryStore(dir)
  a.setLastMessage(msg)
  a.flush()
  a.dispose()

  const b = new MemoryStore(dir)
  assert.deepEqual(b.lastMessage(), msg)
  b.dispose()
})

test('往返 ③：会话 tail 与 injected_work 标记不丢', () => {
  const dir = fixture()
  const a = new MemoryStore(dir)
  a.ensureSession('s1')
  a.touchSession('s1', { role: 'user', text: '第一句' })
  a.touchSession('s1', { role: 'assistant', text: '第二句' })
  a.markWorkInjected('s1')
  a.flush()
  a.dispose()

  const b = new MemoryStore(dir)
  const s = b.session('s1')
  assert.ok(s, '会话要还在')
  assert.equal(s.injected_work, true, 'markWorkInjected 要落盘（否则每次首轮都重复注入工作记忆）')
  const texts = (s.tail || []).map((m) => m.text)
  assert.deepEqual(texts, ['第一句', '第二句'], `tail 内容要一致，实际 ${JSON.stringify(texts)}`)
  b.dispose()
})

test('往返 ④：FSRS 状态（state.json）读进来、写回去不变形', () => {
  const dir = fixture()
  const design = {
    'M-2026-10-20-001': { S: 13.2, D: 0.35, r: 0.87, lc: 2, ll: '2026-10-25', st: 'active' },
  }
  writeFileSync(join(dir, '20_state/state.json'), JSON.stringify(design), 'utf8')
  writeFileSync(join(dir, '30_points/M-2026-10-20-001.md'), point('M-2026-10-20-001'), 'utf8')

  const { plan, state } = planForget(dir, { now: new Date('2026-11-01T00:00:00Z') })
  assert.deepEqual(state, design, '读进来的状态必须与文件一字不差')

  applyForget(dir, { now: new Date('2026-11-01T00:00:00Z'), plan, state })
  const after = JSON.parse(readFileSync(join(dir, '20_state/state.json'), 'utf8'))
  assert.equal(after['M-2026-10-20-001'].D, 0.35, '没被遗忘动过的字段要原样保留')
  assert.ok(Number(after['M-2026-10-20-001'].S) > 0, 'S 必须还是个正数（不是字符串/NaN）')
  for (const [, v] of Object.entries(after)) {
    assert.equal(typeof v.S, 'number', `S 必须是 number，实际 ${typeof v.S}`)
    assert.ok(Number.isFinite(v.S), 'S 不能是 NaN/Infinity')
  }
})

test('往返 ⑤：档案清单写出去、重开仍然 ok（不把自己写成"被改过"）', async () => {
  const dir = fixture()
  const t0 = new Date('2026-10-30T03:00:00Z').getTime()
  const ev = (seq, id) => ({
    type: 'user/message',
    seq,
    time: t0 + seq,
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text: `第 ${seq} 条 ${id}` }], source: { kind: 'user' } },
  })

  const w = new ArchiveWriter(dir)
  await w.handle('s1', ev(1, 'm-aaa111'))
  await w.handle('s1', ev(2, 'm-bbb222'))
  await w.idle()

  const first = checkArchive(dir, { now: '2026-11-01T00:00:00.000Z' })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = checkArchive(dir, { now: '2026-11-01T00:00:00.000Z' })
  assert.equal(second.ok, true, '第二次检查不能被第一次写清单的动作判成"被改过"')
  assert.equal(second.changed.length, 0, `不该有被改文件，实际 ${JSON.stringify(second.changed)}`)
})
