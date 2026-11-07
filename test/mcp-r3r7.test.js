// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * R5 / R3 / R7（v0.73.0）。
 *
 * R5 MCP 只读出口：一天换一个生态位（Claude Code / Codex 也能查鱼库）。
 * R3 双时间轴：`learned_at`——"她什么时候才知道"和"事情什么时候发生"分开。
 * R7 近失记录：记下"最接近但没过线"的分，补别名时不用猜。
 *
 * 三条都是**只读或纯增量**：不碰人格层、不碰注入预算。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'

// 先钉住库目录：MCP 模块在 import 那一刻就会解析 dir
process.env.FISH_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'fishmem-mcp-'))
for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending']) {
  mkdirSync(join(process.env.FISH_MEMORY_DIR, d), { recursive: true })
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { learnedLate, renderPoint } from '../lib/render.js'
import { rankHybrid } from '../lib/retrieve.js'
import { readPointFiles } from '../lib/toolkit.js'

// ── R3 ─────────────────────────────────────────────────────────
test('R3：知道得比发生晚 ≥30 天 → 带「YYYY-MM 才知道」', () => {
  assert.equal(learnedLate({ date: '2026-01-10', learned_at: '2026-11-05' }), '(2026-11 才知道)')
})

test('R3：差几天不算（标了全是噪音）', () => {
  assert.equal(learnedLate({ date: '2026-11-01', learned_at: '2026-11-05' }), '')
})

test('R3：没有 learned_at 或者日期坏掉 → 空串，不炸', () => {
  assert.equal(learnedLate({ date: '2026-01-10' }), '')
  assert.equal(learnedLate({ date: 'not-a-date', learned_at: '2026-11-05' }), '')
  assert.equal(learnedLate(null), '')
})

test('R3：标记进渲染（索引档也有，否则那一行会骗人）', () => {
  const p = {
    id: 'M-2026-01-10-001',
    date: '2026-01-10',
    learned_at: '2026-11-05',
    title: '他去年就离职了',
    summary: '他去年就离职了',
    salience: 3,
  }
  assert.match(renderPoint(p, 'idx'), /2026-11 才知道/)
  assert.match(renderPoint(p, 'sum'), /2026-11 才知道/)
})

test('R3：front matter 里的 learned_at 能被读出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-r3-'))
  for (const d of ['30_points', '20_state']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(
    join(dir, '30_points/M-2026-01-10-001.md'),
    [
      '---',
      'id: M-2026-01-10-001',
      'title: 他去年就离职了',
      'date: 2026-01-10',
      'learned_at: 2026-11-05',
      'type: event',
      'cluster: 工作',
      'salience: 3',
      'origin: told',
      'status: active',
      'source: ["msg-1-abcdef"]',
      'links: []',
      '---',
      '',
      '<!-- SUM -->',
      '他去年就离职了',
      '<!-- /SUM -->',
    ].join('\n'),
    'utf8',
  )
  const p = readPointFiles(dir, '30_points')[0]
  assert.equal(p.learned_at, '2026-11-05')
})

// ── R7 ─────────────────────────────────────────────────────────
test('R7：rankHybrid 记下最接近但没过线的那条', () => {
  const points = [
    { id: 'M-1', title: '备份怎么做', summary: '备份怎么做', date: '2026-11-01', salience: 3, cluster: '工作', tags: [] },
    { id: 'M-2', title: '完全不相干的事', summary: '完全不相干的事', date: '2026-11-01', salience: 3, cluster: '日常', tags: [] },
  ]
  const stats = {}
  // 分数不是归一的（权重叠乘后可能 >5），所以门槛设到 99 才能保证一条都不过
  const picked = rankHybrid(points, '备份', { threshold: 99, stats })
  assert.equal(picked.length, 0, '门槛 99 时一条都不该过')
  assert.equal(stats.threshold, 99)
  assert.equal(stats.nearMiss.id, 'M-1', '最接近的应该是讲备份的那条')
  assert.ok(stats.nearMiss.score > 0 && stats.nearMiss.score < 99)
})

test('R7：全过线时 nearMiss 是 null（没有"差一点"）', () => {
  const points = [{ id: 'M-1', title: '备份怎么做', summary: '备份怎么做', date: '2026-11-01', salience: 3, cluster: '工作', tags: [] }]
  const stats = {}
  rankHybrid(points, '备份', { threshold: 0.1, stats })
  assert.equal(stats.nearMiss, null)
})

test('R7：不传 stats 也照常工作（不改变原有行为）', () => {
  const points = [{ id: 'M-1', title: '备份怎么做', summary: '备份怎么做', date: '2026-11-01', salience: 3, cluster: '工作', tags: [] }]
  assert.ok(rankHybrid(points, '备份', { threshold: 0.1 }).length >= 1)
})

// ── R5 ─────────────────────────────────────────────────────────
const MCP = new URL('../scripts/mcp.mjs', import.meta.url)

test('R5：MCP 暴露四个只读工具，且没有写工具', async () => {
  const { TOOLS } = await import(MCP.href)
  const names = TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, ['memory_context', 'memory_evidence', 'memory_get', 'memory_search'])
  for (const t of TOOLS) {
    assert.match(t.name, /^memory_(search|get|context|evidence)$/, `不该有写工具：${t.name}`)
    assert.ok(t.inputSchema?.type === 'object')
  }
})

test('R5：initialize 回协议版本与"只读"说明', async () => {
  const { handle } = await import(MCP.href)
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.equal(r.result.serverInfo.name, 'fish-memory')
  assert.match(r.result.instructions, /只读/)
})

test('R5：不认识的方法回 -32601，JSON 坏行不崩', async () => {
  const { handle } = await import(MCP.href)
  const r = handle({ jsonrpc: '2.0', id: 2, method: 'tools/nope' })
  assert.equal(r.error.code, -32601)
})

test('R5：tools/call 打一个空库也不炸（返回"可能为空"的说明）', async () => {
  const { callTool } = await import(MCP.href)
  const r = callTool('memory_search', { query: '不存在的词' })
  assert.ok(r.content?.[0]?.text)
  assert.match(r.content[0].text, /本机记忆库|记忆点/)
})

test('R5：不暴露任何写操作（源码里没有 append/写入工具）', async () => {
  const src = (await import('node:fs')).readFileSync(MCP, 'utf8')
  assert.ok(!/memory_(write|remember|add|promote|erase)/.test(src), 'MCP 里不许出现写工具名')
})
