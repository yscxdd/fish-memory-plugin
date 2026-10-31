// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * books.js — v0.22.0 的旧入口，v0.23.0 起**只是 assets.js 的别名**。
 *
 * 为什么留着：旧测试、旧脚本、旧文档里还在 import `../lib/books.js`；
 * 删掉它们会制造一堆无意义的改动。新代码请直接用 `lib/assets.js`。
 */

import { parseAssetSource } from './assets.js'

export {
  ASSETS_REGISTRY as BOOKS_REGISTRY,
  ASSETS_DIRNAME as BOOKS_DIRNAME,
  addAsset as addBook,
  assetPath as bookPath,
  assetsRoot as booksRoot,
  findQuoteInAsset as findQuoteInBook,
  loadAssets as loadBooks,
  listAssets as listBooks,
  saveAssets as saveBooks,
  verifyAsset as verifyBook,
} from './assets.js'

/** 兼容旧调用：只认 book，返回 `{ id, line }` */
export function parseBookSource(sid) {
  const r = parseAssetSource(sid)
  return r && r.kind === 'book' ? { id: r.id, line: r.line } : null
}
