// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 跨进程同时写档案（审计 AUDIT-2026-11-08-v077.md §3，P1）。
 *
 * 复现脚本就是下面这条：4 个进程，各写 60 条，同一天文件。
 *
 * v0.77 之前的两个 bug（都是实测出来的）：
 *   ① **链断**：两个进程同时读到空的链尾 → 都算出 `prev: genesis` → 两条并列链头。
 *   ② **丢消息**（这条是写测试时才发现，比链断更糟）：
 *      `20_state/cursors.json` 是所有会话共用的一个可变文件，每个进程带着自己那份旧表
 *      去整表覆盖 → 跨进程丢更新；`_append` 里的 `rec.seq <= cursor` 于是把消息拒了。
 *      实测 4×60 只剩 238 行，`s-c` 的游标整条消失。
 *
 * v0.78.0 的修法：
 *   · 按**天文件**的跨进程锁（`<file>.lock`），锁内重读链头；
 *   · 游标改成**一个会话一个文件**（`20_state/cursors/<session>.json`），谁写自己的；
 *   · 锁与追加都带重试（Windows 上 EPERM/EBUSY 是"等一会儿"，不是"失败"）。
 *
 * 这个测试跑真进程——因为 bug 就在**进程之间**。它会慢（4×60 条 ≈ 几秒），值得。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkArchive } from '../lib/integrity.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function freshLib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-race-'))
  for (const d of ['10_archive/messages', '20_state', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

/** 起 n 个进程，各写 count 条，返回每个进程成功写入的条数 */
async function concurrentWrite(dir, tags, count) {
  const writer = join(dir, `.writer-${process.pid}.mjs`)
  writeFileSync(
    writer,
    [
      `import { ArchiveWriter } from ${JSON.stringify(pathToFileURL(join(ROOT, 'lib/archive.js')).href)}`,
      'const [dir, tag, n] = process.argv.slice(2)',
      'const a = new ArchiveWriter(dir)',
      'for (let i = 1; i <= Number(n); i++) {',
      "  const m = { id: `msg-${tag}-${i}-${tag}zz`, role: 'user', content: [{ type: 'text', text: `${tag}#${i}` }], source: { kind: 'user' } }",
      "  a.handle(`s-${tag}`, { type: 'user/message', seq: i, time: Date.parse('2026-11-08T10:00:00Z') + i, surfaceOp: 'append', data: m })",
      '}',
      'await a.queue',
      'await a.idle()',
      'console.log(JSON.stringify({ tag, writes: a.writes }))',
    ].join('\n'),
    'utf8',
  )
  const outs = await Promise.all(
    tags.map(
      (tag) =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [writer, dir, tag, String(count)], { stdio: ['ignore', 'pipe', 'ignore'] })
          let buf = ''
          p.stdout.on('data', (d) => (buf += String(d)))
          p.on('exit', () => resolve(buf.trim()))
        }),
    ),
  )
  unlinkSync(writer)
  return outs.map((o) => {
    try {
      return JSON.parse(o).writes
    } catch {
      return 0
    }
  })
}

const countLines = (dir) => {
  const msgDir = join(dir, '10_archive/messages')
  let n = 0
  for (const f of readdirSync(msgDir)) {
    if (!f.endsWith('.jsonl')) continue
    n += readFileSync(join(msgDir, f), 'utf8').split('\n').filter(Boolean).length
  }
  return n
}

test('4 进程 × 40 条：链是连的（这条对应审计 P1-3 的"prev 对不上"）', async () => {
  const dir = freshLib()
  const tags = ['a', 'b', 'c', 'd']
  const writes = await concurrentWrite(dir, tags, 40)

  const chk = checkArchive(dir, { persist: false })
  assert.equal(chk.ok, true, `链断了：${JSON.stringify(chk.broken)}`)
  assert.equal((chk.broken || []).length, 0)
  assert.equal(countLines(dir), 160, `4×40 应该 160 行，实际 ${countLines(dir)}（每进程写入：${writes.join(',')}）`)
})

test('4 进程 × 40 条：一条消息都不许丢（这条比链断更严重）', async () => {
  const dir = freshLib()
  const tags = ['a', 'b', 'c', 'd']
  const writes = await concurrentWrite(dir, tags, 40)
  for (let i = 0; i < tags.length; i++) {
    assert.equal(writes[i], 40, `进程 ${tags[i]} 只写进 ${writes[i]} 条——丢消息了`)
  }
})

test('游标按会话分文件（不再整表覆盖 cursors.json）', async () => {
  const dir = freshLib()
  await concurrentWrite(dir, ['a', 'b'], 5)
  const files = readdirSync(join(dir, '20_state/cursors')).sort()
  assert.deepEqual(files, ['s-a.json', 's-b.json'], `应该一个会话一个文件，实际：${files.join(',')}`)
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, '20_state/cursors', f), 'utf8'))
    assert.equal(raw.seq, 5, `${f} 的游标应该是 5，实际 ${raw.seq}`)
  }
})

test('锁用完会删掉（不留 .lock 残骸）', async () => {
  const dir = freshLib()
  await concurrentWrite(dir, ['a', 'b'], 5)
  const leftovers = readdirSync(join(dir, '10_archive/messages')).filter((f) => f.endsWith('.lock'))
  assert.deepEqual(leftovers, [], `不该留锁文件：${leftovers.join(',')}`)
})
