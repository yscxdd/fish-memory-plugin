// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * P4 / B6 / 次要项（评审 v0.80.1 收尾，v0.84.0）。
 *
 * 这轮修的都是"不显眼但会咬人"的：
 *   · P4 一轮里 loadEmotion / loadPresence 各读两遍（同一份文件，纯白付的 I/O）；
 *   · B6 `_sessions` 每个会话一份完整工作记忆，永不淘汰（常驻进程缓慢上涨）；
 *   · 次要项：searchPoints 传 number、HTTP 侧 q 无上限、zip 条目数回绕、pack 临时目录残留。
 *
 * 注意 B6 的两个用例都用 `ensureSession`：`session(id)` 在盘上没有时**只返回 null、不落缓存**，
 * 拿它填缓存是填不进去的（第一版就是这么写的，测试假绿）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../lib/store.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-v84-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n', 'utf8')
  return dir
}

// ── P4：一轮只读一次 ─────────────────────────────────────────
test('P4：注入回调里 emotion/presence 各有一个"本轮缓存"的 getter', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /const emotionNow = \(\) =>/, '应该有 emotionNow 缓存 getter')
  assert.match(src, /const presenceNow = \(\) =>/, '应该有 presenceNow 缓存 getter')

  const at = src.indexOf('const t0 = Date.now()')
  const body = src.slice(at, at + 60000)
  assert.ok(!/stressFromEmotion\(loadEmotion\(dir\)\)/.test(body), '压力判定还在直接读盘')
  assert.ok(!/returnLine\(\{ state: loadPresence\(dir\)/.test(body), 'returnLine 还在直接读盘')
  assert.ok(!/emotionLine\(loadEmotion\(dir\)/.test(body), '情绪行还在直接读盘')
})

// ── B6：会话缓存有上限，且是 LRU ─────────────────────────────
test('B6：开 100 个会话，_sessions 不超过 64 份', () => {
  const dir = lib()
  const store = new MemoryStore(dir)
  for (let i = 0; i < 100; i++) store.ensureSession(`s-${i}`)
  assert.ok(store._sessions.size > 0, '前提：ensureSession 真的会落缓存')
  assert.ok(store._sessions.size <= 64, `应该有上限 64，实际 ${store._sessions.size}`)
})

test('B6：刚用过的会话不会被淘汰（是 LRU 不是 FIFO）', () => {
  const dir = lib()
  const store = new MemoryStore(dir)
  for (let i = 0; i < 64; i++) store.ensureSession(`s-${i}`)
  // 摸一下最老的 s-0：应该被挪到队尾
  store.session('s-0')
  // 再塞两个：该被挤掉的是 s-1，不是刚摸过的 s-0
  store.ensureSession('s-64')
  store.ensureSession('s-65')
  assert.ok(store._sessions.has('s-0'), '刚用过的 s-0 不该被淘汰')
  assert.ok(!store._sessions.has('s-1'), '真正的老家伙 s-1 才该被挤掉')
})

// ── 次要项 ──────────────────────────────────────────────────
test('次要项：searchPoints 传的是 { limit } 而不是数字', () => {
  const src = readFileSync(new URL('../scripts/mcp.mjs', import.meta.url), 'utf8')
  assert.ok(!/searchPoints\(dir, q, limit\)/.test(src), '第三个参数必须是 { limit }')
  assert.match(src, /searchPoints\(dir, q, \{ limit \}\)/)
})

test('次要项：HTTP 侧的 q 有 2000 字上限（和 MCP 同一口径）', () => {
  const src = readFileSync(new URL('../lib/serveapi.js', import.meta.url), 'utf8')
  assert.match(src, /String\(get\('q'\) \|\| ''\)\.slice\(0, 2000\)/)
})

test('次要项：zip 条目数超过 65535 直接拒绝（不产出坏包）', async () => {
  const { writeZip } = await import('../lib/zip.js')
  const dir = lib()
  const files = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))
  assert.throws(() => writeZip(files, join(dir, 'big.zip')), /条目数超过上限/)
  assert.equal(readdirSync(dir).filter((f) => f === 'big.zip').length, 0, '不许留下半个包')
})

test('次要项：pack 遇到自己上一轮留下的临时目录会清掉重来', () => {
  const src = readFileSync(new URL('../lib/pack.js', import.meta.url), 'utf8')
  assert.match(src, /rmSync\(tmp, \{ recursive: true, force: true \}\)/, '应该清掉残留 tmp')
})

test('次要项：scope.js 的群角色不再是恒同分支的哑三元', () => {
  const src = readFileSync(new URL('../lib/scope.js', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.ok(!code.includes("? 'member' : 'member'"), '恒同分支的三元应该已经去掉')
  assert.match(code, /role: 'member'/, '群里一律 member（写入只进 pending）')
})
