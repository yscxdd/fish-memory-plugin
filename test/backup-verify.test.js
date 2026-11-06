// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * B4 · 三处校验（v0.67.2）。
 *
 * 起因：WordBuddy 发现"备份没验过 = 没备份"。三处校验缺一处就等于没有：
 *   ① 导出后（本地）—— 能解开、能 untar、链是连的
 *   ② 上传后（远端）—— **sha256 与本地记录一致**（网盘的失败是静默的：传一半、改名、体积 0）
 *   ③ 每月一次 —— 最近一份是否 <48h、头部是否还读得出来
 *
 * 这些测试全部用**外部命令的退出码**断言——因为"假绿"最容易发生在
 * "函数返回了，但 CLI 说错了话"（F1 就是这么来的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ArchiveWriter } from '../lib/archive.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (args, env = {}) =>
  spawnSync(process.execPath, ['scripts/memory.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 })

async function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-b4-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# 她是谁\n', 'utf8')
  const w = new ArchiveWriter(dir)
  const msg = (seq, role, text) => {
    const m = { id: `msg-${seq}-abcdef`, role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } }
    return { type: role === 'user' ? 'user/message' : 'assistant/message', seq, time: Date.parse('2026-11-06T10:00:00.000Z') + seq * 1000, surfaceOp: 'append', data: role === 'user' ? m : { message: m } }
  }
  await w.handle('s1', msg(1, 'user', '今天下雨'))
  await w.handle('s1', msg(2, 'assistant', '嗯，带伞'))
  await w.idle()
  return dir
}

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

test('① 本地：导出后 verify 通过（链真的验过）', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-b4o-')), 'fish-memory-20261106.fmb')
  assert.equal(run(['backup', 'export', '--dir', dir, '--out', out]).status, 0)
  const r = run(['backup', 'verify', out])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /链完整（已验）/)
})

test('② 远端：--expect-sha256 对得上 → 0', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-b4o-')), 'fish-memory-20261106.fmb')
  run(['backup', 'export', '--dir', dir, '--out', out])
  const r = run(['backup', 'verify', out, '--expect-sha256', sha(out)])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /sha256 与本地记录一致/)
})

test('② 远端：--expect-sha256 对不上 → 非 0，并说清是哪边不对', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-b4o-')), 'fish-memory-20261106.fmb')
  run(['backup', 'export', '--dir', dir, '--out', out])
  const r = run(['backup', 'verify', out, '--expect-sha256', '0'.repeat(64)])
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /不一致/)
})

test('② 远端：文件被截断 → 先被 gzip/sha 挡住，不会走到"一致"', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-b4o-')), 'x.fmb')
  run(['backup', 'export', '--dir', dir, '--out', out])
  const buf = readFileSync(out)
  writeFileSync(out, buf.subarray(0, Math.floor(buf.length / 2)))
  const r = run(['backup', 'verify', out])
  assert.notEqual(r.status, 0)
})

test('③ list --check：今天的包 → 0', async () => {
  const dir = await lib()
  const box = mkdtempSync(join(tmpdir(), 'fishmem-b4l-'))
  const today = new Date()
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  run(['backup', 'export', '--dir', dir, '--out', join(box, `fish-memory-${stamp}.fmb`)])
  const r = run(['backup', 'list', '--dir', box, '--check'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /✓ 最新一份/)
})

test('③ list --check：最新一份是三个月前 → 非 0（超过 48h）', async () => {
  const box = mkdtempSync(join(tmpdir(), 'fishmem-b4l-'))
  writeFileSync(join(box, 'fish-memory-20200101.fmb'), 'x')
  const r = run(['backup', 'list', '--dir', box, '--check'])
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /超过 48h|读不出来/)
})

test('③ list --check：文件头部坏掉 → 非 0', async () => {
  const box = mkdtempSync(join(tmpdir(), 'fishmem-b4l-'))
  const today = new Date()
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  writeFileSync(join(box, `fish-memory-${stamp}.fmb`), '不是备份包')
  const r = run(['backup', 'list', '--dir', box, '--check'])
  assert.notEqual(r.status, 0)
})
