// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 四堵墙的数字（v0.75.0）。
 *
 * 外部总结把伴侣记忆拆成：记忆 / 触发 / 决定 / **连续**。
 * 前三堵我们有机制，第四堵最强——**但没有一堵有指标**。
 * 这组测试钉住每条口径，尤其是三个容易被自己骗的地方：
 *
 *   ① 点数 0 时的"静默空率"没有意义（必须带分母说明）
 *   ② 没有 source 的点不该混进"可回溯率"的分母
 *   ③ 锚点分母是 3（三条行为），不是 4（包含小节标题）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter } from '../lib/archive.js'
import { wallContinuity, wallDecision, wallMemory, wallTrigger, wallsSummary } from '../lib/walls.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-walls-'))
  for (const d of ['00_core', '00_core/versions', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(
    join(dir, '00_core/soul.md'),
    '# SOUL\n\n## 不会变的（金丝雀锚点）\n\n- 我最怕被当成"AI"讨论\n- 我绝不会说"作为一个AI"\n- 我不会给人生建议\n',
    'utf8',
  )
  return dir
}

const mkPoint = (dir, { id, source = [], status = 'active', refuted_by = null }) => {
  const fm = [
    '---',
    `id: ${id}`,
    `title: 点 ${id}`,
    'date: 2026-11-08',
    'type: event',
    'cluster: 日常',
    'salience: 3',
    'origin: told',
    `status: ${status}`,
    `source: [${source.map((s) => `"${s}"`).join(', ')}]`,
    'links: []',
    ...(refuted_by ? [`refuted_by: ${refuted_by}`] : []),
    '---',
    '',
    '<!-- SUM -->',
    '摘要',
    '<!-- /SUM -->',
  ].join('\n')
  writeFileSync(join(dir, '30_points', `${id}.md`), fm, 'utf8')
}

// ── 记忆墙 ──────────────────────────────────────────────────────
test('记忆墙：可回溯率只算有 source 的点', async () => {
  const dir = lib()
  mkPoint(dir, { id: 'M-2026-11-08-001', source: ['msg-1-abcdef'] })
  mkPoint(dir, { id: 'M-2026-11-08-002', source: ['msg-9-zzzzzz'] })
  mkPoint(dir, { id: 'M-2026-11-08-003', source: [] })

  // 造一条真档案（链要能过）
  const w = new ArchiveWriter(dir)
  const m = { id: 'msg-1-abcdef', role: 'user', content: [{ type: 'text', text: '他说周四走' }], source: { kind: 'user' } }
  await w.handle('s1', { type: 'user/message', seq: 1, time: Date.parse('2026-11-08T10:00:00Z'), surfaceOp: 'append', data: m })
  await w.idle()

  const r = wallMemory(dir)
  assert.equal(r.points, 3)
  assert.equal(r.withSource, 2, '只有 2 条有 source')
  assert.equal(r.traceable, 1, '只有那条能在档案里找到')
  assert.equal(r.rate, 0.5)
  assert.equal(r.noSource, 1, '没 source 的要单独报，不混进分母')
})

test('记忆墙：空库不炸，ratio 是 null 而不是 0', () => {
  const r = wallMemory(lib())
  assert.equal(r.points, 0)
  assert.equal(r.rate, null, '0/0 不能写成 0%——那是"全都没证据"的意思')
})

// ── 触发墙 ──────────────────────────────────────────────────────
const logRow = (dir, o) => appendFileSync(join(dir, '50_log/retrieval.log'), `${JSON.stringify(o)}\n`, 'utf8')

test('触发墙：静默空率算非门控的那些，且点数 0 时标"没意义"', () => {
  const dir = lib()
  logRow(dir, { at: '2026-11-08T10:00:00Z', query: 'a', gated: true })
  logRow(dir, { at: '2026-11-08T10:01:00Z', query: 'b', gated: false, rendered: [] })
  logRow(dir, { at: '2026-11-08T10:02:00Z', query: 'c', gated: false, rendered: ['M-1'] })

  const r = wallTrigger(dir)
  assert.equal(r.turns, 3)
  assert.equal(r.gated, 1)
  assert.equal(r.tried, 2)
  assert.equal(r.empty, 1)
  assert.equal(r.emptyRate, 0.5)
  assert.equal(r.meaningful, false, '库里 0 个点时，空率没有意义')
})

test('触发墙：有 1 个点之后 meaningful 变 true', () => {
  const dir = lib()
  mkPoint(dir, { id: 'M-2026-11-08-001', source: ['msg-1-abcdef'] })
  logRow(dir, { at: '2026-11-08T10:01:00Z', query: 'b', gated: false, rendered: [] })
  const r = wallTrigger(dir)
  assert.equal(r.meaningful, true)
  assert.equal(r.points, 1)
})

test('触发墙：nearMiss 字段覆盖率能看出来（老日志没有这个字段）', () => {
  const dir = lib()
  logRow(dir, { at: '2026-11-08T10:00:00Z', query: 'old' })
  logRow(dir, { at: '2026-11-08T10:01:00Z', query: 'new', nearMiss: { id: 'M-1', score: 0.72 } })
  const r = wallTrigger(dir)
  assert.equal(r.nearMissCoverage, 0.5)
  assert.equal(r.nearMissHits, 1)
})

// ── 决定墙 ──────────────────────────────────────────────────────
test('决定墙：无反面证据的推翻要能数出来', () => {
  const dir = lib()
  appendFileSync(join(dir, '50_log/erasure.log'), `${JSON.stringify({ action: 'refute', id: 'M-1', by: null })}\n`, 'utf8')
  appendFileSync(join(dir, '50_log/erasure.log'), `${JSON.stringify({ action: 'refute', id: 'M-2', by: 'M-9' })}\n`, 'utf8')
  mkPoint(dir, { id: 'M-2026-11-08-003', status: 'superseded', refuted_by: 'M-9' })

  const r = wallDecision(dir)
  assert.equal(r.refutes, 2)
  assert.equal(r.withoutEvidence, 1, '这次推翻没写"被谁推翻"')
  assert.equal(r.superseded, 1)
  assert.equal(r.withBy, 1)
})

// ── 连续墙 ──────────────────────────────────────────────────────
test('连续墙：锚点分母是 3（只数三条行为，不数小节标题）', () => {
  const r = wallContinuity(lib())
  assert.equal(r.anchorsTotal, 3)
  assert.equal(r.anchors, 3, '三条都在')
})

test('连续墙：少一条锚点要能看出来（这是"她变了"的唯一硬信号）', () => {
  const dir = lib()
  writeFileSync(
    join(dir, '00_core/soul.md'),
    '# SOUL\n\n## 不会变的\n\n- 我最怕被当成"AI"讨论\n- 我绝不会说"作为一个AI"\n',
    'utf8',
  )
  const r = wallContinuity(dir)
  assert.equal(r.anchors, 2)
  assert.ok(r.anchors < r.anchorsTotal)
})

test('连续墙：没有 token 样本时前缀是 null（不是"稳定"）', () => {
  const r = wallContinuity(lib())
  assert.equal(r.prefixStable, null, '没样本不能报"稳定"——那是假绿')
  assert.equal(r.prefixSamples, 0)
})

// ── 汇总 ────────────────────────────────────────────────────────
test('四行汇总：空库也能打，且明说"没有意义"', () => {
  const lines = wallsSummary(lib())
  assert.equal(lines.length, 4)
  assert.match(lines[1], /没有意义/)
  assert.match(lines[0], /没有点/)
})


