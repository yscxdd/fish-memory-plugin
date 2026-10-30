// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { contextWindowOf, ensureSegmentPacket, latestOpenSegment, pressureNote, pressureRatio } from '../lib/pressure.js'

test('pressureRatio：认得出常见字段，认不出就返回 null（不误报）', () => {
  assert.equal(pressureRatio({ totalTokens: 700, contextWindow: 1000 }), 0.7)
  assert.equal(pressureRatio({ usage: { totalTokens: 90 }, contextWindow: 100 }), 0.9)
  assert.equal(pressureRatio({ used: 1000, limit: 1000 }), 1)
  assert.equal(pressureRatio({}), null)
  assert.equal(pressureRatio(null), null)
  assert.equal(pressureRatio({ totalTokens: 5 }), null)
})

test('压力分母：宿主真实的 TokenMeasurement 没有上限字段，必须由调用方给窗口', () => {
  // 这就是 tokenMeter.measure() 实际返回的形状（见宿主 Service 契约）
  const measurement = {
    logRevision: 12,
    baseline: { kind: 'usage', tokens: 400, usage: { inputTokens: 400, outputTokens: 60 } },
    surfaceDeltaTokens: 300,
    totalTokens: 700,
    surfaceTokens: 700,
    nodes: [{ seq: 1, tokens: 700, heuristicTokens: 690 }],
  }
  assert.equal(pressureRatio(measurement), null, '没有窗口就返回 null，不瞎报（v0.4.2 的 bug 就在这）')
  assert.equal(pressureRatio(measurement, 1000), 0.7)
  assert.equal(pressureRatio(measurement, 0), null)
  assert.equal(pressureRatio(measurement, null), null)
})

test('contextWindowOf：会话请求上下文优先，其次配置，最后环境变量', () => {
  assert.equal(contextWindowOf({ requestContext: () => ({ contextWindow: 64000 }) }, 8000), 64000)
  assert.equal(contextWindowOf({ requestContext: () => ({}) }, 8000), 8000)
  assert.equal(contextWindowOf({}, undefined), null)
  assert.equal(
    contextWindowOf(
      {
        requestContext: () => {
          throw new Error('no header yet')
        },
      },
      32000,
    ),
    32000,
  )

  process.env.FISH_MEMORY_CONTEXT_WINDOW = '16000'
  try {
    assert.equal(contextWindowOf({}, undefined), 16000)
  } finally {
    delete process.env.FISH_MEMORY_CONTEXT_WINDOW
  }
})

test('ensureSegmentPacket：到限时把当前段原文包落地，已存在不重写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-pressure-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const lines = [
    { id: 'm1', ts: '2026-10-30T01:00:00.000Z', role: 'user', source_kind: 'user', text: '在吗' },
    { id: 'm2', ts: '2026-10-30T01:00:10.000Z', role: 'assistant', source_kind: 'model', text: '在' },
  ]
  writeFileSync(join(dir, '10_archive/messages/2026-10-30.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const seg = latestOpenSegment(dir)
  assert.ok(seg)
  const first = ensureSegmentPacket(dir)
  assert.equal(first.wrote, true)
  assert.equal(existsSync(first.path), true)
  const second = ensureSegmentPacket(dir)
  assert.equal(second.wrote, false)

  assert.match(pressureNote(0.72), /72%/)
})
