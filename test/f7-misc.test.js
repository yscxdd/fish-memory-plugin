// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * F7 小项（审计 v0791）。
 *
 * 两条都属于"看起来在工作、其实没有"的那种：
 *
 *   ① `rotateLog` 里 `if (i + 1 > keep)` 在 `i ∈ [1, keep-1]` 下**恒为假**——
 *      于是 `.log.<keep>` 永远不删。"轮转"其实没有上限。
 *   ② 锁内容只写 pid。持锁进程死后 pid 被复用 → 判活为真 → 一直在等一个不存在的进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rotateLog } from '../lib/util.js'
import { withDayLock } from '../lib/archive.js'

// ── rotateLog 的上限 ───────────────────────────────────────────
test('F7：轮转真的保留 keep 份，多出来的一定删掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-rot-'))
  const file = join(dir, 'a.log')
  for (const n of ['', '.1', '.2', '.3', '.4']) writeFileSync(`${file}${n}`, 'x'.repeat(2000), 'utf8')

  assert.equal(rotateLog(file, { maxBytes: 1000, keep: 2 }), true)
  const left = readdirSync(dir).sort()
  assert.deepEqual(left, ['a.log.1', 'a.log.2'], `只该留 .1 .2，实际：${left.join(',')}`)
})

test('F7：没到上限不动文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-rot2-'))
  const file = join(dir, 'a.log')
  writeFileSync(file, 'x'.repeat(10), 'utf8')
  assert.equal(rotateLog(file, { maxBytes: 1000, keep: 2 }), false)
  assert.deepEqual(readdirSync(dir), ['a.log'])
})

// ── 锁里的 pid + 启动时间 ──────────────────────────────────────
test('F7：锁文件里写的是 pid|启动时间（不是裸 pid）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-lock-'))
  const msgs = join(dir, '10_archive/messages')
  mkdirSync(msgs, { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })

  // 在锁内读一下锁文件内容（此时我们还持着它）
  let content = ''
  withDayLock(dir, join(msgs, '2026-11-08.jsonl'), () => {
    content = readFileSync(join(msgs, '2026-11-08.jsonl.lock'), 'utf8')
  })
  assert.match(content, /^\d+\|\d+$/, `锁内容应该是 pid|start，实际 "${content}"`)
})

test('F7：被复用的 pid 不会被当成"还活着"（锁会被接管）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-lock2-'))
  const msgs = join(dir, '10_archive/messages')
  mkdirSync(msgs, { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  const file = join(msgs, '2026-11-08.jsonl')
  writeFileSync(file, '', 'utf8')

  // 伪造一把"pid 是本进程、但启动时间差了十万八千里"的锁 —— 模拟 pid 复用
  const fakeStart = Math.round(Date.now() - process.uptime() * 1000) - 600_000
  writeFileSync(`${file}.lock`, `${process.pid}|${fakeStart}`, 'utf8')

  const t0 = Date.now()
  let ran = false
  withDayLock(dir, file, () => {
    ran = true
  }, { waitMs: 400 })
  assert.equal(ran, true, '应该接管这把"主人已经不在"的锁')
  assert.ok(Date.now() - t0 < 2000, `接管应该很快，实际 ${Date.now() - t0}ms`)
  assert.ok(!existsSync(`${file}.lock`), '用完要放掉')
})
