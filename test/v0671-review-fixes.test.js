// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * WordBuddy 复审 v0.67.0 的九个发现（v0.67.1）。
 *
 * 这一版修的**全是"说了假话"或"没测到却说绿了"**：
 *   F1 `backup verify` 不验链却打印「链完整」
 *   F2 `memory verify --dir` 完全忽略 --dir（不存在的目录也说「自检通过」）
 *   F3 `tz-check` 解析到 0/0 却打 ✓（门禁等于不存在）
 *   F5 restore 链失败的原因被吞掉
 *   F7 库根的 .md 不进包
 *   F8 fidelity 基线没满却退 0
 *
 * 这些测试的共同点：**用外部命令的退出码**，而不是内部函数返回值——
 * 因为"假绿"最容易发生在"函数返回了，但 CLI 说错了话"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ArchiveWriter } from '../lib/archive.js'
import { exportFmb } from '../lib/fmb.js'
import { restoreFmb } from '../lib/restore.js'
import { collectFiles } from '../lib/fmb.js'
import { lastExchanges } from '../lib/were.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (args, env = {}) =>
  spawnSync(process.execPath, ['scripts/memory.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120000,
  })

async function lib({ work = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-671-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# 她是谁\n', 'utf8')
  writeFileSync(join(dir, 'MEMORY.md'), '# 这个库的说明书\n', 'utf8')

  const w = new ArchiveWriter(dir)
  const msg = (seq, role, text) => {
    const m = { id: `msg-${seq}-abcdef`, role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } }
    return {
      type: role === 'user' ? 'user/message' : 'assistant/message',
      seq,
      time: Date.parse('2026-11-06T10:00:00.000Z') + seq * 1000,
      surfaceOp: 'append',
      data: role === 'user' ? m : { message: m },
    }
  }
  if (work) {
    await w.handle('s1', msg(1, 'user', '把那个函数抽一下，测试也补上'))
    await w.handle('s1', msg(2, 'assistant', '改完了，lib/index.js 三处调用点都补上了'))
  } else {
    await w.handle('s1', msg(1, 'user', '今天有点想你了'))
    await w.handle('s1', msg(2, 'assistant', '我也在'))
  }
  await w.idle()
  return dir
}

// ── F1 ─────────────────────────────────────────────────────────
test('F1：坏链的包，backup verify 必须红（不许说"链完整"）', async () => {
  const dir = await lib()
  const arch = join(dir, '10_archive/messages')
  const f = readFileSync(join(arch, readdirFirst(arch)), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  f[1].prev = 'wrong-prev'
  writeFileSync(join(arch, '2026-11-06.jsonl'), f.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const out = join(dir, 'broken.fmb')
  exportFmb(dir, { outFile: out })
  const r = run(['backup', 'verify', out])
  assert.notEqual(r.status, 0, `本该失败，实际：${r.stdout}`)
  assert.ok(!/链完整/.test(r.stdout), `还说了"链完整"：${r.stdout}`)
})

function readdirFirst(d) {
  return readdirSync(d).filter((x) => x.endsWith('.jsonl')).sort()[0]
}

// ── F2 ─────────────────────────────────────────────────────────
test('F2：memory verify --dir 指向不存在的目录 → 红', () => {
  // 用运行时拼出来的不存在路径，不写死盘符（仓库里不该出现绝对路径）
  const ghost = join(mkdtempSync(join(tmpdir(), 'fishmem-ghost-')), 'nope')
  const r = run(['verify', '--dir', ghost])
  assert.notEqual(r.status, 0, `本该失败，实际：${r.stdout}${r.stderr}`)
  assert.match(r.stderr + r.stdout, /库不存在|✗/)
})

test('F2：memory verify --dir 指向真库 → 绿，且报档案数', async () => {
  const dir = await lib()
  const r = run(['verify', '--dir', dir])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /档案 \d+ 个文件 · 链完整/)
})

// ── F3 ─────────────────────────────────────────────────────────
test('F3：tz-check 显式指定 spec reporter，且解析到 0 条算失败', () => {
  const t = readFileSync(join(ROOT, 'scripts/tz-check.mjs'), 'utf8')
  assert.match(t, /'--test',\s*'--test-reporter=spec'/, '必须显式指定 reporter，否则管道下会变 TAP')
  assert.match(t, /tests > 0/, '解析到 0 条必须算失败')
})

test('F3：tz-check 的文件名不能再是 test-*（否则 node --test 会把门禁当测试跑）', () => {
  assert.equal(existsSync(join(ROOT, 'scripts/test-tz.mjs')), false, '旧名字会递归跑测试')
  assert.ok(existsSync(join(ROOT, 'scripts/tz-check.mjs')))
})

// ── F5 ─────────────────────────────────────────────────────────
test('F5：restore 拒绝坏链时，报错里要有原因（不是空冒号）', async () => {
  const dir = await lib()
  const arch = join(dir, '10_archive/messages')
  const f = readFileSync(join(arch, readdirFirst(arch)), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  f[1].prev = 'wrong-prev'
  writeFileSync(join(arch, '2026-11-06.jsonl'), f.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const out = join(dir, 'broken.fmb')
  exportFmb(dir, { outFile: out })
  const dest = join(mkdtempSync(join(tmpdir(), 'fishmem-restore-')), 'r')
  assert.throws(
    () => restoreFmb(out, dest),
    (e) => /链校验失败/.test(e.message) && /prev|reason|\.jsonl/.test(e.message),
    '报错要带上具体原因',
  )
})

// ── F7 ─────────────────────────────────────────────────────────
test('F7：库根的 .md（MEMORY.md）要进包', async () => {
  const dir = await lib()
  const names = collectFiles(dir).map((f) => f.name)
  assert.ok(names.includes('MEMORY.md'), `包里没有根目录的说明书：${names.slice(0, 5).join(',')}`)
})

// ── F8 ─────────────────────────────────────────────────────────
test('F8：fidelity 有格子没满时退 1（以前退 0，CI 抓不到退步）', () => {
  const r = spawnSync(process.execPath, ['scripts/fidelity.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 1, `基线没满应当退 1，实际 ${r.status}`)
})

// ── F4 ─────────────────────────────────────────────────────────
test('F4：纸条按会话判工作场——工作会话整段排除', async () => {
  const dir = await lib({ work: true })
  const { user } = lastExchanges(dir)
  assert.equal(user, null, `工作会话的原话不该进纸条：${user}`)
})

test('F4：真有一场日常对话时，取的是它', async () => {
  const dir = await lib({ work: true })
  const w = new ArchiveWriter(dir)
  const m = { id: 'msg-9-zzzzzz', role: 'user', content: [{ type: 'text', text: '今天有点想你了' }], source: { kind: 'user' } }
  await w.handle('s2', { type: 'user/message', seq: 3, time: Date.parse('2026-11-06T11:00:00.000Z'), surfaceOp: 'append', data: m })
  await w.idle()
  const { user } = lastExchanges(dir)
  assert.match(String(user), /想你了/)
})
