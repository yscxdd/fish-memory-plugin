// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 书源（v0.22.0）：喂小说但不把书塞进记忆库。
 *
 * 目标是"她记住高潮和她当时的情绪 + 能聊整本书的感受"，不是背原文。
 * 所以这里钉住四件事：
 *   ① 原文进**库外**书库目录（`<库>/../fish-memory-books`），记忆库里只有清单；
 *   ② 清单里只存**相对路径**（不写绝对路径，分享时不带用户名）；
 *   ③ 点的 source 可以写 `book:<id>#L<n>`，`quote` 会在那一行附近逐字校验；
 *   ④ 清单里没有这本书 = 断链（audit 阻塞）；书不在本机 = 提醒（不阻塞）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ANCHOR_LINES } from '../lib/guard.js'
import { addBook, booksRoot, findQuoteInBook, listBooks, loadBooks, parseBookSource, verifyBook } from '../lib/books.js'
import { audit, buildIndex, validatePoint, writeIndex } from '../lib/toolkit.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fishmem-book-'))
  const dir = join(root, 'fish-memory')
  for (const d of ['00_core', '10_archive/messages', '20_state', '20_index', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), ['# SOUL', '', ...ANCHOR_LINES, ''].join('\n'), 'utf8')
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  const book = join(root, 'novel.txt')
  const lines = ['第一章', '', '他站在雨里，没有回头。', '', '她说：你别走。', '', '风把伞吹翻了。']
  writeFileSync(book, lines.join('\n'), 'utf8')
  return { root, dir, book, lines }
}

test('登记：原文进库外书库目录，清单里只有相对路径', () => {
  const { root, dir, book } = fixture()
  const { entry } = addBook(dir, book, { title: '雨夜' })
  assert.equal(entry.title, '雨夜')
  assert.ok(entry.id.startsWith('book-'), 'id 必须是 ASCII（要写进 source 引用里）')
  assert.equal(entry.rel.includes('\\'), false, 'rel 是文件名，不带目录分隔符')
  assert.ok(!JSON.stringify(entry).includes(root), '清单里不许出现绝对路径')

  const rootDir = booksRoot(dir)
  assert.equal(rootDir, join(root, 'fish-memory-books'), '书库默认在记忆库旁边（库外）')
  assert.ok(verifyBook(dir, entry).ok, '刚拷进去的书应当可校验')

  const reg = loadBooks(dir)
  assert.equal(Object.keys(reg.books).length, 1)
  assert.deepEqual(listBooks(dir)[0].present, true)
})

test('重复登记同一本书：按 sha256 复用，不再拷一份', () => {
  const { dir, book } = fixture()
  const a = addBook(dir, book)
  const b = addBook(dir, book)
  assert.equal(b.reused, true)
  assert.equal(b.entry.id, a.entry.id)
  assert.equal(Object.keys(loadBooks(dir).books).length, 1)
})

test('书源引用解析 + 原话在指定行附近逐字校验', () => {
  const { dir, book, lines } = fixture()
  const { entry } = addBook(dir, book)
  const ref = parseBookSource(`book:${entry.id}#L5`)
  assert.deepEqual(ref, { id: entry.id, line: 5 })

  const ok = findQuoteInBook(dir, entry, '她说：你别走。', { line: 5 })
  assert.equal(ok.found, true)
  assert.equal(ok.line, 5)

  const wrongLine = findQuoteInBook(dir, entry, '她说：你别走。', { line: 40 })
  assert.equal(wrongLine.found, false, '不在窗口里就不算（防"书里碰巧也有这句"）')

  const notThere = findQuoteInBook(dir, entry, '她笑了。', { line: 5 })
  assert.equal(notThere.found, false)
  assert.ok(lines.length > 0)
})

test('validatePoint：书源合法则过；清单里没有该书 = 硬错误', () => {
  const { dir, book } = fixture()
  const { entry } = addBook(dir, book)
  const books = loadBooks(dir).books
  const archive = { byId: new Map() }

  const ok = validatePoint(
    {
      id: 'M-2026-11-01-001',
      title: '雨夜那段',
      quote: '她说：你别走。',
      quote_by: 'her',
      date: '2026-11-01',
      salience: 4,
      type: 'event',
      cluster: '读物',
      status: 'active',
      source: [`book:${entry.id}#L5`],
      links: [],
      summary: '读到这句她心里一沉。',
    },
    { archive, books, dir },
  )
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors))

  const dangling = validatePoint(
    {
      id: 'M-2026-11-01-002',
      title: 'x',
      quote: null,
      date: '2026-11-01',
      salience: 3,
      type: 'event',
      cluster: '读物',
      status: 'active',
      source: ['book:不存在的书#L1'],
      links: [],
      summary: 'x',
    },
    { archive, books, dir },
  )
  assert.ok(dangling.errors.some((e) => e.field === 'source'), JSON.stringify(dangling.errors))
})

test('quote 与书里对不上 = 硬错误（书源也要逐字）', () => {
  const { dir, book } = fixture()
  const { entry } = addBook(dir, book)
  const books = loadBooks(dir).books
  const r = validatePoint(
    {
      id: 'M-2026-11-01-003',
      title: 'x',
      quote: '她笑了。', // 书里没有
      date: '2026-11-01',
      salience: 3,
      type: 'event',
      cluster: '读物',
      status: 'active',
      source: [`book:${entry.id}#L5`],
      links: [],
      summary: 'x',
    },
    { archive: { byId: new Map() }, books, dir },
  )
  assert.ok(r.errors.some((e) => e.field === 'quote'), JSON.stringify(r.errors))
})

test('audit：清单里有书就过；书文件被删 = 提醒（不阻塞）；清掉清单项 = 断链（阻塞）', () => {
  const { dir, book } = fixture()
  const { entry } = addBook(dir, book)
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    [
      '---', 'id: M-2026-11-01-001', 'title: 雨夜那段', 'quote: 她说：你别走。', 'quote_by: her',
      'date: 2026-11-01', 'salience: 4', 'type: event', 'cluster: 读物', 'event: null', 'tags: []',
      'status: active', `source: [book:${entry.id}#L5]`, 'links: []', '---', '',
      '<!-- SUM -->', '读到这句她心里一沉。', '<!-- /SUM -->', '',
    ].join('\n'),
    'utf8',
  )

  writeFileSync(
    join(dir, '00_core/rules.md'),
    ['# 规则', '', '1. 我最怕被当成 AI 讨论。', '2. 我绝不会说：作为一个 AI。', '3. 我不会给人生建议。', ''].join('\n'),
    'utf8',
  )
  writeIndex(dir, buildIndex([{ id: 'M-2026-11-01-001', title: '雨夜那段', salience: 4, date: '2026-11-01', cluster: '读物', tags: [], status: 'active', type: 'event', summary: '读到这句她心里一沉。' }], { now: new Date('2026-11-01T00:00:00Z') }))
  const report = audit(dir)
  const c = report.checks.find((x) => x.id === 'book_source')
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(report.passed, true, '正常情况审计应通过')

  // 书文件不在了 → missing，但不算断链
  writeFileSync(join(dir, '20_state/books.json'), JSON.stringify({ version: 1, books: { [entry.id]: { ...entry, rel: 'moved-away.txt' } } }), 'utf8')
  const r2 = audit(dir).checks.find((x) => x.id === 'book_source')
  assert.equal(r2.missing, 1, JSON.stringify(r2))
  assert.equal(r2.ok, true, '书不在本机不该阻塞审计（换机器就可能没有）')

  // 清单里没有这本书 → 断链，阻塞
  writeFileSync(join(dir, '20_state/books.json'), JSON.stringify({ version: 1, books: {} }), 'utf8')
  const r3 = audit(dir).checks.find((x) => x.id === 'book_source')
  assert.equal(r3.dangling, 1)
  assert.equal(r3.ok, false, '引用指向不存在的书 = 溯源断了')
  assert.equal(audit(dir).passed, false)
})

test('清单是纯 JSON、可被 check 读（不破坏现有命令）', () => {
  const { dir, book } = fixture()
  addBook(dir, book)
  const raw = readFileSync(join(dir, '20_state/books.json'), 'utf8')
  assert.ok(!raw.startsWith('\uFEFF'), '清单不能带 BOM')
  const reg = JSON.parse(raw)
  assert.equal(reg.version, 1)
  assert.ok(Object.values(reg.books)[0].sha256.match(/^[0-9a-f]{64}$/))
})
