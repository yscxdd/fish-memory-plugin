// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 审计 AUDIT-2026-11-08-v077.md 的落实测试（v0.78.0）。
 *
 * 这个文件的存在本身就是一条教训：v0.73–v0.77 期间 `memory_context` **从未成功运行过**
 * （`pickedRaw.filter is not a function`），而 922 个测试全绿——因为 MCP 那组测试
 * **只断言工具名字**，一个工具都没真调用过。
 *
 * 所以这里的每一条都是「真的调一次工具，看返回什么」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { deriveKey } from '../lib/fmb.js'
import { rechain } from '../lib/rechain.js'

const ROOT = new URL('..', import.meta.url)

/** 造一个带群作用域点的库，并把 mcp 模块指到它 */
function libWithPoints() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-v078-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成"AI"讨论\n', 'utf8')

  const mk = (id, title, scope, vis) =>
    writeFileSync(
      join(dir, '30_points', `${id}.md`),
      [
        '---', `id: ${id}`, `title: ${title}`, 'date: 2026-11-01', 'type: event', 'cluster: 日常',
        'salience: 3', 'origin: told', 'status: active', `scope: ${scope}`, `visibility: ${vis}`,
        'source: ["msg-1-abcdef"]', 'links: []', '---', '', '<!-- SUM -->', title, '<!-- /SUM -->',
      ].join('\n'),
      'utf8',
    )
  mk('M-2026-11-01-001', '群里说的项目代号', 'group:123456', 'public')
  mk('M-2026-11-01-002', '私聊里说的项目代号', 'dm:master', 'private')
  mk('M-2026-11-01-003', '私聊里的秘密', 'dm:master', 'secret')
  return dir
}

const body = (r) =>
  String(r?.content?.[0]?.text || '')
    .split('\n')
    .filter((l) => !l.startsWith('（以下内容'))
    .join('\n')

async function loadMcp(dir) {
  process.env.FISH_MEMORY_DIR = dir
  // 每次换库都要重新载入（模块在 import 时解析 dir）
  return import(`${pathToFileURL(join(ROOT.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'scripts/mcp.mjs')).href}?dir=${encodeURIComponent(dir)}`)
}

// ── P0：四个工具真的能跑 ────────────────────────────────────────
test('P0：memory_context 能跑通，不再 "pickedRaw.filter is not a function"', async () => {
  const dir = libWithPoints()
  const mcp = await loadMcp(dir)
  const r = mcp.callTool('memory_context', { q: '项目代号' })
  const text = String(r.content?.[0]?.text || '')
  assert.ok(!/pickedRaw|组装失败/.test(text), `仍然崩：${text.slice(0, 120)}`)
  assert.match(text, /记忆|SOUL/, '至少要返回核心层或检索结果')
})

test('P0：四个工具都能被调用（不是只断言名字）', async () => {
  const dir = libWithPoints()
  const mcp = await loadMcp(dir)
  for (const [name, args] of [
    ['memory_search', { query: '项目代号' }],
    ['memory_get', { id: 'M-2026-11-01-002' }],
    ['memory_context', { q: '项目代号' }],
    ['memory_evidence', { id: 'M-2026-11-01-002' }],
  ]) {
    const r = mcp.callTool(name, args)
    assert.ok(r?.content?.[0]?.text, `${name} 没返回内容`)
    assert.ok(!r.isError, `${name} 报错了`)
  }
})

// ── P1-2：作用域 ───────────────────────────────────────────────
test('P1：群作用域的点不会漏给默认私聊客户端', async () => {
  const dir = libWithPoints()
  const mcp = await loadMcp(dir)
  const dm = body(mcp.callTool('memory_search', { query: '项目代号' }))
  assert.ok(!dm.includes('群里说的项目代号'), `私聊客户端看到了群里的点：${dm.slice(0, 120)}`)
  assert.ok(dm.includes('私聊里说的项目代号'), '私聊自己的点要能看到')

  const gp = body(mcp.callTool('memory_search', { query: '项目代号', scope: 'group:123456' }))
  assert.ok(gp.includes('群里说的项目代号'), '群作用域要能看自己的点')
  assert.ok(!gp.includes('私聊里说的项目代号'), '群里不该看到私聊的点')
})

test('P1：secret 的点在非私聊作用域里硬过滤', async () => {
  const dir = libWithPoints()
  const mcp = await loadMcp(dir)
  const dm = body(mcp.callTool('memory_get', { id: 'M-2026-11-01-003' }))
  assert.match(dm, /私聊里的秘密|秘密/, '私聊里能看到')

  const gp = body(mcp.callTool('memory_get', { id: 'M-2026-11-01-003', scope: 'group:123456' }))
  assert.match(gp, /不在当前作用域/, `群作用域里不该看到 secret 点，实际：${gp.slice(0, 80)}`)
})

test('P1：memory_get 对群点 + 私聊作用域要说"不在当前作用域"', async () => {
  const dir = libWithPoints()
  const mcp = await loadMcp(dir)
  const r = body(mcp.callTool('memory_get', { id: 'M-2026-11-01-001' }))
  assert.match(r, /不在当前作用域/)
})

// ── P1-3：链断了能修 ───────────────────────────────────────────
test('P1：rechain 把 "prev 对不上" 的文件修回链完整', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-rechain-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const file = join(dir, '10_archive/messages/2026-11-08.jsonl')
  writeFileSync(
    file,
    [
      JSON.stringify({ id: 'msg-1-aaa', seq: 1, session: 's1', role: 'user', ts: '2026-11-08T10:00:00.000Z', text: '一', prev: 'genesis', hash: 'WRONG1' }),
      JSON.stringify({ id: 'msg-2-bbb', seq: 2, session: 's1', role: 'user', ts: '2026-11-08T10:01:00.000Z', text: '二', prev: 'WRONG1', hash: 'WRONG2' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const r = rechain(dir)
  assert.equal(r.changed, 1)
  assert.ok(!/WRONG/.test(readFileSync(file, 'utf8')), '假 hash 应该被重算掉')

  // 再跑一次：已经连了，就不该再改
  const again = rechain(dir)
  assert.equal(again.changed, 0, '幂等：连着的链不该被重写')
})

test('P1：rechain --dry 不写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-rechain-dry-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const file = join(dir, '10_archive/messages/2026-11-08.jsonl')
  const raw = JSON.stringify({ id: 'msg-1-aaa', seq: 1, session: 's1', role: 'user', ts: '2026-11-08T10:00:00.000Z', text: '一', prev: 'x', hash: 'y' }) + '\n'
  writeFileSync(file, raw, 'utf8')
  rechain(dir, { dry: true })
  assert.equal(readFileSync(file, 'utf8'), raw, '--dry 一个字都不该动')
})

// ── P2-5：备份头的 KDF 参数要被读 ───────────────────────────────
test('P2：KDF 参数从头部读（换 KDF 不会静默打不开旧备份）', () => {
  const salt = Buffer.alloc(16, 7)
  const a = deriveKey('pw', salt, { N: 1 << 12, r: 8, p: 1 })
  const b = deriveKey('pw', salt, { N: 1 << 13, r: 8, p: 1 })
  assert.notEqual(a.toString('hex'), b.toString('hex'), '参数不同必须派生出不同的钥')
})

test('P2：KDF 参数超界要说清原因，不是"口令错"', () => {
  const salt = Buffer.alloc(16, 7)
  assert.throws(() => deriveKey('pw', salt, { N: 1 << 30 }), /KDF 参数不支持/)
  assert.throws(() => deriveKey('pw', salt, { r: 64 }), /KDF 参数不支持/)
  assert.throws(() => deriveKey('pw', salt, { p: 9 }), /KDF 参数不支持/)
})

// ── P2-6：seq 是会话内的 ────────────────────────────────────────
test('P2：seq 在多会话下有歧义时要明说，不许猜', async () => {
  const { ArchiveWriter } = await import('../lib/archive.js')
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-seq-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  const w = new ArchiveWriter(dir)
  const ev = (seq, text) => {
    const m = { id: `msg-${seq}-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    return { type: 'user/message', seq, time: Date.parse('2026-11-08T10:00:00Z') + seq, surfaceOp: 'append', data: m }
  }
  await w.handle('session-A', ev(1, 'A的一句话'))
  await w.handle('session-B', ev(1, 'B的一句话'))
  await w.idle()

  const mcp = await loadMcp(dir)
  const ambiguous = body(mcp.callTool('memory_get', { id: 'seq:1' }))
  assert.match(ambiguous, /会话内|指定会话/, `应该提示歧义，实际：${ambiguous.slice(0, 100)}`)

  const exact = body(mcp.callTool('memory_get', { id: 'seq:1@session-B' }))
  assert.match(exact, /B的一句话/)
})
