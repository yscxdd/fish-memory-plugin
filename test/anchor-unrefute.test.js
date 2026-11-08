// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 改口之后旧问法不能断 + 推翻能撤销（v0.77.0）。
 *
 * 这两条都不需要真实对话就能测，所以它们不该排进"等数据"那一堆。
 *
 * ① `invalidate` 把旧点标失效时，旧标题的话题词会跟着消失 → 新点接不上旧问法。
 *    实测（`_old-fish-memory-backups` 那批真数据里挑出来的两条）：
 *    「我们约的哪天见面」0.000 → 继承话题词后 **3.250**；「见面改时间了吗」0.000 → **3.100**。
 * ② `refute` 从 v0.69 就有，`unrefute` 一直没有——人自己的撤销工具也缺。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planInheritance, topicWords } from '../lib/anchor.js'
import { unrefutePoint } from '../lib/unrefute.js'
import { rankHybrid } from '../lib/retrieve.js'
import { readPointFiles } from '../lib/toolkit.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-anchor-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const mkPoint = (dir, { id, title, date = '2026-11-01', status = 'active', contradicts = [], aliases = null, extra = '' }) => {
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `date: ${date}`,
    'type: event',
    'cluster: 约定',
    'salience: 3',
    'origin: told',
    `status: ${status}`,
    `source: ["msg-1-abcdef"]`,
    `contradicts: [${contradicts.map((x) => `"${x}"`).join(', ')}]`,
    ...(aliases ? [`aliases: [${aliases.map((x) => `"${x}"`).join(', ')}]`] : []),
    'links: []',
    ...(extra ? [extra] : []),
    '---',
    '',
    '<!-- SUM -->',
    title,
    '<!-- /SUM -->',
  ].join('\n')
  writeFileSync(join(dir, '30_points', `${id}.md`), fm, 'utf8')
}

// ── ① 话题词 ───────────────────────────────────────────────────
test('话题词：不跨词边界切假词（滑窗那版会切出「了周」「六见」）', () => {
  assert.deepEqual(topicWords('约了周六见面'), ['约', '见面'])
})

test('话题词：继承之后，那两条原本 0.000 的查询能命中', () => {
  const newPoint = {
    id: 'M-2026-11-02-001',
    title: '改成周日了',
    date: '2026-11-02',
    cluster: '约定',
    type: 'event',
    status: 'active',
    salience: 3,
    tags: [],
    contradicts: [],
  }
  const before1 = rankHybrid([newPoint], '我们约的哪天见面', { threshold: 0 })[0]?.score ?? 0
  const before2 = rankHybrid([newPoint], '见面改时间了吗', { threshold: 0 })[0]?.score ?? 0
  assert.equal(before1, 0, '继承前必须是 0——不然这个测试就没在测东西')
  assert.equal(before2, 0)

  const after1 = rankHybrid([{ ...newPoint, aliases: topicWords('约了周六见面') }], '我们约的哪天见面', { threshold: 0 })[0]?.score ?? 0
  const after2 = rankHybrid([{ ...newPoint, aliases: topicWords('约了周六见面') }], '见面改时间了吗', { threshold: 0 })[0]?.score ?? 0
  assert.ok(after1 > 0.8, `继承后「我们约的哪天见面」应过 0.8，实际 ${after1}`)
  assert.ok(after2 > 0.8, `继承后「见面改时间了吗」应过 0.8，实际 ${after2}`)
})

// ── ② 继承给谁 ─────────────────────────────────────────────────
test('继承目标：--by 优先', () => {
  const oldP = { id: 'M-1', title: '约了周六见面', date: '2026-10-26', cluster: '约定', type: 'event' }
  const a = { id: 'M-2', title: 't', date: '2026-11-02', cluster: '约定', type: 'event', status: 'active', contradicts: [] }
  const b = { id: 'M-3', title: 't', date: '2026-11-03', cluster: '约定', type: 'event', status: 'active', contradicts: [] }
  assert.equal(planInheritance([a, b], oldP, { by: 'M-2' }).by, 'M-2')
})

test('继承目标：其次看新点的 contradicts', () => {
  const oldP = { id: 'M-1', title: '约了周六见面', date: '2026-10-26', cluster: '约定', type: 'event' }
  const a = { id: 'M-2', title: 't', date: '2026-11-02', cluster: '约定', type: 'event', status: 'active', contradicts: ['M-1'] }
  assert.equal(planInheritance([a], oldP).by, 'M-2')
  assert.match(planInheritance([a], oldP).reason, /contradicts/)
})

test('继承目标：找不到就明说，不乱连', () => {
  const oldP = { id: 'M-1', title: '约了周六见面', date: '2026-10-26', cluster: '约定', type: 'event' }
  const other = { id: 'M-9', title: 't', date: '2026-11-02', cluster: '工作', type: 'preference', status: 'active', contradicts: [] }
  const r = planInheritance([other], oldP)
  assert.equal(r.by, null)
  assert.ok(r.words.length > 0)
})

// ── ③ unrefute ─────────────────────────────────────────────────
test('unrefute：状态回 active、refuted_* 三个字段摘掉、账本记一行', () => {
  const dir = lib()
  mkPoint(dir, {
    id: 'M-2026-11-01-001',
    title: '他喜欢独处',
    status: 'superseded',
    extra: ['refuted_at: 2026-11-08T10:00:00.000Z', 'refuted_reason: "他其实怕一个人"', 'refuted_by: M-2026-11-08-009'].join('\n'),
  })
  const r = unrefutePoint(dir, 'M-2026-11-01-001', { reason: '我记错了，他确实喜欢独处', now: new Date('2026-11-08T12:00:00Z') })
  assert.equal(r.ok, true, JSON.stringify(r))

  const raw = readFileSync(join(dir, '30_points/M-2026-11-01-001.md'), 'utf8')
  assert.match(raw, /status: active/)
  assert.ok(!/refuted_at:/.test(raw), 'refuted_at 要摘掉')
  assert.ok(!/refuted_reason:/.test(raw))
  assert.ok(!/refuted_by:/.test(raw))

  const p = readPointFiles(dir, '30_points')[0]
  assert.equal(p.status, 'active')
  assert.equal(p.refuted_reason, null)

  const ledger = readFileSync(join(dir, '50_log/erasure.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(ledger[0].action, 'unrefute')
  assert.ok(!/他喜欢一个人待着/.test(JSON.stringify(ledger)), '账本里不许有原文')
})

test('unrefute：必须给理由', () => {
  const dir = lib()
  mkPoint(dir, { id: 'M-2026-11-01-001', title: 'x', status: 'superseded', extra: 'refuted_by: M-9' })
  const r = unrefutePoint(dir, 'M-2026-11-01-001', { reason: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /必须给理由/)
})

test('unrefute：没被推翻的点不撤销（别把普通点改成别的东西）', () => {
  const dir = lib()
  mkPoint(dir, { id: 'M-2026-11-01-001', title: 'x', status: 'active' })
  const r = unrefutePoint(dir, 'M-2026-11-01-001', { reason: '顺手' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没什么可撤销/)
})

test('unrefute：把新点上的 contradicts 一起摘掉（那是我写进去的）', () => {
  const dir = lib()
  mkPoint(dir, {
    id: 'M-2026-11-01-001',
    title: '他喜欢独处',
    status: 'superseded',
    extra: ['refuted_reason: "x"', 'refuted_by: M-2026-11-08-009'].join('\n'),
  })
  mkPoint(dir, { id: 'M-2026-11-08-009', title: '他其实怕一个人', date: '2026-11-08', contradicts: ['M-2026-11-01-001'] })

  const r = unrefutePoint(dir, 'M-2026-11-01-001', { reason: '撤销' })
  assert.equal(r.unlinked, true, JSON.stringify(r))
  const newer = readFileSync(join(dir, '30_points/M-2026-11-08-009.md'), 'utf8')
  assert.ok(!/M-2026-11-01-001/.test(newer), '新点上不该再宣称推翻了它')
  assert.ok(existsSync(join(dir, '30_points/M-2026-11-08-009.md')))
})
