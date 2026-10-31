// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 到期提醒（v0.21.0）。
 *
 * 以前 `promise` 只有"被检索命中"才会进注入，于是答应过的事可能一直没被想起。
 * 这个模块给它一个"到期"概念：`due` 字段 + 一行提醒（≤40 tok）+ 12 小时冷却。
 *
 * 钉四件事：
 *   ① 只提醒该提醒的（没到期、已失效、非 promise/event 都不提）；
 *   ② 一行最多两条，超了说"等 N 条"；
 *   ③ 冷却：同一条 12 小时内只提一次（不做每轮刷屏）；
 *   ④ 只读点、不改点（提醒记录写在 20_state/reminded.json）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../lib/store.js'
import { readPointFiles } from '../lib/toolkit.js'
import { dueLine, duePoints, freshDue, loadReminded, markReminded, remindLine } from '../lib/remind.js'

const NOW = new Date('2026-11-01T10:00:00+08:00')
const P = (over = {}) => ({
  id: 'M-2026-10-30-001',
  title: '陪他去海边',
  type: 'promise',
  status: 'active',
  date: '2026-10-30',
  due: '2026-11-01',
  ...over,
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-remind-'))
  mkdirSync(join(dir, '20_state'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  return dir
}

test('只挑该提醒的：今天/明天/逾期要，三天外/已失效/别的类型不要', () => {
  const points = [
    P({ id: 'today', due: '2026-11-01' }),
    P({ id: 'tomorrow', due: '2026-11-02' }),
    P({ id: 'overdue', due: '2026-10-28' }),
    P({ id: 'far', due: '2026-11-20' }),
    P({ id: 'done', due: '2026-11-01', status: 'merged' }),
    P({ id: 'notype', due: '2026-11-01', type: 'preference' }),
    P({ id: 'nodue', due: undefined }),
    P({ id: 'invalid', due: '2026-11-01', invalid_at: '2026-10-31' }),
  ]
  const ids = duePoints(points, NOW).map((d) => d.id)
  assert.deepEqual(ids, ['overdue', 'today', 'tomorrow'], `实际 ${ids.join(',')}`)
})

test('一行最多两条，超了说"等 N 条"；措辞按天数（今天/明天/逾期）', () => {
  const due = duePoints(
    [
      P({ id: 'a', title: '陪他去海边', due: '2026-11-01' }),
      P({ id: 'b', title: '给他回电话', due: '2026-11-02' }),
      P({ id: 'c', title: '还书', due: '2026-10-30' }),
    ],
    NOW,
  )
  const line = remindLine(due)
  assert.ok(line.text.includes('逾期2天'), line.text)
  assert.ok(line.text.includes('今天'), line.text)
  assert.ok(line.text.includes('等3条'), `超出两条要说还有几条：${line.text}`)
  assert.ok(line.tokens <= 40, `提醒块 ${line.tokens} tok 超过 40`)
  assert.equal(line.ids.length, 2)
})

test('冷却：同一条 12 小时内只提一次', () => {
  const dir = fixture()
  const points = [P()]
  const first = dueLine(dir, points, NOW)
  assert.ok(first.text, '第一次应当提')
  assert.ok(existsSync(join(dir, '20_state/reminded.json')), '要落盘冷却标记')

  const second = dueLine(dir, points, new Date(NOW.getTime() + 3600_000))
  assert.equal(second.text, '', '一小时后不许再提')

  const third = dueLine(dir, points, new Date(NOW.getTime() + 13 * 3600_000))
  assert.ok(third.text, '过了 12 小时可以再提')
})

test('只读：提醒不改任何记忆点文件', () => {
  const dir = fixture()
  const body = '---\nid: M-1\ndue: 2026-11-01\n---\n\n正文\n'
  writeFileSync(join(dir, '30_points/M-1.md'), body, 'utf8')
  dueLine(dir, [P()], NOW)
  assert.equal(readFileSync(join(dir, '30_points/M-1.md'), 'utf8'), body, '点文件一个字节都不能变')
})

test('冷却标记只存 id 与时间，不存标题/原文', () => {
  const dir = fixture()
  markReminded(dir, ['M-1'], NOW)
  const raw = readFileSync(join(dir, '20_state/reminded.json'), 'utf8')
  assert.ok(!raw.includes('海边'), `标记里不许有内容：${raw}`)
  assert.ok(raw.includes('M-1'))
  assert.ok(loadReminded(dir)['M-1'].at_ms > 0)
})

test('freshDue：没有标记的都算新鲜', () => {
  const due = duePoints([P({ id: 'x' }), P({ id: 'y' })], NOW)
  assert.equal(freshDue(due, {}, NOW).length, 2)
  assert.equal(freshDue(due, { x: { at_ms: NOW.getTime() } }, NOW).length, 1)
})

test('store 与 readPointFiles 对 due 的认知必须一致（曾经只有一边认）', () => {
  const dir = fixture()
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    ['---', 'id: M-2026-11-01-001', 'title: 陪他去海边', 'quote: null', 'date: 2026-10-30',
      'due: 2026-11-01', 'salience: 4', 'type: promise', 'cluster: 约定', 'event: null',
      'tags: []', 'status: active', 'source: []', 'links: []', '---', '', '<!-- SUM -->', '答应陪他。', '<!-- /SUM -->', ''].join('\n'),
    'utf8',
  )
  const viaFiles = readPointFiles(dir, '30_points')[0]
  const store = new MemoryStore(dir)
  const viaStore = store.points()[0]
  assert.equal(viaFiles.due, '2026-11-01')
  assert.equal(viaStore.due, '2026-11-01', 'store 也必须解析 due（两套映射不能各说各话）')
  store.dispose()
})
