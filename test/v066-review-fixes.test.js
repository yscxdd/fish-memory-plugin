// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * v0.66.0 复审修正（E1 / E2 / E3 / E5 / E6）。
 *
 * 这一版修的**全是我 v0.65 自己造的问题**，所以每条测试都在描述"当时错在哪"。
 *
 *   E1 情绪闸拿"工作产出"判"他的心里话" → 他的消息 50% 被判成工作
 *   E2 纸条只闸"谁写"没闸"写进去的是谁的话" → 日常会话写进工作原话
 *   E3 交接包单向闸 → 任务窗读一次就把人格包吃了
 *   E5 跨会话闸对"一个人一个长会话"致命（真实库 93% 在一个会话）
 *   E6 判据两份 → 改一份不生效
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasFeel, looksLikeWork } from '../lib/textkind.js'
import * as textkind from '../lib/textkind.js'
import * as wakeup from '../lib/wakeup.js'
import { buildHandoff, takeHandoff } from '../lib/handoff.js'
import { lastExchanges, maybeWriteWere } from '../lib/were.js'
import { mineVoice } from '../lib/voice.js'
import { setSessionMode } from '../lib/archive.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-e66-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调样本\n', 'utf8')
  return dir
}

const seed = (dir, rows) => {
  writeFileSync(
    join(dir, '10_archive/messages/2026-11-06.jsonl'),
    rows.map((r, i) => JSON.stringify({ id: `m${i + 1}`, seq: i + 1, ts: `2026-11-06T10:0${i}:00Z`, ...r })).join('\n') + '\n',
    'utf8',
  )
}

// ── E1 ─────────────────────────────────────────────────────────
test('E1：夹着工作词的心里话要步进（v0.65 会挡掉）', () => {
  for (const t of [
    '刚被 leader 骂了一顿，心里堵得慌',
    'Java 又出问题了，烦',
    '这个版本上线之后我整个人都空了',
    '我今天特别开心，因为终于把那个 bug 修好了',
  ]) {
    assert.equal(hasFeel(t), true, t)
  }
})

test('E1：纯技术指令不步进；判断句也不步进', () => {
  assert.equal(hasFeel('把 handoff.js 里的 kind 加上'), false)
  assert.equal(hasFeel('我觉得这个方案不行'), false)
  assert.equal(hasFeel('这段代码看起来没问题'), false)
})

test('E1：hasFeel 和 looksLikeWork 是两个判据，不是变体', () => {
  // 「烦」在 feel 里、不在 work 里；「提交」在 work 里、不在 feel 里
  assert.equal(hasFeel('真烦'), true)
  assert.equal(looksLikeWork('真烦'), false)
  assert.equal(hasFeel('提交这个分支'), false)
  assert.equal(looksLikeWork('提交这个分支'), true)
})

// ── E2 ─────────────────────────────────────────────────────────
test('E2：纸条不记 task 会话的原话（mode 由档案带下来）', () => {
  const dir = lib()
  // 直接写两条带 mode 的老记录：一条 task、一条 daily
  writeFileSync(
    join(dir, '10_archive/messages/2026-11-06.jsonl'),
    [
      { id: 'm1', seq: 1, ts: '2026-11-06T09:00:00Z', role: 'user', session: 'w', mode: 'task', text: '把 handoff.js 里的 kind 加上' },
      { id: 'm2', seq: 2, ts: '2026-11-06T10:00:00Z', role: 'user', session: 'd', mode: 'daily', text: '今天想早点睡' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  )
  const { user } = lastExchanges(dir)
  assert.match(user, /今天想早点睡/, '日常那句要留下')
  assert.doesNotMatch(user, /handoff\.js/, '工作那句不该进纸条')
})

test('E2：老记录没有 mode → 不过滤（fail-open）', () => {
  const dir = lib()
  seed(dir, [{ session: 's1', role: 'user', text: '很久以前的话' }])
  const { user } = lastExchanges(dir)
  assert.match(user, /很久以前的话/)
})

test('E2：setSessionMode 写进档案的新记录会带 mode', async () => {
  const dir = lib()
  setSessionMode('sess-x', 'task')
  // buildRecord 是纯函数，直接造一条看字段
  const { buildRecord } = await import('../lib/archive.js')
  const rec = buildRecord('sess-x', {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    surfaceOp: 'append',
    data: { id: 'msg-abc123', role: 'user', content: [{ type: 'text', text: '改一下配置' }], source: { kind: 'user' } },
  })
  assert.equal(rec.mode, 'task')
})

// ── E3 ─────────────────────────────────────────────────────────
test('E3：任务窗读人格包只读不消费，日常窗仍能读到', () => {
  const dir = lib()
  buildHandoff(dir, { id: 'A', tail: [{ role: 'user', text: '我梦见那条河了' }], open_threads: [] })
  assert.ok(takeHandoff(dir, 'B', { mode: 'task' }), '任务窗能看到')
  assert.ok(takeHandoff(dir, 'C', { mode: 'daily' }), '日常窗还要能读到——这是 E3 的核心')
  assert.equal(takeHandoff(dir, 'D', { mode: 'daily' }), null, '第二个日常窗读不到（H7 语义不变）')
})

// ── E5 ─────────────────────────────────────────────────────────
test('E5：单会话、跨三天说同一句 → 出候选（真实用法就是这样）', () => {
  const dir = lib()
  writeFileSync(
    join(dir, '10_archive/messages/multi.jsonl'),
    [
      { id: 'a', seq: 1, session: 'long', role: 'assistant', ts: '2026-11-01T10:00:00Z', text: '才不呢' },
      { id: 'b', seq: 2, session: 'long', role: 'assistant', ts: '2026-11-02T10:00:00Z', text: '才不呢' },
      { id: 'c', seq: 3, session: 'long', role: 'assistant', ts: '2026-11-03T10:00:00Z', text: '才不呢' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  )
  assert.deepEqual(
    mineVoice(dir).map((c) => c.text),
    ['才不呢'],
    '跨三天 = 习惯；只数会话会漏掉这种唯一真实用法',
  )
})

test('E5：单会话、同一天说三遍 → 仍不出（"一次任务里刷三遍"）', () => {
  const dir = lib()
  seed(dir, [
    { session: 'long', role: 'assistant', text: '才不呢' },
    { session: 'long', role: 'assistant', text: '才不呢' },
    { session: 'long', role: 'assistant', text: '才不呢' },
  ])
  assert.deepEqual(mineVoice(dir).map((c) => c.text), [])
})

// ── E6 ─────────────────────────────────────────────────────────
test('E6：looksLikeWork 只有一份定义，wakeup 用的是同一份', () => {
  assert.equal(wakeup.looksLikeWork, textkind.looksLikeWork, '两处必须是同一个函数引用')
})
