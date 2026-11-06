// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 单文件备份包（v0.67.0，B1/B2/B3）。
 *
 * 三条硬要求，少一条这份备份就是假的：
 *   ① **一个文件**（同步盘只该看见"一个写完的文件"——目录会边写边传、还会产生冲突副本）
 *   ② **可加密**（里面有 soul / relation / 逐字对话，进第三方网盘不能裸奔）
 *   ③ **可恢复且验链**（哈希对得上 ≠ 链是连的；恢复是破坏性操作，宁可不干）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter } from '../lib/archive.js'
import { collectFiles, exportFmb, pruneFmb, readFmb, readFmbHeader, verifyFmb } from '../lib/fmb.js'
import { restoreFmb } from '../lib/restore.js'
import { tarPack, tarUnpack } from '../lib/tar.js'

async function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-fmb-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# 她是谁\n\n我不会说"作为一个AI"。\n', 'utf8')
  writeFileSync(join(dir, '00_core/relation.md'), '# 关系\n\n我们约过不催。\n', 'utf8')
  // 用 ArchiveWriter 写**真链**：手写 hash 过不了 checkArchive
  const w = new ArchiveWriter(dir)
  const msg = (seq, role, text) => {
    const m = {
      id: `msg-${seq}-abcdef`,
      role,
      content: [{ type: 'text', text }],
      source: { kind: role === 'user' ? 'user' : 'model' },
    }
    // [HOST: data-event-shape] user 的消息在 data 上，assistant 的在 data.message 里
    return {
      type: role === 'user' ? 'user/message' : 'assistant/message',
      seq,
      time: Date.parse('2026-11-06T10:00:00.000Z') + seq * 1000,
      surfaceOp: 'append',
      data: role === 'user' ? m : { message: m },
    }
  }
  await w.handle('s1', msg(1, 'user', '今天下雨'))
  await w.handle('s1', msg(2, 'assistant', '嗯，带伞'))
  await w.idle()
  return dir
}

// ── tar ────────────────────────────────────────────────────────
test('tar：打进去再解出来，字节一致', async () => {
  const files = [{ name: '00_core/soul.md', data: Buffer.from('她是谁') }, { name: 'a.txt', data: Buffer.from('x'.repeat(700)) }]
  const out = tarUnpack(tarPack(files))
  assert.equal(out.length, 2)
  assert.equal(out[0].name, '00_core/soul.md')
  assert.equal(out[0].data.toString(), '她是谁')
  assert.equal(out[1].data.length, 700, '跨 512 字节边界的文件要正确补齐')
})

test('tar：被截断要明说，不是静默丢文件', async () => {
  const buf = tarPack([{ name: 'a.txt', data: Buffer.from('x'.repeat(2000)) }])
  assert.throws(() => tarUnpack(buf.subarray(0, 700)), /截断/)
})

// ── B1 导出 ────────────────────────────────────────────────────
test('B1：导出一个文件，落下的是完整包（不残留 .partial）', async () => {
  const dir = await lib()
  const out = mkdtempSync(join(tmpdir(), 'fishmem-offsite-'))
  const r = exportFmb(dir, { outFile: join(out, 'fish-memory-20261106.fmb') })
  assert.ok(existsSync(r.file))
  const leftover = readdirSync(out).filter((f) => f.includes('.partial'))
  assert.deepEqual(leftover, [], '同步盘里只该出现一个写完的文件')
})

test('B1：包里不含绝对路径（这份文件要出门）', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out })
  const raw = readFileSync(out, 'utf8')
  assert.ok(!/[A-Za-z]:\\\\/.test(raw), '不该出现盘符路径')
  assert.ok(!raw.includes(dir), '不该出现库的绝对路径')
})

test('B1：头部明文——不给口令也知道是哪天、多大、几个文件', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out, key: 'pw' })
  const { head } = readFmbHeader(out)
  assert.equal(head.enc, 'aes-256-gcm')
  assert.match(head.created_at, /^\d{4}-\d{2}-\d{2}/)
  assert.ok(head.files > 0)
})

// ── B2 加密 ────────────────────────────────────────────────────
test('B2：加密包用对口令能解开，内容与原库一致', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out, key: '正确的口令' })
  const { files } = readFmb(out, { key: '正确的口令' })
  const soul = files.find((f) => f.name === '00_core/soul.md')
  assert.equal(soul.data.toString(), readFileSync(join(dir, '00_core/soul.md'), 'utf8'))
})

test('B2：口令不对要说"认证失败"，不是 JSON 解析错误', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out, key: '对的' })
  assert.throws(() => readFmb(out, { key: '错的' }), /认证失败/)
})

test('B2：加密包不给口令 → 明说需要口令，不静默当明文', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out, key: 'k' })
  assert.throws(() => readFmb(out), /需要口令/)
})

test('B2：改一个字节 → GCM 校验失败', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out, key: 'k' })
  const buf = readFileSync(out)
  buf[buf.length - 40] ^= 0xff
  writeFileSync(out, buf)
  assert.throws(() => readFmb(out, { key: 'k' }), /认证失败|不符/)
})

// ── B3 恢复 ────────────────────────────────────────────────────
test('B3：恢复到一个空目录 → 文件对、链是连的', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out })
  const dest = join(mkdtempSync(join(tmpdir(), 'fishmem-restore-')), 'restored')
  const r = restoreFmb(out, dest)
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dest, '00_core/soul.md'), 'utf8'), readFileSync(join(dir, '00_core/soul.md'), 'utf8'))
  assert.ok(existsSync(join(dest, '10_archive/messages/2026-11-06.jsonl')))
})

test('B3：链断了就拒绝恢复，且目标目录没被动过', async () => {
  const dir = await lib()
  // 把链改坏：第二行 prev 指错（文件名按实际找，不假设）
  const msgDir = join(dir, '10_archive/messages')
  const arch = readdirSync(msgDir).filter((f) => f.endsWith('.jsonl')).sort()[0]
  const archPath = join(msgDir, arch)
  const rows = readFileSync(archPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(rows.length >= 2, `档案里应有至少 2 行，实际 ${rows.length}：${arch}`)
  rows[1].prev = 'wrong-prev'
  writeFileSync(archPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out })
  const dest = join(mkdtempSync(join(tmpdir(), 'fishmem-restore-')), 'restored')
  assert.throws(() => restoreFmb(out, dest), /链校验失败/)
  assert.equal(existsSync(dest), false, '拒绝时不该建目标目录')
})

test('B3：目标非空且没 --force → 拒绝，一个文件都不写', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out })
  const dest = mkdtempSync(join(tmpdir(), 'fishmem-restore-'))
  writeFileSync(join(dest, 'existing.txt'), '别动我', 'utf8')
  assert.throws(() => restoreFmb(out, dest), /目标目录非空/)
  assert.equal(readFileSync(join(dest, 'existing.txt'), 'utf8'), '别动我')
})

test('B3：dryRun 什么都不改', async () => {
  const dir = await lib()
  const out = join(mkdtempSync(join(tmpdir(), 'fishmem-offsite-')), 'x.fmb')
  exportFmb(dir, { outFile: out })
  const dest = join(mkdtempSync(join(tmpdir(), 'fishmem-restore-')), 'nope')
  const r = restoreFmb(out, dest, { dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(existsSync(dest), false)
})

// ── 保留策略 ───────────────────────────────────────────────────
test('prune：只删自己命名的包，保留最近 N 天 + 每月 1 号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-prune-'))
  const names = ['20261001', '20261015', '20261101', '20261102', '20261103', '20261104', '20261105', '20261106']
  for (const d of names) writeFileSync(join(dir, `fish-memory-${d}.fmb`), 'x')
  writeFileSync(join(dir, 'notes.txt'), '别人的文件')
  const r = pruneFmb(dir, { keep: 3, monthly: 2 })
  assert.ok(r.removed.length > 0)
  assert.ok(readdirSync(dir).includes('notes.txt'), '不许碰目录里别的文件')
  assert.ok(readdirSync(dir).includes('fish-memory-20261106.fmb'), '最近的要留')
  assert.ok(!readdirSync(dir).includes('fish-memory-20261015.fmb'), '中间那些该删')
})

test('collectFiles：派生数据不进包（20_index / 90_snapshot）', async () => {
  const dir = await lib()
  mkdirSync(join(dir, '20_index'), { recursive: true })
  writeFileSync(join(dir, '20_index/index.json'), '{}')
  const names = collectFiles(dir).map((f) => f.name)
  assert.ok(!names.some((n) => n.startsWith('20_index/')), '派生数据能重建，不该进包')
})
