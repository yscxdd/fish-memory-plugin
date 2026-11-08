// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 解包/恢复时的文件名安全校验（S1/S2，评审 v0.80.1）。
 *
 * 为什么单独一个文件：**同一个校验要出现在三条路径上**——
 *   · `restore.js`（.fmb 备份）
 *   · `pack.js`  （迁移包 MANIFEST.json）
 *   · `memory.mjs`（`checkChainOf` 解 tar）
 * 三处各写一遍，就会有一处漏（这一轮评审正是这么发现的）。
 *
 * 规则三条，缺一不可：
 *   ① 不许绝对路径（`/etc/passwd`、`C:\x`、`\\server\share`）
 *   ② 不许出现 `..` 这一段（zip-slip / tar-slip）
 *   ③ 不许是空串或只有空白
 */
export function safeRelPath(name) {
  const s = String(name ?? '')
  if (!s.trim()) return false
  if (s.startsWith('/') || s.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(s)) return false
  if (s.split(/[\\/]/).includes('..')) return false
  return true
}

/** 校验不过就抛（调用方不需要自己拼错误文案） */
export function assertSafeRelPath(name, where = '文件') {
  if (!safeRelPath(name)) throw new Error(`${where}名不安全，拒绝解包：${JSON.stringify(String(name ?? ''))}`)
}
