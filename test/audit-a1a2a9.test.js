// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * A1 / A2 / A9（v0.70.0）—— 审计 `AUDIT-2026-11-07-non-memory.md` 里的三条。
 *
 * 三条都是"**不影响正确性、只影响你会不会想退货**"的那类：
 *   A1 每轮全量读档案（5 万条时 +110ms/轮，而那个数根本不用读档案）
 *   A2 due 期间每来一条消息新建一个材料包目录（实测 tidy-40/41/42 并存，永不清理）
 *   A9 `tidy`/`habits` 不在配置白名单 → `tidy.every` 永远 35、`habits.enabled:false` 关不掉
 *
 * 全部用**外部可观察量**断言（不读源码、不看私有字段）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { noteArchived, prunePacks, tidyPack, tidyStatus } from '../lib/tidy.js'

function lib(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-a1-'))
  for (const d of ['10_archive/messages', '20_state', '30_points', '90_snapshot']) mkdirSync(join(dir, d), { recursive: true })
  const lines = []
  for (let i = 1; i <= rows; i++) {
    lines.push(JSON.stringify({ id: `msg-${i}-abcdef`, seq: i, session: 's1', role: 'user', ts: '2026-11-01T10:00:00Z', text: `第 ${i} 条` }))
  }
  writeFileSync(join(dir, '10_archive/messages/2026-11-01.jsonl'), lines.join('\n') + '\n', 'utf8')
  return dir
}

test('A1：账本校正过之后，再取状态不再读档案（数校正次数，不数时间）', async () => {
  const { tidyCounters } = await import('../lib/tidy.js')
  const dir = lib(3000)
  const before = tidyCounters.corrections

  const first = tidyStatus(dir) // 第一次要校正
  assert.equal(first.rows, 3000)
  assert.equal(tidyCounters.corrections, before + 1, '第一次应该校正一次')

  const second = tidyStatus(dir) // 第二次只读 20_state/tidy.json
  assert.equal(second.rows, 3000)
  assert.equal(tidyCounters.corrections, before + 1, '第二次不该再校正——那就是"又读了一遍全量档案"')

  // 档案被别的进程写新了 → 必须能发现（mtime 检测）
  const f = join(dir, '10_archive/messages/2026-11-09.jsonl')
  writeFileSync(f, JSON.stringify({ id: 'msg-9999-abcdef', seq: 9999, session: 's9', role: 'user', ts: '2026-11-09T10:00:00Z', text: '新的一条' }) + '\n', 'utf8')
  tidyStatus(dir)
  assert.equal(tidyCounters.corrections, before + 2, '档案变新时必须重新校正')
})

test('A1：档案被别的进程写新了 → 靠 mtime 发现并校正', () => {
  const dir = lib(40)
  assert.equal(tidyStatus(dir).rows, 40)
  // 追加 5 条，但**不走 noteArchived**（模拟另一个进程/手工改了档案）
  const f = join(dir, '10_archive/messages/2026-11-02.jsonl')
  const lines = []
  for (let i = 41; i <= 45; i++) lines.push(JSON.stringify({ id: `msg-${i}-abcdef`, seq: i, session: 's2', role: 'user', ts: '2026-11-02T10:00:00Z', text: `第 ${i} 条` }))
  writeFileSync(f, lines.join('\n') + '\n', 'utf8')
  assert.equal(tidyStatus(dir).rows, 45, 'mtime 比账本新 → 应该重新数')
})

test('A2：一个 due 周期只建一个材料包（不是每来一条建一个）', () => {
  const dir = lib(40)
  const a = tidyPack(dir)
  assert.equal(a.ok, true)
  const name = a.at.split(/[\\/]/).pop()

  // 再来 3 条（模拟 due 期间的对话）
  for (let i = 41; i <= 43; i++) noteArchived(dir, 1)
  const b = tidyPack(dir)

  assert.equal(b.at.split(/[\\/]/).pop(), name, '包名按水位起点，不该随条数变')
  const packs = readdirSync(join(dir, '90_snapshot')).filter((d) => /^tidy-\d+$/.test(d))
  assert.equal(packs.length, 1, `只该有一个包，实际：${packs.join(',')}`)
})

test('A2：包只保留最近 3 个，且不碰别人命名的目录', () => {
  const dir = lib(10)
  const root = join(dir, '90_snapshot')
  for (const n of [0, 40, 80, 120, 160]) mkdirSync(join(root, `tidy-${n}`), { recursive: true })
  mkdirSync(join(root, 'my-notes'), { recursive: true })
  const r = prunePacks(dir, { keep: 3, keepName: 'tidy-160' })
  assert.ok(r.removed.length >= 1)
  const left = readdirSync(root)
  assert.ok(left.includes('my-notes'), '不许删别人命名的目录')
  assert.ok(left.includes('tidy-160'), '当前周期的包要留')
  assert.ok(left.filter((d) => /^tidy-\d+$/.test(d)).length <= 3)
})

test('A9：tidy.every 和 habits.enabled 能进配置（以前被当拼错的键丢掉）', () => {
  const c = normalizeConfig({ tidy: { every: 5 }, habits: { enabled: false } })
  assert.equal(c.tidy?.every, 5)
  assert.equal(c.habits?.enabled, false)
})

test('A9：越界的 tidy.every 被拒（不让它悄悄变成奇怪的值）', () => {
  const c = normalizeConfig({ tidy: { every: 1 } })
  assert.notEqual(c.tidy?.every, 1, '5 以下不该被接受')
})
