// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 素材退役（v0.24.0）：书改版、文档出新稿时，"我知道它变了"要有个地方说。
 *
 * 钉四件事：
 *   ① 退役不删清单、不删文件、不动任何点；
 *   ② `audit` 不再把退役素材算成"素材丢了"（但会数出来）；
 *   ③ `validatePoint` 对退役素材只给 warning（引用仍可核对）；
 *   ④ 可以撤销（换回来）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAsset, isRetired, listAssets, loadAssets, retireAsset, unretireAsset } from '../lib/assets.js'
import { audit, buildIndex, validatePoint, writeIndex } from '../lib/toolkit.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fishmem-retire-'))
  const dir = join(root, 'fish-memory')
  for (const d of ['00_core', '10_archive/messages', '20_state', '20_index', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n', 'utf8')
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  const book = join(root, '小说.txt')
  writeFileSync(book, ['第一章', '', '她说：你别走。'].join('\n'), 'utf8')
  return { root, dir, book }
}

test('退役：标记落在清单里，文件与点都不动', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  const r = retireAsset(dir, entry.id, { reason: '出新版了' })
  assert.equal(r.ok, true)
  assert.equal(isRetired(r.entry), true)
  assert.equal(r.entry.retired_reason, '出新版了')

  const back = loadAssets(dir).books[entry.id]
  assert.equal(isRetired(back), true, '要落盘')
  assert.equal(back.rel, entry.rel, '文件路径不变')
  assert.equal(listAssets(dir).find((x) => x.id === entry.id).retired, true)
})

test('撤销退役', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  retireAsset(dir, entry.id)
  unretireAsset(dir, entry.id)
  assert.equal(isRetired(loadAssets(dir).books[entry.id]), false)
})

test('audit：退役素材不算"丢了"，但会数出来', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    [
      '---', 'id: M-2026-11-01-001', 'title: 雨夜那句', 'quote: 她说：你别走。', 'quote_by: her',
      'date: 2026-11-01', 'salience: 4', 'type: event', 'cluster: 读物', 'event: null', 'tags: []',
      'status: active', `source: [asset:book:${entry.id}#L3]`, 'links: []', '---', '',
      '<!-- SUM -->', '雨里她喊别走。', '<!-- /SUM -->', '',
    ].join('\n'),
    'utf8',
  )
  writeIndex(dir, buildIndex([{ id: 'M-2026-11-01-001', title: '雨夜那句', salience: 4, date: '2026-11-01', cluster: '读物', tags: [], status: 'active', type: 'event', summary: '雨里她喊别走。' }], { now: new Date('2026-11-01T00:00:00Z') }))

  retireAsset(dir, entry.id, { reason: '换新版' })
  const c = audit(dir).checks.find((x) => x.id === 'asset_source')
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(c.retired, 1, '要能数出退役了几条引用')
  assert.equal(c.missing, 0, '退役不等于丢了')
})

test('validatePoint：退役素材只 warning，不报错', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  retireAsset(dir, entry.id)
  const books = loadAssets(dir).books
  const r = validatePoint(
    {
      id: 'M-2026-11-01-002',
      title: '雨夜那句',
      quote: '她说：你别走。',
      date: '2026-11-01',
      salience: 4,
      type: 'event',
      cluster: '读物',
      status: 'active',
      source: [`asset:book:${entry.id}#L3`],
      links: [],
      summary: '雨里她喊别走。',
    },
    { archive: { byId: new Map() }, books, dir },
  )
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  assert.ok(r.warnings.some((w) => /退役/.test(w.message)), JSON.stringify(r.warnings))
})
