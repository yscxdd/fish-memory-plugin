// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 到期块必须**包含逾期**（v0.63.1）。
 *
 * 这条是一个真实的返工：v0.63.0 的 `dueTodayOf` 只比 `due === today`，
 * 于是**逾期没办的事一件都不显示**——而那恰恰是最该被看见的。
 * 教训：写"今天"的时候，最容易漏掉的就是"昨天没做完的"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dueTodayOf } from '../lib/today.js'

const NOW = new Date(2026, 10, 6, 12, 0, 0)

function lib(points) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-due-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  for (const p of points) {
    writeFileSync(
      join(dir, '30_points', `${p.id}.md`),
      [
        '---',
        `id: ${p.id}`,
        `title: ${p.title}`,
        'date: 2026-11-01',
        `type: ${p.type}`,
        `due: ${p.due}`,
        'salience: 3',
        'status: active',
        'source: []',
        'links: []',
        '---',
        '',
        '<!-- SUM -->',
        p.title,
        '<!-- /SUM -->',
      ].join('\n'),
      'utf8',
    )
  }
  return dir
}

test('逾期要显示，而且排在今天的前面', () => {
  const dir = lib([
    { id: 'M-2026-11-01-001', title: '昨天该办的事', type: 'promise', due: '2026-11-05' },
    { id: 'M-2026-11-01-002', title: '今天该办的事', type: 'promise', due: '2026-11-06' },
  ])
  const r = dueTodayOf(dir, NOW)
  assert.equal(r.overdue, 1)
  assert.equal(r.today, 1)
  assert.match(r.text, /逾期/)
  assert.ok(r.titles[0].includes('逾期'), `逾期该排第一，实际：${r.titles[0]}`)
})

test('只有逾期、没有今天到期时，也不能说"没有到期的"', () => {
  const dir = lib([{ id: 'M-2026-11-01-001', title: '拖了很久的事', type: 'promise', due: '2026-10-30' }])
  const r = dueTodayOf(dir, NOW)
  assert.equal(r.ok, true)
  assert.equal(r.overdue, 1)
  assert.ok(!r.text.includes('没有到期的'), r.text)
})

test('已经失效/非 active 的不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-due2-'))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-003.md'),
    '---\nid: M-2026-11-01-003\ntitle: 已作废\ndate: 2026-11-01\ntype: promise\ndue: 2026-11-05\nsalience: 3\nstatus: demoted\nsource: []\nlinks: []\n---\n\n<!-- SUM -->\nx\n<!-- /SUM -->\n',
    'utf8',
  )
  assert.equal(dueTodayOf(dir, NOW).count, 0)
})

test('干净的时候明说"没有到期的"', () => {
  const dir = lib([])
  const r = dueTodayOf(dir, NOW)
  assert.equal(r.ok, false)
  assert.match(r.text, /没有到期/)
})
