// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * books.js — 书源（v0.22.0）：**书在库外，库里只留"读过的痕迹"**。
 *
 * 为什么要有它：给一个陪伴 agent 喂小说，正确形态不是"把书塞进记忆库"——
 * 全书几十万 token，进档案就等于每次翻档案都可能把整本书捞出来；而她要的不是
 * 背原文，是**记住几个让她有波动的地方 + 对整本书的感受**。
 *
 * 所以：
 *   - 原文放在**库外**（默认 `<库>/../fish-memory-books/`，也可用 `FISH_MEMORY_BOOKS` 指定）；
 *   - 库内只有 `20_state/books.json`（书源清单：id / 标题 / 相对路径 / sha256 / 行数）；
 *   - 记忆点的 `source` 可以写 `book:<id>#L<行号>`，`quote` 走"逐字校验"（去书里找那一行附近）；
 *   - 这样一来：**原文零 token 进上下文**，注入里只有点的标题/摘要/情绪（几十 token）。
 *
 * 隐私：清单里只存**相对路径**（不存绝对路径），和 v0.14.1 的"日志不写绝对路径"一致。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'

export const BOOKS_REGISTRY = join('20_state', 'books.json')
export const BOOKS_DIRNAME = 'fish-memory-books'
export const BOOK_SOURCE_RE = /^book:([A-Za-z0-9._-]+)(?:#L(\d+))?$/

/** 书库根目录：默认在记忆库**旁边**（库外），可用环境变量覆盖 */
export function booksRoot(dir) {
  const env = process.env.FISH_MEMORY_BOOKS
  if (env && env.trim()) return resolve(env.trim())
  return join(dirname(resolve(dir)), BOOKS_DIRNAME)
}

export function loadBooks(dir) {
  const raw = readJsonSafe(join(dir, BOOKS_REGISTRY), { version: 1, books: {} })
  const books = raw && typeof raw === 'object' && raw.books && typeof raw.books === 'object' ? raw.books : {}
  return { version: 1, books }
}

export function saveBooks(dir, reg) {
  atomicWriteJson(join(dir, BOOKS_REGISTRY), { version: 1, books: reg.books })
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const countLines = (text) => text.split(/\r?\n/).length

const slug = (s) =>
  String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'book'

/**
 * 登记一本书：把原文**拷进库外的书库目录**（不拷进记忆库），返回清单项。
 * 已登记过同一 sha256 就复用（不重复拷）。
 */
export function addBook(dir, file, { title } = {}) {
  const src = resolve(file)
  if (!existsSync(src)) throw new Error(`找不到书文件：${src}`)
  const st = statSync(src)
  if (!st.isFile()) throw new Error(`不是一个文件：${src}`)

  const sha = sha256File(src)
  const reg = loadBooks(dir)
  const dup = Object.values(reg.books).find((b) => b.sha256 === sha)
  if (dup) return { entry: dup, reused: true }

  const text = readFileSync(src, 'utf8')
  const name = String(title || basename(src).replace(/\.[^.]+$/, '')).trim()
  // id 必须是 ASCII：它要出现在 `source: [book:<id>#L<n>]` 里，
  // 而解析/校验用的正则是 `[A-Za-z0-9._-]+`。书名（可能是中文）单独存在 title。
  const id = `book-${sha.slice(0, 10)}`

  const root = booksRoot(dir)
  mkdirSync(root, { recursive: true })
  const rel = `${id}.txt`
  const dest = join(root, rel)
  if (!existsSync(dest)) copyFileSync(src, dest)

  const entry = {
    id,
    title: name,
    rel, // 相对 paths：不写绝对路径（分享/备份时不带用户名）
    bytes: st.size,
    sha256: sha,
    lines: countLines(text),
    added_at: new Date().toISOString(),
  }
  reg.books[id] = entry
  saveBooks(dir, reg)
  return { entry, reused: false }
}

/** 解析一个 `book:<id>#L<n>` 引用 */
export function parseBookSource(sid) {
  const m = BOOK_SOURCE_RE.exec(String(sid || ''))
  if (!m) return null
  return { id: m[1], line: m[2] ? Number(m[2]) : null }
}

/** 书文件在本机的绝对路径（清单里只有相对路径） */
export function bookPath(dir, entry) {
  if (!entry?.rel) return null
  const p = join(booksRoot(dir), entry.rel)
  return isAbsolute(p) ? p : resolve(p)
}

/**
 * 校验一本书还在不在、还是不是当初那本。
 * @returns {{ok:boolean, reason?:string, at?:string}}
 */
export function verifyBook(dir, entry) {
  if (!entry) return { ok: false, reason: '清单里没有这本书' }
  const p = bookPath(dir, entry)
  if (!p || !existsSync(p)) return { ok: false, reason: `书文件不在了：${entry.rel}（书库根：${booksRoot(dir)}）` }
  const sha = sha256File(p)
  if (sha !== entry.sha256) return { ok: false, reason: '书的 sha256 变了（换过文件？）' }
  return { ok: true, at: p }
}

/**
 * 在书里找一段原话（逐字）。给了行号就只在那一行附近找（±window），
 * 不给就在全书中找。返回 `{found, line}`。
 *
 * 为什么给行号要限制窗口：全书里同一句话可能重复出现；限定窗口才能证明
 * "这条点引的是这一段"，而不是"书里碰巧也有这句话"。
 */
export function findQuoteInBook(dir, entry, quote, { line = null, window = 20 } = {}) {
  const p = bookPath(dir, entry)
  if (!p || !existsSync(p)) return { found: false, reason: '书文件不在了' }
  const q = String(quote || '').replace(/\s+/g, '')
  if (!q) return { found: false, reason: '没有原话' }
  const lines = readFileSync(p, 'utf8').split(/\r?\n/)
  const norm = (s) => String(s).replace(/\s+/g, '')

  if (line && Number.isFinite(line)) {
    const from = Math.max(0, line - 1 - window)
    const to = Math.min(lines.length, line + window)
    for (let i = from; i < to; i++) {
      if (norm(lines[i]).includes(q)) return { found: true, line: i + 1 }
    }
    return { found: false, reason: `第 ${line} 行附近（±${window}）找不到这句原话` }
  }
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]).includes(q)) return { found: true, line: i + 1 }
  }
  return { found: false, reason: '全书里找不到这句原话' }
}

/** 给人看的清单（`memory book list`） */
export function listBooks(dir) {
  const reg = loadBooks(dir)
  return Object.values(reg.books).map((b) => ({ ...b, present: verifyBook(dir, b).ok }))
}

export { relative }
