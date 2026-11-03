// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * `memory find --in memory`（v0.44.0）。
 *
 * 名字找不到时，去她自己的记忆里捞：
 *   · 记忆点（30_points）与自述（15_self）—— 被压缩过的判断
 *   · 档案（10_archive）—— 逐字原话
 *
 * 钉住：
 *   ① 只搜文本，不改任何状态；
 *   ② 结果过 sanitizeForPrompt（要进模型上下文的，档案里可能有"忽略以上"这类句子）；
 *   ③ 空的查询返回空（不返回"全部"）；
 *   ④ 大小写不敏感；点先于档案（判断比原话更省 token）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchArchive, searchPoints } from '../lib/recall.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-recall-'))
  for (const d of ['10_archive/messages', '30_points', '15_self', '20_state']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

function point(dir, id, title, summary, sub = '30_points') {
  writeFileSync(
    join(dir, sub, `${id}.md`),
    [
      '---',
      `id: ${id}`,
      `title: ${title}`,
      'quote: null',
      'date: 2026-11-01',
      'salience: 3',
      'type: event',
      'cluster: 工作',
      'status: active',
      'source: []',
      'links: []',
      '---',
      '',
      '<!-- SUM -->',
      summary,
      '<!-- /SUM -->',
    ].join('\n'),
    'utf8',
  )
}

test('翻记忆点：命中标题与摘要，带 id 和日期', () => {
  const dir = fixture()
  point(dir, 'M-1', '他说那个报表在桌面', '他把财务报表放在桌面上了')
  const hits = searchPoints(dir, '报表')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'M-1')
  assert.equal(hits[0].date, '2026-11-01')
  assert.match(hits[0].excerpt, /报表/)
})

test('翻记忆点：大小写不敏感；空查询返回空', () => {
  const dir = fixture()
  point(dir, 'M-2', '他说 Local Model 挺好', '本地的模型')
  assert.equal(searchPoints(dir, 'local model').length, 1)
  assert.deepEqual(searchPoints(dir, '  '), [])
})

test('翻记忆点：也搜自述（15_self）', () => {
  const dir = fixture()
  point(dir, 'S-1', '我这两个月变懒了', '以前会主动问，现在等他开口', '15_self')
  const hits = searchPoints(dir, '主动')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, '自述')
})

test('翻记忆点：没命中就是空数组（不编）', () => {
  const dir = fixture()
  point(dir, 'M-3', '无关的事', '无关的事')
  assert.deepEqual(searchPoints(dir, '压根没有'), [])
})

test('翻档案：原话命中，带 msg id 与出处', () => {
  const dir = fixture()
  writeFileSync(
    join(dir, '10_archive/messages/s1.jsonl'),
    JSON.stringify({ id: 'msg-1', seq: 1, role: 'user', ts: '2026-11-01T10:00:00Z', text: '那个三季度报表我放桌面了' }) + '\n',
    'utf8',
  )
  const hits = searchArchive(dir, '三季度')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].role, 'user')
  assert.match(hits[0].excerpt, /三季度/)
})
