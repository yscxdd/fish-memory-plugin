// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 素材源（v0.23.0）：`asset:<kind>:<id>` 泛化。
 *
 * v0.22.0 只支持"书"，但真实需求里还有文档、图片、音视频、语音转写。
 * 这一版把 `book:` 泛化成 `asset:<kind>:<id>`，并钉住三条边界：
 *   ① 文本类（book/doc/transcript）才验"原话逐字"，且限定在引用行 ±20 行；
 *   ② 非文本类（image/audio/video）**不要求 quote**，只验文件存在 + sha256 未变；
 *   ③ 旧的 `book:<id>#L<n>` 与旧清单 `books.json` 仍然认（不逼用户改历史）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ASSET_KINDS,
  addAsset,
  assetsRoot,
  findQuoteInAsset,
  listAssets,
  loadAssets,
  parseAssetSource,
  verifyAsset,
} from '../lib/assets.js'
import { audit, buildIndex, validatePoint, writeIndex } from '../lib/toolkit.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fishmem-asset-'))
  const dir = join(root, 'fish-memory')
  for (const d of ['00_core', '10_archive/messages', '20_state', '20_index', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n', 'utf8')
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return { root, dir }
}

const doc = (root) => {
  const p = join(root, '方案.md')
  writeFileSync(p, ['# 方案', '', '第三节要重写。', '', '结论：先做小样。'].join('\n'), 'utf8')
  return p
}

test('三种类型：doc 逐字验、image 只验 sha、transcript 当文本', () => {
  const { root, dir } = fixture()
  const d = addAsset(dir, doc(root), { title: '方案', kind: 'doc' }).entry
  assert.equal(d.kind, 'doc')
  assert.ok(d.rel.startsWith('doc/'), `rel 应带类型目录：${d.rel}`)
  assert.equal(findQuoteInAsset(dir, d, '第三节要重写。', { line: 3 }).found, true)

  // 图片：内容随便，但 sha 要对得上；原话校验直接放行（没有文本可比）
  const img = join(root, 'pic.png')
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  const i = addAsset(dir, img, { title: '一张图', kind: 'image' }).entry
  assert.equal(i.kind, 'image')
  assert.equal(i.lines, null, '图片没有行数')
  assert.equal(verifyAsset(dir, i).ok, true)
  assert.deepEqual(findQuoteInAsset(dir, i, '随便一句'), { found: true, binary: true })

  const t = join(root, '转写.txt')
  writeFileSync(t, ['他说：晚安。', '她说：嗯。'].join('\n'), 'utf8')
  const tr = addAsset(dir, t, { title: '语音转写', kind: 'transcript' }).entry
  assert.equal(tr.kind, 'transcript')
  assert.equal(findQuoteInAsset(dir, tr, '她说：嗯。', { line: 2 }).found, true)

  assert.equal(Object.keys(ASSET_KINDS).length, 6)
  assert.equal(listAssets(dir).length, 3)
})

test('引用解析：新写法三种 kind + 旧 book 写法仍然认', () => {
  assert.deepEqual(parseAssetSource('asset:doc:asset-abc123#L12'), { kind: 'doc', id: 'asset-abc123', line: 12 })
  assert.deepEqual(parseAssetSource('asset:image:asset-abc123'), { kind: 'image', id: 'asset-abc123', line: null })
  assert.deepEqual(parseAssetSource('book:book-abc123#L5'), { kind: 'book', id: 'book-abc123', line: 5 })
  assert.equal(parseAssetSource('msg-123'), null)
  assert.equal(parseAssetSource('asset:doc:bad id'), null)
})

test('旧清单 books.json 能读（v0.22.0 的库不逼用户迁移）', () => {
  const { root, dir } = fixture()
  const legacy = {
    version: 1,
    books: {
      'book-legacy01': {
        id: 'book-legacy01',
        title: '旧书',
        rel: 'book-legacy01.txt',
        bytes: 10,
        sha256: 'a'.repeat(64),
        lines: 3,
      },
    },
  }
  writeFileSync(join(dir, '20_state/books.json'), JSON.stringify(legacy), 'utf8')
  const reg = loadAssets(dir)
  assert.equal(reg.books['book-legacy01'].kind, 'book', '旧清单项要补成 kind=book')
  assert.equal(assetsRoot(dir), join(root, 'fish-memory-assets'))
})

test('validatePoint：图片源不需要 quote；文本源的 quote 对不上照样报错', () => {
  const { root, dir } = fixture()
  const d = addAsset(dir, doc(root), { title: '方案', kind: 'doc' }).entry
  const img = join(root, 'p2.png')
  writeFileSync(img, Buffer.from([1, 2, 3, 4]))
  const i = addAsset(dir, img, { title: '图', kind: 'image' }).entry
  const books = loadAssets(dir).books
  const base = {
    id: 'M-2026-11-01-001',
    title: 'x',
    date: '2026-11-01',
    salience: 3,
    type: 'event',
    cluster: '素材',
    status: 'active',
    links: [],
    summary: 'x',
  }

  const withImage = validatePoint({ ...base, quote: null, source: [`asset:image:${i.id}`] }, { archive: { byId: new Map() }, books, dir })
  assert.equal(withImage.errors.length, 0, JSON.stringify(withImage.errors))

  const badQuote = validatePoint({ ...base, quote: '这句文档里没有', source: [`asset:doc:${d.id}#L3`] }, { archive: { byId: new Map() }, books, dir })
  assert.ok(badQuote.errors.some((e) => e.field === 'quote'), JSON.stringify(badQuote.errors))
})

test('audit：asset_source 正常通过；清单里没有这个素材 = 断链阻塞', () => {
  const { root, dir } = fixture()
  const d = addAsset(dir, doc(root), { title: '方案', kind: 'doc' }).entry
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    [
      '---', 'id: M-2026-11-01-001', 'title: 方案第三节', 'quote: 第三节要重写。', 'quote_by: him',
      'date: 2026-11-01', 'salience: 4', 'type: event', 'cluster: 素材', 'event: null', 'tags: []',
      'status: active', `source: [asset:doc:${d.id}#L3]`, 'links: []', '---', '',
      '<!-- SUM -->', '他说第三节要重写，结论是先做小样。', '<!-- /SUM -->', '',
    ].join('\n'),
    'utf8',
  )
  writeIndex(dir, buildIndex([{ id: 'M-2026-11-01-001', title: '方案第三节', salience: 4, date: '2026-11-01', cluster: '素材', tags: [], status: 'active', type: 'event', summary: '他说第三节要重写。' }], { now: new Date('2026-11-01T00:00:00Z') }))

  const c1 = audit(dir).checks.find((x) => x.id === 'asset_source')
  assert.equal(c1.ok, true, JSON.stringify(c1))

  writeFileSync(join(dir, '20_state/assets.json'), JSON.stringify({ version: 1, books: {} }), 'utf8')
  const c2 = audit(dir).checks.find((x) => x.id === 'asset_source')
  assert.equal(c2.dangling, 1)
  assert.equal(c2.ok, false)
})
