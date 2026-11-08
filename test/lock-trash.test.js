// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * N4（审计 v079，P3）：锁残骸目录不能无限堆积。
 *
 * 背景：v0.79 把锁释放从"删除"改成"改名挪进 20_state/lock-trash/"
 * （这台机器 unlink 240ms/次，rename 1.7ms）。但**谁来清**这件事当时只做了一半：
 *
 *   · 注释写着"下次启动/退出时清"，`sweepLocks()` 却只在 `memory rechain` 里被调用；
 *   · 宿主的 ArchiveWriter 一活一整天，构造时就清一次，之后再也清不到。
 *
 * 后果：一天 500 条消息 = 500 个文件，堆到手动跑 rechain 为止。
 * 不丢数据、不拖热路径，但**注释说了假话**——那比没有注释更糟（下一个人会信它）。
 *
 * 修法（两件，缺一不可）：
 *   ① 目标文件名**固定**（`<锁名>.<pid>`，不带时间戳）：每次释放都是"替换"，
 *      同一天同一个进程永远只有 1 个文件 → **不随消息条数增长**；
 *   ② `ArchiveWriter` 构造时清一次旧进程留下的残骸，单次上限 5000（清理工具不许变成新卡点）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter, sweepLocks } from '../lib/archive.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-n4-'))
  for (const d of ['10_archive/messages', '20_state', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const ev = (seq) => ({
  type: 'user/message',
  seq,
  time: Date.parse('2026-11-08T10:00:00Z') + seq * 1000,
  surfaceOp: 'append',
  data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text: `第 ${seq} 条` }], source: { kind: 'user' } },
})

test('N4：连写 20 条，lock-trash 里只有 1 个文件（不随条数增长）', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  for (let i = 1; i <= 20; i++) w.handle('s1', ev(i))
  await w.queue
  await w.idle()

  const trash = readdirSync(join(dir, '20_state/lock-trash'))
  assert.equal(trash.length, 1, `应该只有 1 个残骸，实际 ${trash.length} 个：${trash.slice(0, 5).join(',')}`)
})

test('N4：新进程（新 writer）会把上一个进程留下的残骸清掉', async () => {
  const dir = lib()
  const trash = join(dir, '20_state/lock-trash')
  mkdirSync(trash, { recursive: true })
  // 假装上个进程留了三个
  for (const n of ['死进程A', '死进程B', '死进程C']) writeFileSync(join(trash, `2026-11-08.jsonl.lock.${n}`), '1', 'utf8')
  assert.equal(readdirSync(trash).length, 3)

  // 新库标记：这里要绕过"本进程已清过"的缓存，所以换一个全新的库路径
  const dir2 = lib()
  const trash2 = join(dir2, '20_state/lock-trash')
  mkdirSync(trash2, { recursive: true })
  for (const n of ['a', 'b', 'c']) writeFileSync(join(trash2, `x.lock.${n}`), '1', 'utf8')
  new ArchiveWriter(dir2)
  assert.equal(readdirSync(trash2).length, 0, '构造 writer 就该把旧残骸清干净')
})

test('N4：sweepLocks 有单次上限（清几万个不该变成一次几分钟的卡顿）', () => {
  const dir = lib()
  const trash = join(dir, '20_state/lock-trash')
  mkdirSync(trash, { recursive: true })
  for (let i = 0; i < 30; i++) writeFileSync(join(trash, `lock-${i}`), '1', 'utf8')

  const n = sweepLocks(dir, { max: 10 })
  assert.equal(n, 10, '单次只清 max 个')
  assert.equal(readdirSync(trash).length, 20, '剩下的下次继续')
})
