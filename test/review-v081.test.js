// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 评审 v0.80.1 的落实测试（v0.81.0）。
 *
 * 那轮评审最扎人的一句是：**"防御体系是为人写的，也让最简单的 ReferenceError
 * 获得了和设计取舍同等的隐身待遇。"**
 *
 * 所以这里的每条测试都盯着"接线"而不是"逻辑"：
 *   · B1/B2/B3 —— 三个 `not defined`，被 try/catch 吞了几个月；
 *   · B7 —— 读的 JSON 形状和写的一方毫不相干，恒 false；
 *   · B8 —— flag 的**值**被当成 id；
 *   · B9 —— 传参传错，完好素材恒"校验没过"；
 *   · S1/S2 —— 解包路径穿越（三条路径里漏了两条）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSafeRelPath, safeRelPath } from '../lib/pathsafe.js'
import { wasInjectedRecently } from '../lib/forget.js'
import { loadTidy } from '../lib/tidy.js'
import { noteArchived } from '../lib/tidy.js'
import { stateLooksStale } from '../lib/tidy.js'
import * as indexSrc from 'node:fs'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-v81-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n', 'utf8')
  return dir
}

// ── B1/B2/B3：接线（静态但精确）──────────────────────────────────
test('B1/B2/B3：index.js 里用到的每个符号都有 import', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const name of ['setSessionMode', 'tidyLine', 'tidyPack']) {
    const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(src)
    assert.ok(imported, `${name} 被用了却没 import —— 这类错会被 try/catch 吞成一行 warn`)
  }
})

test('B1：gap 草稿那段用的是 msgId，不是未定义的 message', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const at = src.indexOf('const prev = store.lastMessage()')
  assert.ok(at > 0, '找不到 gap 草稿那段')
  // 只看**代码**：注释里会提到 `message?.id`（说明这条 bug 的由来），不算命中
  const body = src
    .slice(at, at + 900)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.ok(!/if \(prev && message\?\.id\)/.test(body), 'noteUserMessage 的形参是 msgId，不是 message')
  assert.ok(!/id: message\.id/.test(body), '同上')
  assert.match(body, /if \(prev && msgId\)/)
})

// ── B7：遗忘保护的读写形状要对得上 ────────────────────────────
test('B7：按现行形状（points[id].inj 轮次数组）能判出"最近注入过"', () => {
  const dir = lib()
  writeFileSync(
    join(dir, '20_state/inj10.json'),
    JSON.stringify({ version: 1, tick: 100, points: { 'M-1': { inj: [98, 99, 100], ll: '2026-11-08T00:00:00Z' } } }),
    'utf8',
  )
  assert.equal(wasInjectedRecently(dir, 'M-1'), true, '刚注入过的点必须判 true')
  assert.equal(wasInjectedRecently(dir, 'M-2'), false)
})

test('B7：很久以前注入的（超出窗口）不再保护', () => {
  const dir = lib()
  writeFileSync(
    join(dir, '20_state/inj10.json'),
    JSON.stringify({ version: 1, tick: 5000, points: { 'M-1': { inj: [10] } } }),
    'utf8',
  )
  assert.equal(wasInjectedRecently(dir, 'M-1', new Date(), { days: 30 }), false)
})

// ── P5：账本指纹要跟着档案走 ──────────────────────────────────
test('P5：写进档案之后，账本不该再"看起来过期"', () => {
  const dir = lib()
  writeFileSync(join(dir, '10_archive/messages/2026-11-08.jsonl'), '{"a":1}\n', 'utf8')
  noteArchived(dir, 1)
  const st = loadTidy(dir)
  assert.equal(stateLooksStale(dir, st), false, 'noteArchived 之后指纹应该是新的')
})

// ── B8：erase 不许把 flag 的值当 id ──────────────────────────
test('B8：`memory erase <id> --reason "测试"` 里，"测试" 不该被当成消息 id', () => {
  const src = readFileSync(new URL('../scripts/memory.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function cmdErase'), src.indexOf('function cmdErase') + 1200)
  assert.match(body, /VALUE_FLAGS/, '应该声明"哪些 flag 带值"')
  assert.match(body, /i \+= 1/, '应该跳过 flag 的值')
})

// ── S1/S2：解包路径 ────────────────────────────────────────
test('S1/S2：三条解包路径都拒绝 ../ 、绝对路径、盘符', () => {
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:\\Windows\\x', '', '   ']) {
    assert.equal(safeRelPath(bad), false, `${JSON.stringify(bad)} 应该被拒`)
    assert.throws(() => assertSafeRelPath(bad), /不安全/)
  }
  for (const ok of ['10_archive/messages/2026-11-08.jsonl', 'a/b.json', '中文文件.md']) {
    assert.equal(safeRelPath(ok), true, `${ok} 应该放行`)
  }
})

test('S1：pack.js 与 memory.mjs 都用了同一个校验函数（不是各写一遍）', () => {
  const pack = readFileSync(new URL('../lib/pack.js', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../scripts/memory.mjs', import.meta.url), 'utf8')
  const restore = readFileSync(new URL('../lib/restore.js', import.meta.url), 'utf8')
  for (const [name, src] of [['pack.js', pack], ['memory.mjs', cli], ['restore.js', restore]]) {
    assert.match(src, /pathsafe\.js/, `${name} 应该复用 pathsafe.js`)
  }
})

// ── B9/B11：两条静默失效 ────────────────────────────────────
test('B9：evidence 调 verifyAsset 时传的是 entry，不是 source 字符串', () => {
  const src = readFileSync(new URL('../lib/evidence.js', import.meta.url), 'utf8')
  assert.ok(!/verifyAsset\(dir, src[,)]/.test(src), '传 src 会让完好素材恒"校验没过"')
  assert.match(src, /verifyAsset\(dir, entry\)/)
})

test('B11：材料包的"最近原文"用真换行，不是字面量反斜杠 n', () => {
  const src = readFileSync(new URL('../lib/tidy.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('function renderRecent'), src.indexOf('function renderRecent') + 600)
  assert.ok(!/join\('\\\\\\\\n'\)/.test(seg), "还在用字面量 '\\\\n' 拼接")
  assert.ok(!/\\\\s\+/.test(seg), '正则还写着字面量 \\\\s+')
})
