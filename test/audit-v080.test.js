// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 审计 v0791 的落实测试（v0.80.0）。
 *
 * 那一轮的两条 P0 都不是"代码写错"，而是**两条规则在同一处打架**：
 *   · F1：一条规则说"抽样也算过"，另一条把抽样当否决 → 16MB 以上恒红 → 备份恢复被拒
 *   · F2：一条规则说"档案只追加"，另一条在档案上做整文件替换却不持锁 → 吃掉并发写入
 *
 * 这一组测试钉的是"两条规则不再打架"，不是"某个函数返回 true"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter, hashOf, redactArchive, verifyChain } from '../lib/archive.js'
import { MAX_VERIFY_BYTES, checkArchive } from '../lib/integrity.js'
import { redactText } from '../lib/redact.js'
import { parseContextQuery } from '../lib/serveapi.js'
import { MemoryStore } from '../lib/store.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-f-'))
  for (const d of ['10_archive/messages', '20_state', '30_points', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const ev = (seq, text) => ({
  type: 'user/message',
  seq,
  time: Date.parse('2026-11-08T10:00:00Z') + seq * 1000,
  surfaceOp: 'append',
  data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

// ── F1：大库的完整性检查不再恒红 ───────────────────────────────
test('F1：超过 16MB 的健康库，checkArchive.ok 为 true 且标了 sampled', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  // 每条 ~90KB，200 条 ≈ 18MB（用多条而不是一条 3MB：单条大文本会拖慢别的测试）
  const chunk = '正常的一段话，没有敏感信息。'.repeat(3000)
  for (let i = 1; i <= 200; i++) w.handle('s1', ev(i, `${i}:${chunk}`))
  await w.queue
  await w.idle()

  const size = statSync(join(dir, '10_archive/messages/2026-11-08.jsonl')).size
  assert.ok(size > MAX_VERIFY_BYTES, `夹具要真超过阈值，实际 ${(size / 1048576).toFixed(1)}MB`)

  const r = checkArchive(dir, { persist: false })
  assert.equal(r.sampled, true, '超过阈值应该标"抽样"')
  assert.deepEqual(r.broken, [], `健康的大库不该报断链：${JSON.stringify(r.broken)}`)
  assert.equal(r.ok, true, '抽样不是否决理由——大库恰恰最需要能通过')
})

test('F1：抽样的时候，接缝不再被当成断链', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  const chunk = 'x'.repeat(90_000)
  for (let i = 1; i <= 200; i++) w.handle('s1', ev(i, `${i}${chunk}`))
  await w.queue
  await w.idle()
  const r = checkArchive(dir, { persist: false })
  assert.equal(r.broken.length, 0)
})

test('F1：大库里真的断了一条，仍然要报红（不能因为抽样就放水）', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  const chunk = 'y'.repeat(90_000)
  for (let i = 1; i <= 200; i++) w.handle('s1', ev(i, `${i}${chunk}`))
  await w.queue
  await w.idle()

  // 改**头部**第 3 条（抽样能覆盖到）
  const file = join(dir, '10_archive/messages/2026-11-08.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  const rec = JSON.parse(lines[2])
  rec.text = `${rec.text}（被改过）`
  lines[2] = JSON.stringify(rec)
  writeFileSync(file, lines.join('\n'), 'utf8')

  const r = checkArchive(dir, { persist: false })
  assert.equal(r.ok, false, '抽样也要能抓到头部篡改')
})

// ── F2：脱敏不再吃并发写入 ─────────────────────────────────────
test('F2：redactArchive 与并发追加同时发生，消息不许丢', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  // 300 条带邮箱的记录（脱敏会真的改它们）
  for (let i = 1; i <= 300; i++) w.handle('s1', ev(i, `第 ${i} 条，邮箱 user${i}@example.com`))
  await w.queue
  await w.idle()

  const w2 = new ArchiveWriter(dir)
  const writing = (async () => {
    for (let i = 301; i <= 340; i++) {
      w2.handle('s1', ev(i, `并发写入第 ${i} 条`))
      await new Promise((r) => setTimeout(r, 2))
    }
    await w2.queue
    await w2.idle()
  })()
  await new Promise((r) => setTimeout(r, 5))
  redactArchive(dir)
  await writing

  const file = join(dir, '10_archive/messages/2026-11-08.jsonl')
  const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(recs.length >= 340, `并发写的 40 条必须都在（或这一轮跳过），实际 ${recs.length} 行`)
  const texts = new Set(recs.map((r) => r.text))
  for (let i = 301; i <= 340; i++) {
    assert.ok(
      [...texts].some((t) => t.includes(`并发写入第 ${i} 条`)),
      `第 ${i} 条并发消息被吃掉了`,
    )
  }
})

// ── F3：长串不触发二次回溯 ─────────────────────────────────────
test('F3：64KB 的长串脱敏要在 100ms 内（原来是 2.1 秒）', () => {
  const t0 = performance.now()
  redactText('y'.repeat(64_000))
  const ms = performance.now() - t0
  assert.ok(ms < 100, `64KB 花了 ${ms.toFixed(1)}ms，说明二次回溯还在`)
})

test('F3：长文本里夹着的邮箱仍然被打码（分片不能把识别吃掉）', () => {
  const text = `${'a'.repeat(20_000)} 联系 zhang.san@example.com ${'b'.repeat(20_000)}`
  const r = redactText(text)
  assert.ok(r.text.includes('[脱敏:邮箱]'), '分片之后仍然要认得出邮箱')
  assert.ok(!r.text.includes('zhang.san@example.com'))
})

// ── F4：删掉 hash 不再等于免检 ────────────────────────────────
test('F4：把最后一条改了并删掉 hash，验链必须报红', async () => {
  const dir = lib()
  const w = new ArchiveWriter(dir)
  for (let i = 1; i <= 5; i++) w.handle('s1', ev(i, `第 ${i} 条`))
  await w.queue
  await w.idle()

  const file = join(dir, '10_archive/messages/2026-11-08.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const rec = JSON.parse(lines[lines.length - 1])
  rec.text = '我从来没有答应过那件事'
  delete rec.hash
  lines[lines.length - 1] = JSON.stringify(rec)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

  const r = checkArchive(dir, { persist: false })
  assert.equal(r.ok, false, '删掉 hash 就是免检——这正是要堵的洞')
})

test('F4：首条 prev 不是 genesis（从开头删了几条）也要报', () => {
  const recs = [
    { id: 'a', seq: 3, session: 's', role: 'user', ts: '2026-11-08T10:00:00Z', text: '一', prev: 'deadbeef' },
    { id: 'b', seq: 4, session: 's', role: 'user', ts: '2026-11-08T10:00:01Z', text: '二', prev: 'x' },
  ]
  recs[0].hash = hashOf(recs[0])
  const r = verifyChain(recs)
  assert.equal(r.ok, false)
  assert.match(r.reason, /首条不是链头/)
})

test('F4：验尾巴快照时不要求首条是链头（verifyLatest 的场景）', () => {
  const recs = [
    { id: 'a', seq: 9, session: 's', role: 'user', ts: '2026-11-08T10:00:00Z', text: '一', prev: 'deadbeef' },
  ]
  recs[0].hash = hashOf(recs[0])
  assert.equal(verifyChain(recs, { requireHead: false }).ok, true)
})

// ── F5：/context 的 session 不许穿目录 ─────────────────────────
test('F5：parseContextQuery 拒绝 ../ 和斜杠', () => {
  for (const bad of ['../../leak', 'a/b', '..', '.hidden', 'x'.repeat(65)]) {
    const r = parseContextQuery(new URLSearchParams({ q: '你好', session: bad }))
    assert.equal(r.ok, false, `${bad} 应该被拒`)
  }
  assert.equal(parseContextQuery(new URLSearchParams({ q: '你好', session: 'session-abc_1.2' })).ok, true)
})

test('F5：就算上游漏了校验，store.sessionPath 也不许拼出库外路径', () => {
  const dir = lib()
  const store = new MemoryStore(dir)
  assert.throws(() => store.session('../../leak'), /session id 不合法/)
})
