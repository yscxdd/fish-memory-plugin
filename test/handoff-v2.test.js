// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 换窗交接（v0.52.0）——按 `docs/RESEARCH-2026-11-05-context-handoff.md` 补两栏。
 *
 * 钉住：
 *   ① 「我还惦记着」= 开放问题里张力最高的 1–2 条（**只读，不 touch、不涨张力**）；
 *   ② 「别再提」= 最近 7 天 resolved/dropped 的 1–2 条；
 *   ③ 两栏各最多 2 条（"下一步只写一件"，写多件等于没写）；
 *   ④ 顶部带"这是线索，不是结论"——压力下写出来的东西会走形，细节要回点链核；
 *   ⑤ 老包（没有新栏）照旧能读，不要求迁移；
 *   ⑥ 预提醒在 `prepareAt`（70%）而不是 `switchAt`（80%）：等她快满时再提醒，那时她已经变笨了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CAVEAT,
  MAX_PER_SECTION,
  buildHandoff,
  buildHandoffFromArchive,
  clearHandoff,
  doNotMention,
  readHandoff,
  regrets,
  takeHandoff,
} from '../lib/handoff.js'
import { pressureNote, PRESSURE_DEFAULTS } from '../lib/pressure.js'
import { loadQuestions, saveQuestions } from '../lib/questions.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-handoff-'))
  for (const d of ['10_archive/messages', '20_state', '30_points']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

function seedQuestions(dir, items) {
  const store = loadQuestions(dir)
  store.items = items
  saveQuestions(dir, store.items)
}

const qOpen = (id, text, createdHoursAgo) => ({
  id,
  text,
  from: 'self',
  tension: 0,
  at: new Date(Date.now() - createdHoursAgo * 3600_000).toISOString(),
  created_at: new Date(Date.now() - createdHoursAgo * 3600_000).toISOString(),
  last_touch_at: null,
  status: 'open',
})

const qResolved = (id, text, daysAgo) => ({
  ...qOpen(id, text, daysAgo * 24),
  status: 'resolved',
  resolved_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
})

test('「我还惦记着」取张力最高的 1–2 条，最多 2 条', () => {
  const dir = fixture()
  seedQuestions(dir, [qOpen('Q1', '他那天为什么突然沉默', 1), qOpen('Q2', '那句"算了"是什么意思', 2), qOpen('Q3', '第三件事', 3)])
  const r = regrets(dir)
  assert.equal(r.length, MAX_PER_SECTION)
  assert.ok(r.every((x) => typeof x === 'string'))
})

test('「别再提」只收最近 7 天解决/放下的', () => {
  const dir = fixture()
  seedQuestions(dir, [qResolved('Q1', '那件旧事', 2), qResolved('Q2', '很久以前的事', 30), qOpen('Q3', '还没想通', 1)])
  const d = doNotMention(dir)
  assert.deepEqual(d, ['那件旧事'])
})

test('交接包含两栏、带 caveat、每栏 ≤2 条', () => {
  const dir = fixture()
  seedQuestions(dir, [qOpen('Q1', '惦记一', 1), qOpen('Q2', '惦记二', 2), qResolved('Q3', '别提了', 1)])
  const r = buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '你好' }], open_threads: [] })
  assert.ok(r.text.includes('我还惦记着：'))
  assert.ok(r.text.includes('别再提：'))
  assert.ok(r.text.includes(CAVEAT))
  assert.equal(r.regrets, 2)
  assert.equal(r.doNotMention, 1)
})

test('没有问题时两栏都不出现（不写空标题）', () => {
  const dir = fixture()
  seedQuestions(dir, [])
  // v0.54.1（H6）：全空不写包，所以这里必须给一条尾巴，否则返回 null
  const r = buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '普通一句' }], open_threads: [] })
  assert.ok(!r.text.includes('我还惦记着：'))
  assert.ok(!r.text.includes('别再提：'))
})

test('老包（无新栏）仍能读；同会话不读自己的；过期不读', () => {
  const dir = fixture()
  const p = join(dir, '20_state', 'handoff.json')
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), from: 's1', text: '旧包' }), 'utf8')
  assert.equal(takeHandoff(dir, 's2'), '旧包')
  assert.equal(takeHandoff(dir, 's1'), null, '同一会话不读自己')
  writeFileSync(p, JSON.stringify({ at: new Date(Date.now() - 30 * 3600_000).toISOString(), from: 's1', text: '太旧' }), 'utf8')
  assert.equal(takeHandoff(dir, 's2'), null, '超过 24h 过期')
})

test('手动写：从档案尾部拼，且不编"没做完的事"', () => {
  const dir = fixture()
  const lines = [
    { id: 'm1', seq: 1, session: 's1', role: 'user', ts: '2026-11-04T10:00:00Z', text: '第一句' },
    { id: 'm2', seq: 2, session: 's1', role: 'assistant', ts: '2026-11-04T10:01:00Z', text: '第二句' },
  ]
  writeFileSync(join(dir, '10_archive/messages/s1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  const r = buildHandoffFromArchive(dir)
  assert.equal(r.tail, 2)
  assert.ok(!r.text.includes('没做完的事：'), '没有会话上下文时就留空，不编')
  assert.equal(readHandoff(dir)?.from, 'cli-manual')
})

test('--clear 删得掉，且删两次不报错', () => {
  const dir = fixture()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '普通一句' }], open_threads: [] })
  assert.equal(existsSync(join(dir, '20_state', 'handoff.json')), true)
  assert.equal(clearHandoff(dir).removed, true)
  assert.equal(clearHandoff(dir).removed, false)
})

test('预提醒在 prepareAt 出现，不在 switchAt（那时已该换窗了）', () => {
  const low = pressureNote(0.5)
  const prep = pressureNote(PRESSURE_DEFAULTS.prepareAt + 0.02)
  const sw = pressureNote(PRESSURE_DEFAULTS.switchAt + 0.02)
  assert.ok(!low.includes('要留话就现在写'))
  assert.ok(prep.includes('要留话就现在写'), '70% 时就要提醒她留话')
  assert.ok(!sw.includes('要留话就现在写'), '80% 时已经是"开新会话"的话术')
  assert.ok(sw.includes('开一个新会话'))
})
