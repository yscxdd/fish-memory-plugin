// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * v0.23.1：从别家抄回来的两条小东西。
 *
 * ① **素材点自动带别名**：SillyTavern MemoryBooks 那套是"记忆条目靠关键词激活"，
 *    我们的等价物是点的 `aliases`，但以前要人手写 → "读完一本书，下次提书名却想不起来"。
 * ② **一本书至少 1 条总评**：只留碎片没有总评，聊"整体感受"时没有打底。
 *
 * 另外钉住：别名是**纯加法**（不改已有别名、不碰正文），删掉也不影响点。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAsset } from '../lib/assets.js'
import { assetAliases, assetSummary, patchAliases } from '../lib/toolkit.js'

const POINT = (over = {}) => ({
  id: 'M-2026-11-01-001',
  title: '雨夜那句别走',
  quote: '她说：你别走。',
  date: '2026-11-01',
  salience: 4,
  type: 'event',
  cluster: '读物',
  tags: [],
  aliases: [],
  status: 'active',
  source: [],
  ...over,
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fishmem-alias-'))
  const dir = join(root, 'fish-memory')
  for (const d of ['00_core', '20_state', '30_points', '40_pending']) mkdirSync(join(dir, d), { recursive: true })
  const book = join(root, '雨夜.txt')
  writeFileSync(book, ['第一章', '', '她说：你别走。'].join('\n'), 'utf8')
  return { root, dir, book }
}

test('别名：素材的标题与类型自动进 aliases；同一素材只加一次', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  const books = { [entry.id]: entry }
  const p = POINT({ source: [`asset:book:${entry.id}#L3`] })

  const got = assetAliases(p, books)
  assert.deepEqual(got, ['雨夜', '书'])
  assert.deepEqual(assetAliases(p, books), got, '重复调用不该变')
  assert.deepEqual(assetAliases(p, {}), [], '清单里没有就不加')
  assert.deepEqual(assetAliases(POINT({ source: ['msg-1'] }), books), [], 'msg 来源不加别名')
})

test('patchAliases：没有 aliases 就插；有就合并；不碰正文', () => {
  const raw = '---\nid: M-1\ntitle: x\nlinks: []\n---\n\n正文不动\n'

  const a = patchAliases(raw, ['雨夜', '书'])
  assert.deepEqual(a.added, ['雨夜', '书'])
  assert.match(a.raw, /^aliases: \[雨夜, 书\]$/m)
  assert.match(a.raw, /正文不动/)

  const b = patchAliases(a.raw, ['雨夜', '第三样'])
  assert.deepEqual(b.added, ['第三样'], '已有的不重复加')
  assert.match(b.raw, /^aliases: \[雨夜, 书, 第三样\]$/m)

  const c = patchAliases(raw, [])
  assert.equal(c.raw, raw, '没东西可加时原文一个字节都不动')
})

test('assetSummary：≥3 条点但没有 key 点要报出来；有 key 点就不报', () => {
  const { dir, book } = fixture()
  const { entry } = addAsset(dir, book, { title: '雨夜', kind: 'book' })
  const books = { [entry.id]: entry }
  const s = `asset:book:${entry.id}#L3`

  const three = [POINT({ id: 'a', source: [s] }), POINT({ id: 'b', source: [s] }), POINT({ id: 'c', source: [s] })]
  const r1 = assetSummary(three, books)
  assert.equal(r1.rows[0].count, 3)
  assert.deepEqual(r1.missingKey.map((x) => x.id), [entry.id])

  const withKey = [...three, POINT({ id: 'k', key: true, source: [s] })]
  const r2 = assetSummary(withKey, books)
  assert.deepEqual(r2.missingKey, [], '有总评点就不提醒')

  const two = three.slice(0, 2)
  assert.deepEqual(assetSummary(two, books).missingKey, [], '不足 3 条不提醒（碎片还太少）')
})
