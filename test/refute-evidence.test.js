// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 改错闭环：refute（T5）+ evidence（T6）。v0.69.0。
 *
 * 决定（A）：被推翻的点**仍然注入**，但带 `[已推翻]` 标记和原因。
 * 理由：藏结论不藏事实——完全不注入会让她下次还犯同一个错，也抹掉了历史。
 *
 * 钉住：
 *   ① refute 后：状态 / 理由 / 墓碑账本 三样都对；
 *   ② 没有理由的 refute 被拒（"错了"必须有理由）；
 *   ③ 注入里带标记与原因（这条是"决定 A"的落地检查）；
 *   ④ evidence 能逐条打回原文；档案被改 → 验链失败 + 退出码非 0。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter } from '../lib/archive.js'
import { evidenceOf } from '../lib/evidence.js'
import { refutePoint } from '../lib/refute.js'
import { renderPoint } from '../lib/render.js'
import { validatePoint } from '../lib/toolkit.js'

const NOW = new Date(2026, 10, 7, 22, 0, 0)

async function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-refute-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  const w = new ArchiveWriter(dir)
  const ev = (seq, role, text) => {
    const m = { id: `msg-${seq}-abcdef`, role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } }
    return { type: role === 'user' ? 'user/message' : 'assistant/message', seq, time: Date.parse('2026-11-06T10:00:00.000Z') + seq * 1000, surfaceOp: 'append', data: role === 'user' ? m : { message: m } }
  }
  await w.handle('s1', ev(1, 'user', '他喜欢一个人待着'))
  await w.handle('s1', ev(2, 'assistant', '嗯，记住了'))
  await w.idle()
  return dir
}

/** 写一条点（source 指向 seq=1 那条档案） */
function point(dir, { id = 'M-2026-11-06-001', title = '他喜欢独处', source = null, status = 'active', contradicts = [] } = {}) {
  const src = source || ['msg-1-abcdef']
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'date: 2026-11-06',
    'type: event',
    'cluster: 日常',
    'salience: 3',
    'origin: told',
    `status: ${status}`,
    `source: [${src.map((s) => `"${s}"`).join(', ')}]`,
    `contradicts: [${contradicts.map((s) => `"${s}"`).join(', ')}]`,
    'links: []',
    '---',
    '',
    '<!-- SUM -->',
    '他喜欢独处',
    '<!-- /SUM -->',
    '',
    '他喜欢一个人待着。',
  ].join('\n')
  writeFileSync(join(dir, '30_points', `${id}.md`), fm, 'utf8')
  return id
}

const read = (dir, id) => readFileSync(join(dir, '30_points', `${id}.md`), 'utf8')

test('refute：状态变 superseded，理由与时间写进 front matter', async () => {
  const dir = await lib()
  const id = point(dir)
  const r = refutePoint(dir, id, { reason: '他其实怕一个人', now: NOW })
  assert.equal(r.ok, true, JSON.stringify(r))
  const raw = read(dir, id)
  assert.match(raw, /status: superseded/)
  assert.match(raw, /refuted_reason: "他其实怕一个人"/)
  // 用 NOW 算出来的 ISO，别写死——写死就是「+08:00 能过、CI(UTC) 红」那种假绿的反面
  assert.match(raw, new RegExp(`refuted_at: ${NOW.toISOString().replace(/[.]/g, '\\.')}`))
})

test('refute：没有理由直接拒（"错了"必须有理由）', async () => {
  const dir = await lib()
  const id = point(dir)
  const r = refutePoint(dir, id, { reason: '  ' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /必须给理由/)
  assert.match(read(dir, id), /status: active/, '拒了就不该动文件')
})

test('refute：墓碑进 erasure.log，且不含原文', async () => {
  const dir = await lib()
  const id = point(dir)
  refutePoint(dir, id, { reason: '他其实怕一个人', now: NOW })
  const log = readFileSync(join(dir, '50_log/erasure.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'refute')
  assert.equal(log[0].id, id)
  assert.equal(log[0].reason, '他其实怕一个人')
  assert.ok(!/他喜欢一个人待着/.test(JSON.stringify(log)), '账本里不许有原文')
})

test('refute：--by 会在新点上记 contradicts（这样冲突能被摊开）', async () => {
  const dir = await lib()
  const oldId = point(dir, { id: 'M-2026-11-06-001' })
  const newId = point(dir, { id: 'M-2026-11-07-003', title: '他其实怕一个人' })
  const r = refutePoint(dir, oldId, { reason: '他其实怕一个人', by: newId, now: NOW })
  assert.equal(r.linked, true)
  assert.match(read(dir, newId), /contradicts: \["M-2026-11-06-001"\]/)
  assert.match(read(dir, oldId), /refuted_by: M-2026-11-07-003/)
})

test('refute：同一条不能推翻两次；不能推翻自己', async () => {
  const dir = await lib()
  const id = point(dir)
  refutePoint(dir, id, { reason: '第一次', now: NOW })
  assert.equal(refutePoint(dir, id, { reason: '第二次', now: NOW }).ok, false)
  const id2 = point(dir, { id: 'M-2026-11-06-002' })
  assert.match(refutePoint(dir, id2, { reason: 'x', by: id2 }).reason, /自己推翻自己/)
})

test('决定 A：被推翻的点仍然渲染，但带 [已推翻] 和原因', async () => {
  const dir = await lib()
  const id = point(dir)
  refutePoint(dir, id, { reason: '他其实怕一个人', by: null, now: NOW })
  const raw = read(dir, id)
  assert.match(raw, /status: superseded/)
  const p = {
    id,
    title: '他喜欢独处',
    summary: '他喜欢一个人待着',
    date: '2026-11-06',
    status: 'superseded',
    refuted_reason: '他其实怕一个人',
    refuted_by: null,
    salience: 3,
  }
  const sum = renderPoint(p, 'sum')
  assert.match(sum, /\[已推翻\]/)
  assert.match(sum, /这条已被推翻：他其实怕一个人/)
  const idx = renderPoint(p, 'idx')
  assert.match(idx, /\[已推翻\]/, '索引档也要标（否则索引行会骗人）')
})

test('superseded 但没写理由 → validate 只 warn 不拦', () => {
  const base = {
    id: 'M-2026-11-06-001',
    title: 'x',
    date: '2026-11-06',
    type: 'event',
    cluster: '日常',
    salience: 3,
    origin: 'told',
    status: 'superseded',
    quote: '他喜欢一个人待着',
    quote_by: 'user',
    source: ['msg-1-abcdef'],
    links: [],
    summary: 'x',
  }
  const archive = { byId: new Map([['msg-1-abcdef', { id: 'msg-1-abcdef', text: '他喜欢一个人待着' }]]) }
  const r = validatePoint(base, { archive })
  assert.ok(!r.errors.some((e) => e.field === 'status'), '不是硬错误')
  assert.ok(r.warnings.some((w) => w.field === 'refuted_reason'), '要警告')
})

test('evidence：所有 source 都能打回原文，链完好', async () => {
  const dir = await lib()
  const id = point(dir)
  const r = evidenceOf(dir, id)
  assert.equal(r.total, 1)
  assert.equal(r.okCount, 1)
  assert.equal(r.ok, true, JSON.stringify(r.problems))
  assert.match(r.rows[0].text, /他喜欢一个人待着/)
})

test('evidence：source 指向不存在的消息 → 不 ok，并说清楚', async () => {
  const dir = await lib()
  const id = point(dir, { source: ['msg-999-zzzzzz'] })
  const r = evidenceOf(dir, id)
  assert.equal(r.ok, false)
  assert.match(r.problems.join(' '), /找不到/)
})

test('evidence：档案被改 → 链失败，结论不 ok', async () => {
  const dir = await lib()
  const id = point(dir)
  const f = join(dir, '10_archive/messages/2026-11-06.jsonl')
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  rows[1].prev = 'wrong-prev'
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const r = evidenceOf(dir, id)
  assert.equal(r.ok, false)
  assert.equal(r.chain.ok, false)
})

test('evidence：点不存在 → 明确报错而不是空结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-evi-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const r = evidenceOf(dir, 'M-2026-11-06-999')
  assert.equal(r.ok, false)
  assert.ok(existsSync(join(dir, '30_points')))
  assert.match(r.problems.join(' '), /没有这一条/)
})
