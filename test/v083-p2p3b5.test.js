// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * P2 / P3 / B5 的落实测试（v0.83.0）。
 *
 *   P2 全局锁释放从"删除"改成"改名"（本机 unlink 240ms/次，flush 每轮都拿锁）；
 *   P3 游标读内存优先（每条消息少一次同步 readFileSync），跨进程仍与盘取 max；
 *   B5 摘录偏移量（indexOf 与切片必须用同一份字符串）。
 *
 * B10（情绪极性）**没修**：实测把 naive 的"逐词否定"接上去，金标从 83.9% 掉到 80.6%、
 * MAE 0.361 → 0.400。数据在 `docs/UNFIXED-2026-11-09.md` 里——我不拿"修了一个例子"
 * 换"整体退步"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter } from '../lib/archive.js'
import { withLock } from '../lib/lock.js'
import { searchPoints } from '../lib/recall.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-v83-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n', 'utf8')
  return dir
}

// ── P2：全局锁 ──────────────────────────────────────────────
test('P2：全局锁里写的是 pid|启动时间', () => {
  const dir = lib()
  let content = ''
  withLock(dir, () => {
    content = readFileSync(join(dir, '20_state/.lock'), 'utf8')
  })
  assert.match(content, /^\d+\|\d+$/, `锁内容应该是 pid|start，实际 "${content}"`)
})

test('P2：释放是改名进 lock-trash，不是每次删文件', () => {
  const dir = lib()
  withLock(dir, () => {})
  const trash = join(dir, '20_state/lock-trash')
  assert.ok(existsSync(trash), '应该有 lock-trash 目录')
  assert.ok(readdirSync(trash).length >= 1, '释放后应该在 trash 里留一份')
  assert.ok(!existsSync(join(dir, '20_state/.lock')), '原锁文件要被挪走')
})

test('P2：拿不到锁时仍然按超时抛错（行为没变）', () => {
  const dir = lib()
  mkdirSync(join(dir, '20_state'), { recursive: true })
  // 伪造一把"活着"的锁：pid 是本进程、启动时间也是本进程的
  const start = Math.round(Date.now() - process.uptime() * 1000)
  writeFileSync(join(dir, '20_state/.lock'), `${process.pid}|${start}`, 'utf8')
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 120 }), /写锁超时/)
})

// ── P3：游标内存优先 ────────────────────────────────────────
test('P3：游标在内存里就能拿到（盘上文件被删也不影响）', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  for (let i = 1; i <= 3; i++) {
    await w.handle('s1', {
      type: 'user/message',
      seq: i,
      time: Date.parse('2026-11-08T10:00:00Z') + i,
      surfaceOp: 'append',
      data: { id: `m-${i}`, role: 'user', content: [{ type: 'text', text: `第 ${i} 条` }], source: { kind: 'user' } },
    })
  }
  await w.queue
  await w.idle()
  assert.equal(w.cursorOf('s1'), 3)

  // 把盘上的游标删掉：内存里还有，就不该退回到 -1
  const p = join(dir, '20_state/cursors/s1.json')
  if (existsSync(p)) unlinkSync(p)
  assert.equal(w.cursorOf('s1'), 3, '内存优先：盘上没了也不该忘')
})

// ── B5：摘录偏移量 ─────────────────────────────────────────
test('B5：标题里有换行时，摘录仍然包含关键词', () => {
  const dir = lib()
  writeFileSync(
    join(dir, '30_points/M-2026-11-01-001.md'),
    [
      '---', 'id: M-2026-11-01-001', 'title: 第一行', 'date: 2026-11-01', 'type: event', 'cluster: 日常',
      'salience: 3', 'origin: told', 'status: active', 'source: ["msg-1-a"]', 'links: []',
      '---', '', '<!-- SUM -->', '第二行 关键词在这里 后面还有一段很长的内容用来把命中位置推后'.repeat(2), '<!-- /SUM -->',
    ].join('\n'),
    'utf8',
  )
  const hits = searchPoints(dir, '关键词在这里')
  assert.equal(hits.length, 1)
  assert.match(hits[0].excerpt, /关键词在这里/, `摘录里应该看得到关键词，实际：${hits[0].excerpt}`)
})
