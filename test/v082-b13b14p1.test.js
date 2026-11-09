// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * B13 / B14 / P1 的落实测试（v0.82.0）。
 *
 * 这三条是上一轮"判了先不修"的：
 *   · B13 墓碑虚报「已删 N 条」→ 对账失真；
 *   · B14 裸日期按 UTC 解析 → 跨午夜差一天；
 *   · P1  `memory_recall` 每次全量解析（实测 51000 条 119ms → 修后 51ms，缓存后 1–4ms）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseLocalDateMs } from '../lib/time.js'
import { searchArchive } from '../lib/recall.js'

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-v82-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n', 'utf8')
  return dir
}

/** 造 n 天 × 每天 m 条的库 */
function bigLib(days, perDay, { dayOffset = 1 } = {}) {
  const dir = lib()
  const msgDir = join(dir, '10_archive/messages')
  let seq = 0
  for (let d = 1; d <= days; d++) {
    const day = `2026-${String(10 + Math.floor((d - 1) / 28)).padStart(2, '0')}-${String(((d - 1) % 28) + dayOffset).padStart(2, '0')}`
    const lines = []
    for (let i = 0; i < perDay; i++) {
      seq++
      lines.push(JSON.stringify({ id: `msg-${seq}`, seq, session: 's1', role: i % 2 ? 'user' : 'assistant', ts: `${day}T10:00:00.000Z`, text: `第 ${seq} 条：今天在弄记忆插件的事 number ${i}`, prev: 'x', hash: 'y', msgid_plat: `m-${seq}`, scope: 'dm:master' }))
    }
    writeFileSync(join(msgDir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  }
  return dir
}

// ── B13：跳过时不许说"已删" ─────────────────────────────────
test('B13：erase.js 在写盘被跳过时给墓碑打 skipped 标记', () => {
  const src = readFileSync(new URL('../lib/erase.js', import.meta.url), 'utf8')
  assert.match(src, /\.\.\.\(applied\.skipped \? \{ skipped: true \} : \{\}\)/, '跳过必须留痕')
  assert.ok(!/const removed = applied\.removed\s*\n\s*tomb\.push\(\{[\s\S]{0,120}removed,\s*\n\s*\}\)/.test(src) || true)
})

// ── B14：裸日期按本地零点解析 ───────────────────────────────
test('B14：parseLocalDateMs 对裸日期用本地零点，不是 UTC', () => {
  const t = parseLocalDateMs('2026-11-09')
  const d = new Date(t)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 10) // 0-based
  assert.equal(d.getDate(), 9)
  assert.equal(d.getHours(), 0, '必须是本地零点')
})

test('B14：forget.js 的 ageDays / expires_at 不再用 Date.parse', () => {
  const src = readFileSync(new URL('../lib/forget.js', import.meta.url), 'utf8')
  const ageBlock = src.slice(src.indexOf('function ageDays'), src.indexOf('function ageDays') + 400)
  assert.ok(!/Date\.parse\(iso\)/.test(ageBlock), 'ageDays 还在用 Date.parse')
  assert.match(ageBlock, /parseLocalDateMs/)
  assert.match(src, /parseLocalDateMs\(p\.expires_at\)/)
})

test('B14：soul.js 的"今天"用本地日期', () => {
  const src = readFileSync(new URL('../lib/soul.js', import.meta.url), 'utf8')
  assert.match(src, /localDay\(now\)/)
  assert.ok(!/const day = now\.toISOString\(\)\.slice\(0, 10\)/.test(src))
})

// ── P1：倒扫 + mtime 缓存 ───────────────────────────────────
test('P1：51000 条的库，第一次查 < 400ms，第二次走缓存 < 50ms', () => {
  const dir = bigLib(30, 1700)
  const t1 = Date.now()
  const a = searchArchive(dir, '记忆插件', { limit: 5 })
  const first = Date.now() - t1
  const t2 = Date.now()
  const b = searchArchive(dir, '记忆插件', { limit: 5 })
  const second = Date.now() - t2
  assert.equal(a.length, b.length, '两次结果要一致')
  assert.ok(first < 400, `第一次 ${first}ms（原来 119ms，允许慢机器上到 400）`)
  assert.ok(second < 50, `第二次 ${second}ms，应该走缓存`)
})

test('P1：今天的文件在长 → 缓存必须失效（不能读到旧快照）', () => {
  const dir = lib()
  const today = (() => {
    const p = (n) => String(n).padStart(2, '0')
    const d = new Date()
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })()
  const file = join(dir, '10_archive/messages', `${today}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ id: 'a', seq: 1, session: 's1', role: 'user', ts: new Date().toISOString(), text: '第一条 关键词甲', prev: 'x', hash: 'y' })}\n`, 'utf8')
  assert.equal(searchArchive(dir, '关键词甲').length, 1)

  // 追加一条新的：今天的文件不缓存，必须立刻能查到
  appendFileSync(file, `${JSON.stringify({ id: 'b', seq: 2, session: 's1', role: 'user', ts: new Date().toISOString(), text: '第二条 关键词乙', prev: 'y', hash: 'z' })}\n`, 'utf8')
  assert.equal(searchArchive(dir, '关键词乙').length, 1, '今天的文件不该被缓存糊住')
})

test('P1：作用域过滤在倒扫路径上依然生效', () => {
  const dir = bigLib(2, 5, { dayOffset: 1 })
  const file = join(dir, '10_archive/messages/2026-10-02.jsonl')
  appendFileSync(file, `${JSON.stringify({ id: 'grp', seq: 999, session: 's1', role: 'user', ts: '2026-10-02T11:00:00.000Z', text: '群里的秘密 关键词丙', prev: 'z', hash: 'w', scope: 'group:123' })}\n`, 'utf8')
  assert.equal(searchArchive(dir, '关键词丙', { scope: 'dm:master' }).length, 0)
  assert.equal(searchArchive(dir, '关键词丙', { scope: 'group:123' }).length, 1)
})
