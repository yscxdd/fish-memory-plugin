// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * regression.test.js — v0.4.3 修掉的四个问题，各钉一条。
 *
 *   ① 档案链：seq 是会话级的，跨会话交错不能判成"链断"
 *   ② 压力分母：TokenMeasurement 没有上限字段，窗口要外部给
 *   ③ 核心层预算：超预算先丢低优先级块，再截断
 *   ④ 配置：拼错的键要告警，越界值要 clamp
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter, hashOf, verifyChain } from '../lib/archive.js'
import { DEFAULT_BUDGET, layoutCore } from '../lib/render.js'
import { contextWindowOf, pressureRatio } from '../lib/pressure.js'
import { normalizeConfig } from '../lib/config.js'
import { estTokens } from '../lib/util.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), `fishmem-${p}-`))

const userEvent = (seq, id, time) => ({
  type: 'user/message',
  seq,
  time,
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text: `第 ${seq} 条 ${id}` }], source: { kind: 'user' } },
})

// ── ① 档案链 ───────────────────────────────────────────────────

test('档案链：两个会话在同一份日文件里交错，不算坏', async () => {
  const dir = tmp('chain')
  const now = new Date('2026-10-30T03:00:00Z').getTime()
  const w = new ArchiveWriter(dir, { now: () => new Date(now) })

  // 真实现场：老会话跑到 seq 4172，新会话从 seq 9 开始
  const plan = [
    ['sA', 4170],
    ['sA', 4172],
    ['sB', 9],
    ['sB', 11],
    ['sA', 4173],
  ]
  for (const [sid, seq] of plan) await w.handle(sid, userEvent(seq, `${sid}-${seq}`, now + seq))
  await w.idle()

  assert.deepEqual(w.verifyLatest(100), { ok: true, count: 5 }, '跨会话不比较 seq，只比 hash 链')
})

test('档案链：同一会话内 seq 回退仍然是坏数据', () => {
  const rec = (sid, seq) => ({ seq, session: sid, role: 'user', ts: '2026-10-30T03:00:00.000Z', msgid_plat: `m-${sid}-${seq}`, text: `第 ${seq} 条` })
  const a = rec('sA', 5)
  a.prev = 'genesis'
  a.hash = hashOf(a)
  const b = rec('sA', 3)
  b.prev = a.hash
  b.hash = hashOf(b)

  const r = verifyChain([a, b])
  assert.equal(r.ok, false)
  assert.match(r.reason, /seq 不递增/)
})

test('档案链：prev 断了仍然报错（链的不变量没被放宽）', () => {
  const a = { seq: 1, session: 'sA', role: 'user', ts: 't', msgid_plat: 'm1', text: 'x', prev: 'genesis', hash: '' }
  a.hash = hashOf(a)
  const b = { seq: 2, session: 'sA', role: 'user', ts: 't', msgid_plat: 'm2', text: 'y', prev: 'deadbeef', hash: '' }
  b.hash = hashOf(b)
  assert.equal(verifyChain([a, b]).ok, false)
})

// ── ② 压力分母 ─────────────────────────────────────────────────

test('压力分母：只拿到 TokenMeasurement 时不报压力，给了窗口才报', () => {
  const measurement = {
    logRevision: 1,
    baseline: { kind: 'none', tokens: 0 },
    surfaceDeltaTokens: 900,
    totalTokens: 900,
    surfaceTokens: 900,
    nodes: [],
  }
  assert.equal(pressureRatio(measurement, contextWindowOf({}, undefined)), null)
  assert.equal(pressureRatio(measurement, contextWindowOf({ requestContext: () => ({ contextWindow: 1000 }) }, undefined)), 0.9)
})

// ── ③ 核心层预算 ───────────────────────────────────────────────

const CORE = [
  { name: 'soul', text: '我最怕被当成"AI"讨论。'.repeat(6) },
  { name: 'user', text: '我在成都。'.repeat(6) },
  { name: 'relation', text: '关系：常态。'.repeat(6) },
  { name: 'rules', text: '只写 40_pending/，不直写 30_points/。'.repeat(4) },
]

test('核心层：装得下就一块不少', () => {
  const r = layoutCore(CORE, 100000)
  assert.equal(r.dropped.length, 0)
  assert.match(r.text, /我最怕被当成/)
  assert.match(r.text, /只写 40_pending/)
})

test('核心层：超预算先丢低优先级，soul 和 rules 留下', () => {
  const parts = [...CORE, { name: 'status', text: '【我们现在】常态。' }]
  // 预算按实测算：刚好只够 soul + rules
  const need = estTokens(parts[0].text) + estTokens(parts[3].text)
  const budget = need + 10
  const r = layoutCore(parts, budget)

  assert.match(r.text, /我最怕被当成/)
  assert.match(r.text, /只写 40_pending/)
  assert.ok(!r.dropped.includes('soul'), `丢的是 ${r.dropped.join(',')}`)
  const lowPriority = ['status', 'relation', 'user']
  assert.ok(
    lowPriority.some((n) => r.dropped.some((d) => d.startsWith(n))),
    `低优先级该让路，实际丢的是 ${r.dropped.join(',') || '（没丢）'}`,
  )
  assert.ok(r.tokens <= budget + 40, `实际 ${r.tokens} / 预算 ${budget}`)
})

test('核心层：单块就超预算 → 截断并留可见标记', () => {
  const r = layoutCore([{ name: 'soul', text: '很长的一段灵魂。'.repeat(200) }], 100)
  assert.ok(r.tokens <= 160, `实际 ${r.tokens}`)
  assert.match(r.text, /已截断/)
})

test('核心层：core 预算配 0 视为不限（兼容旧配置）', () => {
  const r = layoutCore(CORE, 0)
  assert.equal(r.dropped.length, 0)
  assert.ok(r.tokens > 0)
  assert.equal(DEFAULT_BUDGET.core, 700)
})

// ── ④ 配置校验 ─────────────────────────────────────────────────

function collectWarnings() {
  const lines = []
  return { logger: { warn: (m) => lines.push(String(m)) }, lines }
}

test('配置：认得的键生效，越界 clamp，类型错丢弃，拼错的告警', () => {
  const { logger, lines } = collectWarnings()
  const cfg = normalizeConfig(
    {
      memoryDir: '  D:/mem  ',
      backupDir: 123,
      retrival: { threshold: 0.5 },
      inject: { core: 900, body: 999999, work: 'x' },
      retrieval: { threshold: 0.65, recallLimit: 0, maxEvents: 3 },
      pressure: { contextWindow: 64000 },
    },
    logger,
  )

  assert.equal(cfg.memoryDir, 'D:/mem')
  assert.equal(cfg.backupDir, undefined, '类型不对就丢')
  assert.equal(cfg.inject.core, 900)
  assert.equal(cfg.inject.body, 20000, '越界 clamp 到上限')
  assert.equal(cfg.inject.work, undefined, '不是数字就丢')
  assert.equal(cfg.retrieval.threshold, 0.65)
  assert.equal(cfg.retrieval.recallLimit, 1, '下限 clamp')
  assert.equal(cfg.pressure.contextWindow, 64000)

  const joined = lines.join('\n')
  assert.match(joined, /retrival/, '拼错的键要告警')
  assert.match(joined, /backupDir/)
  assert.match(joined, /inject\.body/)
  assert.match(joined, /inject\.work/)
})

test('配置：不传就是空对象，不炸', () => {
  const empty = { inject: {}, retrieval: {}, pressure: {}, emotion: {}, remind: {} }
  assert.deepEqual(normalizeConfig(undefined), empty)
  assert.deepEqual(normalizeConfig('nope'), empty)
})
