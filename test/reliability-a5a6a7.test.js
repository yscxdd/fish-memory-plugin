// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 数据可靠性 A5 / A6 / A7（v0.72.0）。
 *
 * 这三条的共同点：**平时看不出来，出事那天才知道**。
 *   A5 墓碑账本两套写法（refute 读全文重写 vs erase 追加）→ 并发丢一条
 *   A6 原子写没有 fsync → 断电后"文件在、长度 0"
 *   A7 锁 3s 超时 / 30s 判残留 → 长操作被抢锁，两边同时写
 *
 * 能测的部分尽量真测（真并发、真锁、真写），不能测的部分测"结构上做对了"
 * （比如 fsync 是否调用——这个没法用掉电验证）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { refutePoint } from '../lib/refute.js'
import { LOCK_STALE_MS, LOCK_WAIT_MS, withLock } from '../lib/lock.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-rel-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const mkPoint = (dir, id, title = 't') =>
  writeFileSync(
    join(dir, '30_points', `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\ndate: 2026-11-06\ntype: event\ncluster: c\nsalience: 3\norigin: told\nstatus: active\nsource: ["msg-1-abcdef"]\nlinks: []\n---\n\n<!-- SUM -->\n${title}\n<!-- /SUM -->\n`,
    'utf8',
  )

// ── A5 ─────────────────────────────────────────────────────────
test('A5：墓碑账本是只追加——别处先写的那行不会被 refute 覆盖掉', () => {
  const dir = lib()
  mkPoint(dir, 'M-2026-11-06-001')
  const log = join(dir, '50_log/erasure.log')
  // 模拟 erase 刚追加的一行（另一个写入方）
  appendFileSync(log, `${JSON.stringify({ at: '2026-11-07T00:00:00.000Z', action: 'erase', id: 'M-2026-01-01-001' })}\n`, 'utf8')

  refutePoint(dir, 'M-2026-11-06-001', { reason: '他其实怕一个人', now: new Date('2026-11-07T10:00:00Z') })

  const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2, '两行都要在（读-改-写会丢掉前一行）')
  assert.equal(rows[0].action, 'erase')
  assert.equal(rows[1].action, 'refute')
})

test('A5：连续 refute 两次 → 账本两行，文件是增长的（不是整体重写）', () => {
  const dir = lib()
  mkPoint(dir, 'M-2026-11-06-001')
  mkPoint(dir, 'M-2026-11-06-002')
  refutePoint(dir, 'M-2026-11-06-001', { reason: 'a' })
  const size1 = statSync(join(dir, '50_log/erasure.log')).size
  refutePoint(dir, 'M-2026-11-06-002', { reason: 'b' })
  const size2 = statSync(join(dir, '50_log/erasure.log')).size
  assert.ok(size2 > size1, '追加会让文件变大')
  assert.equal(readFileSync(join(dir, '50_log/erasure.log'), 'utf8').trim().split('\n').length, 2)
})

// ── A6 ─────────────────────────────────────────────────────────
test('A6：原子写仍然"要么旧要么新"（不留半个文件、不留 tmp）', async () => {
  const { atomicWriteText } = await import('../lib/util.js')
  const dir = lib()
  const f = join(dir, '20_state/x.json')
  atomicWriteText(f, '{"a":1}')
  atomicWriteText(f, '{"a":2}')
  assert.equal(readFileSync(f, 'utf8'), '{"a":2}')
  // 不留 tmp 残骸
  const leftovers = readdirSync(join(dir, '20_state')).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '不该留 tmp 文件')
})

test('A6：原子写调用了 fsync（源码层断言，掉电没法在这里模拟）', () => {
  const src = readFileSync(new URL('../lib/util.js', import.meta.url), 'utf8')
  assert.match(src, /fsyncSync/, '原子写必须 fsync，否则断电会出现"文件在、长度 0"')
})

test('A6：档案追加会周期性 fsync（每 20 条）', () => {
  const src = readFileSync(new URL('../lib/archive.js', import.meta.url), 'utf8')
  assert.match(src, /fsyncSync/, '档案追加要周期性落盘')
  assert.match(src, /_appendedSinceSync/, '要有计数器，不能每条都 fsync（那样太慢）')
})

// ── A7 ─────────────────────────────────────────────────────────
test('A7：默认等 10s、残留判 5 分钟（不是 3s / 30s）', () => {
  assert.equal(LOCK_WAIT_MS, 10_000)
  assert.equal(LOCK_STALE_MS, 5 * 60_000)
})

test('A7：锁的主人还活着 → mtime 再旧也不许抢（这才是长操作被抢的根因）', () => {
  const dir = lib()
  const lockFile = join(dir, '20_state/.lock')
  // 写一个"活着的 pid"（就是本进程），并把 mtime 改到 40 秒前——
  // 旧逻辑（只看 30s 年龄）会判残留直接抢走，于是两个进程同时写。
  writeFileSync(lockFile, `${process.pid} ${Date.now()}`, 'utf8')
  const old = new Date(Date.now() - 40_000)
  utimesSync(lockFile, old, old)

  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 150, staleMs: LOCK_STALE_MS }), /写锁超时/)
})

test('A7：锁的主人已经死了 → 即使 mtime 很新也能抢（别让崩溃变成永久锁）', () => {
  const dir = lib()
  const lockFile = join(dir, '20_state/.lock')
  // 一个几乎不可能存活的 pid
  writeFileSync(lockFile, '999999 1', 'utf8')
  const r = withLock(dir, () => 'got', { timeoutMs: 500, staleMs: 0 })
  assert.equal(r, 'got')
})

test('A7：锁超时留一行 50_log/lock.log（失败不能只活在调用方的 catch 里）', () => {
  const dir = lib()
  const lockFile = join(dir, '20_state/.lock')
  writeFileSync(lockFile, `${process.pid} ${Date.now()}`, 'utf8')
  // 新鲜的锁 → 抢不到 → 超时
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 120, staleMs: 60_000 }), /写锁超时/)
  const log = readFileSync(join(dir, '50_log/lock.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log.length, 1)
  assert.equal(log[0].event, 'timeout')
})

test('A7：残留锁（超过 5 分钟）仍然可抢——别把死锁变成永久锁', () => {
  const dir = lib()
  const lockFile = join(dir, '20_state/.lock')
  writeFileSync(lockFile, '999999 0', 'utf8')
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000)
  utimesSync(lockFile, old, old)
  const r = withLock(dir, () => 'got', { timeoutMs: 500 })
  assert.equal(r, 'got')
  assert.equal(existsSync(lockFile), false, '用完要释放')
})
