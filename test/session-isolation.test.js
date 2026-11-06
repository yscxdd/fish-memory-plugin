// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 会话隔离（v0.65.0，S1 / S2 / S3 / S5）。
 *
 * 起因：`docs/PLAN-2026-11-06-session-contamination.md`。
 * 那一版把问题定位得很准——**库按工作区分了，会话没分**：
 * 纸条 / 交接包 / 情绪都是单文件，任何会话都能覆盖；挖掘三件套读全库，
 * 工作措辞会被当成她的口癖。
 *
 * 钉住：
 *   ① `readArchive` 能按会话过滤（默认行为不变）；
 *   ② task 会话不写纸条（字节不变）；
 *   ③ 任务包不给日常窗看，**而且不标记已读**（H7 的翻版）；
 *   ④ 口癖/别名要**跨会话**证据——一次任务里说三遍不算习惯。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHandoff, takeHandoff } from '../lib/handoff.js'
import { maybeWriteWere } from '../lib/were.js'
import { mineVoice } from '../lib/voice.js'
import { mineAliases } from '../lib/alias.js'
import { readArchive } from '../lib/toolkit.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-layer-'))
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

test('S3：readArchive 能按会话过滤（默认仍是全量）', () => {
  const dir = lib()
  seed(dir, [
    { session: 'A', role: 'user', text: '甲的' },
    { session: 'A', role: 'user', text: '甲的2' },
    { session: 'B', role: 'user', text: '乙的' },
  ])
  assert.equal(readArchive(dir).messages.length, 3, '不传就全量')
  assert.equal(readArchive(dir, { session: 'A' }).messages.length, 2)
  assert.equal(readArchive(dir, { session: 'B' }).messages.length, 1)
})

test('S1：task 会话不写纸条（字节不变）', () => {
  const dir = lib()
  maybeWriteWere(dir, { gap: 10, points: [], mode: 'daily' })
  const before = readFileSync(join(dir, '20_state/where-we-were.md'), 'utf8')

  const r = maybeWriteWere(dir, { gap: 10, points: [], mode: 'task' })
  assert.equal(r.written, false)
  assert.equal(r.reason, 'task-session')
  assert.equal(readFileSync(join(dir, '20_state/where-we-were.md'), 'utf8'), before, '纸条字节不该被任务会话改')
})

test('S1：任务包不给日常窗看，而且不标记已读', () => {
  const dir = lib()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '这个报错怎么修' }], open_threads: [] }, new Date(), { kind: 'task' })

  assert.equal(takeHandoff(dir, 's2', { mode: 'daily' }), null, '日常窗不该读任务包')

  // 关键：没读走 → 任务窗还能拿到（H7 的翻版：别静默吃掉）
  const got = takeHandoff(dir, 's3', { mode: 'task' })
  assert.ok(got && got.includes('这个报错怎么修'), '任务窗该能读到')
})

test('S1：人格包谁的窗都能读（旧包没有 kind，按 persona）', () => {
  const dir = lib()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '今天下雨了' }], open_threads: [] }, new Date())
  assert.ok(takeHandoff(dir, 's2', { mode: 'daily' }), '日常窗能读')
})

test('S5：口癖要跨会话——一个会话里说三遍不算', () => {
  const dir = lib()
  seed(dir, [
    { session: 'A', role: 'assistant', text: '才不呢' },
    { session: 'A', role: 'assistant', text: '才不呢' },
    { session: 'A', role: 'assistant', text: '才不呢' },
  ])
  assert.deepEqual(mineVoice(dir).map((c) => c.text), [], '同一会话重复不算习惯')

  const dir2 = lib()
  seed(dir2, [
    { session: 'A', role: 'assistant', text: '才不呢' },
    { session: 'B', role: 'assistant', text: '才不呢' },
  ])
  assert.deepEqual(mineVoice(dir2).map((c) => c.text), ['才不呢'], '跨两个会话才算')
})

test('S2：工作产出不进口癖候选', () => {
  const dir = lib()
  seed(dir, [
    { session: 'A', role: 'assistant', text: '我先跑一遍测试' },
    { session: 'B', role: 'assistant', text: '我先跑一遍测试' },
  ])
  assert.deepEqual(mineVoice(dir).map((c) => c.text), [], '带"测试"的工作话不该成为口癖')
})

test('S5：别名要跨会话——同一任务里刷三遍不算', () => {
  const dir = lib()
  seed(dir, [
    { session: 'A', role: 'user', text: '关节 和 膝盖 都疼' },
    { session: 'A', role: 'user', text: '关节 疼，膝盖也疼' },
    { session: 'A', role: 'user', text: '膝盖 那块的关节 不行了' },
  ])
  const point = { id: 'M-2026-11-06-001', date: '2026-11-06', tags: ['关节'], title: '关节', summary: '关节' }
  const one = mineAliases(dir, point, { minSupport: 3 })
  assert.equal(one.candidates.filter((c) => c.term === '膝盖').length, 0, '同一会话刷三遍不成立')

  const dir2 = lib()
  seed(dir2, [
    { session: 'A', role: 'user', text: '关节 和 膝盖 都疼' },
    { session: 'B', role: 'user', text: '关节 疼，膝盖也疼' },
    { session: 'C', role: 'user', text: '膝盖 那块的关节 不行了' },
  ])
  const three = mineAliases(dir2, point, { minSupport: 3 })
  assert.equal(three.candidates.filter((c) => c.term === '膝盖').length, 1, '跨三个会话才成立')
})
