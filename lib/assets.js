// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * assets.js — 素材源（v0.23.0，从 v0.22.0 的 books.js 泛化而来）。
 *
 * 一句话：**素材放在库外，库里只留"引用"和"读过的痕迹"。**
 *
 * 为什么要有它（来自实际需求）：给她喂小说、喂文档、看图、看视频，
 * 正确形态都不是"把素材塞进记忆库"——
 *   - 整本几十万 token，进档案后每次翻档案都可能把原文捞出来；
 *   - 她要的不是背原文，是**记住几个有波动的地方 + 对它的判断**。
 *
 * 所以：
 *   - 原文放在**库外**（默认 `<库>/../fish-memory-assets/<kind>/`，可用 `FISH_MEMORY_ASSETS` 改）；
 *   - 库内只有 `20_state/assets.json`（清单：id / 类型 / 标题 / 相对路径 / sha256 / 行数）；
 *   - 记忆点的 `source` 写 `asset:<kind>:<id>#L<行号>`；
 *   - 文本类（book / doc / transcript）走**逐字校验**（在指定行 ±20 行内找原话）；
 *     非文本类（image / audio / video）不要求 quote，只校验文件存在 + sha256 未变。
 *
 * 向后兼容：v0.22.0 的 `book:<id>#L<n>` 仍然认，等价于 `asset:book:<id>#L<n>`；
 * 旧清单 `20_state/books.json` 也能读（新写的进 `assets.json`）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'

export const ASSETS_REGISTRY = join('20_state', 'assets.json')
export const LEGACY_BOOKS_REGISTRY = join('20_state', 'books.json')
export const ASSETS_DIRNAME = 'fish-memory-assets'

/** 素材类型：文本类才做原话逐字校验 */
export const ASSET_KINDS = Object.freeze({
  book: 'text',
  doc: 'text',
  transcript: 'text',
  image: 'binary',
  audio: 'binary',
  video: 'binary',
})

export const TEXT_KINDS = new Set(['book', 'doc', 'transcript'])

/** 新的 `asset:<kind>:<id>#L<n>` 与旧的 `book:<id>#L<n>` */
const ASSET_RE = /^asset:([a-z]+):([A-Za-z0-9._-]+)(?:#L(\d+))?$/
const LEGACY_BOOK_RE = /^book:([A-Za-z0-9._-]+)(?:#L(\d+))?$/

export function assetsRoot(dir) {
  const env = process.env.FISH_MEMORY_ASSETS
  if (env && env.trim()) return resolve(env.trim())
  return join(dirname(resolve(dir)), ASSETS_DIRNAME)
}

/** 旧名保留（v0.22.0 的调用点/文档还在用） */
export const booksRoot = assetsRoot

export function loadAssets(dir) {
  const fresh = readJsonSafe(join(dir, ASSETS_REGISTRY), null)
  const legacy = readJsonSafe(join(dir, LEGACY_BOOKS_REGISTRY), null)
  const pick = (raw) => (raw && typeof raw === 'object' && raw.books && typeof raw.books === 'object' ? raw.books : null)
  const books = pick(fresh) || pick(legacy) || {}
  // 旧清单里的书没有 kind 字段：一律当 book
  const normalized = {}
  for (const [id, b] of Object.entries(books)) normalized[id] = { kind: 'book', ...b }
  return { version: 1, books: normalized }
}

export function saveAssets(dir, reg) {
  atomicWriteJson(join(dir, ASSETS_REGISTRY), { version: 1, books: reg.books })
}

/** 旧名保留 */
export const loadBooks = loadAssets
export const saveBooks = saveAssets

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const countLines = (text) => text.split(/\r?\n/).length

const kindDir = (kind) => (ASSET_KINDS[kind] ? kind : 'doc')

/**
 * 登记一个素材：把原文**拷进库外的素材目录**（不拷进记忆库），返回清单项。
 * 同一 sha256 已登记过就复用。
 */
export function addAsset(dir, file, { title, kind = 'doc' } = {}) {
  const src = resolve(file)
  if (!existsSync(src)) throw new Error(`找不到素材文件：${src}`)
  const st = statSync(src)
  if (!st.isFile()) throw new Error(`不是一个文件：${src}`)

  const sha = sha256File(src)
  const reg = loadAssets(dir)
  const dup = Object.values(reg.books).find((b) => b.sha256 === sha)
  if (dup) return { entry: dup, reused: true }

  const k = kindDir(kind)
  const name = String(title || basename(src).replace(/\.[^.]+$/, '')).trim()
  // id 必须是 ASCII（要写进 source 引用，解析正则是 [A-Za-z0-9._-]+）；中文书名放 title
  const id = `asset-${sha.slice(0, 10)}`
  const ext = extname(src) || (TEXT_KINDS.has(k) ? '.txt' : '')

  const root = assetsRoot(dir)
  const dirOut = join(root, k)
  mkdirSync(dirOut, { recursive: true })
  const rel = `${k}/${id}${ext}`
  const dest = join(dirOut, `${id}${ext}`)
  if (!existsSync(dest)) copyFileSync(src, dest)

  const entry = {
    id,
    kind: k,
    title: name,
    rel, // 相对路径：不写绝对路径（分享/备份时不带用户名）
    bytes: st.size,
    sha256: sha,
    lines: TEXT_KINDS.has(k) ? countLines(readFileSync(src, 'utf8')) : null,
    added_at: new Date().toISOString(),
  }
  reg.books[id] = entry
  saveAssets(dir, reg)
  return { entry, reused: false }
}

/** 旧名保留 */
export const addBook = (dir, file, opts = {}) => addAsset(dir, file, { ...opts, kind: 'book' })

/** 解析 `asset:<kind>:<id>#L<n>` 或旧的 `book:<id>#L<n>` */
export function parseAssetSource(sid) {
  const s = String(sid || '')
  const m = ASSET_RE.exec(s)
  if (m) return { kind: m[1], id: m[2], line: m[3] ? Number(m[3]) : null }
  const b = LEGACY_BOOK_RE.exec(s)
  if (b) return { kind: 'book', id: b[1], line: b[2] ? Number(b[2]) : null }
  return null
}

/** 旧名保留 */
export const parseBookSource = (sid) => {
  const r = parseAssetSource(sid)
  return r && r.kind === 'book' ? { id: r.id, line: r.line } : null
}

export function assetPath(dir, entry) {
  if (!entry?.rel) return null
  const p = join(assetsRoot(dir), entry.rel)
  return isAbsolute(p) ? p : resolve(p)
}

/** 旧名保留 */
export const bookPath = assetPath

/** 校验素材还在不在、还是不是当初那个 */
export function verifyAsset(dir, entry) {
  if (!entry) return { ok: false, reason: '清单里没有这个素材' }
  const p = assetPath(dir, entry)
  if (!p || !existsSync(p)) return { ok: false, reason: `素材文件不在了：${entry.rel}（素材根：${assetsRoot(dir)}）` }
  const sha = sha256File(p)
  if (sha !== entry.sha256) return { ok: false, reason: '素材的 sha256 变了（换过文件？）' }
  return { ok: true, at: p }
}

export const verifyBook = verifyAsset

/**
 * 让一个素材"退役"（v0.24.0）：不删清单、不删文件、不动任何点。
 *
 * 为什么需要：书会改版、文档会出新稿。现在 sha256 一变只会报"文件变了"，
 * 但"我知道它变了，我选择用新版"这件事没有地方表达。退役标记就是那个表达——
 * 引用仍可核对，`audit` 不再把它算成"素材丢了"。
 */
export function retireAsset(dir, id, { reason = null, now = new Date() } = {}) {
  const reg = loadAssets(dir)
  const entry = reg.books[id]
  if (!entry) return { ok: false, reason: `清单里没有这个素材：${id}` }
  entry.retired_at = now.toISOString()
  entry.retired_reason = reason ? String(reason) : null
  reg.books[id] = entry
  saveAssets(dir, reg)
  return { ok: true, entry }
}

/** 撤销退役（换回来时用） */
export function unretireAsset(dir, id) {
  const reg = loadAssets(dir)
  const entry = reg.books[id]
  if (!entry) return { ok: false, reason: `清单里没有这个素材：${id}` }
  delete entry.retired_at
  delete entry.retired_reason
  reg.books[id] = entry
  saveAssets(dir, reg)
  return { ok: true, entry }
}

export const isRetired = (entry) => Boolean(entry?.retired_at)

/**
 * 在素材里找一段原话（逐字）。给了行号就只在那一行附近找（±window）。
 * 非文本类（图/音视频）没有可比对的文本：返回 `{found:true, binary:true}`，
 * 因为它们的"真实性"由 sha256 保证，不由原话保证。
 */
export function findQuoteInAsset(dir, entry, quote, { line = null, window = 20 } = {}) {
  if (entry && !TEXT_KINDS.has(entry.kind || 'book')) return { found: true, binary: true }
  const p = assetPath(dir, entry)
  if (!p || !existsSync(p)) return { found: false, reason: '素材文件不在了' }
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
  return { found: false, reason: '素材里找不到这句原话' }
}

export const findQuoteInBook = (dir, entry, quote, opts) => findQuoteInAsset(dir, entry, quote, opts)

/** 给人看的清单（`memory asset list`） */
export function listAssets(dir) {
  const reg = loadAssets(dir)
  return Object.values(reg.books).map((b) => ({ ...b, present: verifyAsset(dir, b).ok, retired: isRetired(b) }))
}

export const listBooks = listAssets
