// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 整理机触发器（v0.68.0，T1）。
 *
 * 起因：`docs/PLAN-2026-11-07-memory-shape.md` —— 整理这条链
 * （她写草稿 → 人 promote）**唯一断掉的一环是节拍**。
 *
 * 钉住：
 *   ① 到线才提醒（35 条），不到线一个字都不多；
 *   ② **只有 `--done` 会前移水位**（代码永不自动"算整理过了"）；
 *   ③ 账本丢了/坏了不炸，只是回到"不提醒"；
 *   ④ 备料是派生物（`90_snapshot/`），不进 pack、不进注入、可随手删；
 *   ⑤ **不写任何记忆点**——这条是这个功能存在的理由。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TIDY_FILE, TIDY_EVERY, loadTidy, markTidyDone, noteArchived, saveTidy, tidyLine, tidyPack, tidyStatus } from '../lib/tidy.js'

function lib(rows = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tidy-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log', '90_snapshot']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  // 造 rows 条档案（内容无所谓，tidy 只看条数）
  if (rows > 0) {
    const lines = []
    for (let i = 1; i <= rows; i++) {
      lines.push(JSON.stringify({ id: `msg-${i}-abcdef`, seq: i, session: 's1', role: i % 2 ? 'user' : 'assistant', ts: `2026-11-0${(i % 9) + 1}T10:00:00Z`, text: `第 ${i} 条` }))
    }
    writeFileSync(join(dir, '10_archive/messages/2026-11-01.jsonl'), lines.join('\n') + '\n', 'utf8')
  }
  return dir
}

test('不到线（<35）不提醒，一个字都不多', () => {
  const dir = lib(10)
  const r = tidyLine(dir)
  assert.equal(r.text, '')
  assert.equal(tidyStatus(dir).due, false)
})

test('到线（≥35）给一行提醒，且带"多了几条"', () => {
  const dir = lib(TIDY_EVERY)
  const r = tidyLine(dir)
  assert.match(r.text, /该整理了/)
  assert.match(r.text, new RegExp(String(TIDY_EVERY)))
  assert.ok(r.text.length < 120, '一行要短')
})

test('只有 --done 会前移水位；前移后不再提醒', () => {
  const dir = lib(TIDY_EVERY + 5)
  assert.equal(tidyStatus(dir).due, true)
  const before = loadTidy(dir).lastTidyRows
  assert.equal(before, 0)
  const r = markTidyDone(dir)
  assert.equal(r.tidiedSince, TIDY_EVERY + 5)
  assert.equal(tidyStatus(dir).due, false)
  assert.equal(tidyLine(dir).text, '')
  assert.ok(existsSync(join(dir, '50_log/tidy.log')), '完成要留痕')
})

test('noteArchived 只是加数，不会触发任何整理', () => {
  const dir = lib(0)
  noteArchived(dir, 3)
  noteArchived(dir, 2)
  assert.equal(loadTidy(dir).rows, 5)
  assert.equal(tidyStatus(dir).due, false, '加数不等于到线')
})

test('账本丢了/坏了不炸，只是回到"不提醒"', () => {
  const dir = lib(40)
  writeFileSync(join(dir, TIDY_FILE), '{这不是 JSON', 'utf8')
  const s = tidyStatus(dir)
  assert.equal(s.rows, 40, '会从真实档案校正回来')
  assert.doesNotThrow(() => tidyLine(dir))
})

test('备料：出四个文件，且 **不写任何记忆点/草稿**', () => {
  const dir = lib(TIDY_EVERY)
  const before = readdirSync(join(dir, '30_points')).length + readdirSync(join(dir, '40_pending')).length
  const r = tidyPack(dir)
  assert.equal(r.ok, true)
  const files = readdirSync(r.at).sort()
  assert.deepEqual(files, ['index.md', 'new-points.md', 'pending.md', 'recent.md'])
  const after = readdirSync(join(dir, '30_points')).length + readdirSync(join(dir, '40_pending')).length
  assert.equal(after, before, '整理机不许自己写记忆点')
  assert.match(r.at, /90_snapshot/, '材料包是派生物')
})

test('备料幂等：同一水位不重复写盘', () => {
  const dir = lib(TIDY_EVERY)
  const a = tidyPack(dir)
  const b = tidyPack(dir)
  assert.equal(b.reused, true)
  assert.equal(a.at, b.at)
})

test('不到线时 tidyPack 明说 not-due，不硬造空包', () => {
  const dir = lib(3)
  const r = tidyPack(dir)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-due')
  assert.equal(existsSync(join(dir, '90_snapshot/tidy-3')), false)
})

test('可以用 every 覆盖节拍（配置里改）', () => {
  const dir = lib(10)
  assert.equal(tidyStatus(dir, { every: 10 }).due, true)
  assert.equal(tidyStatus(dir, { every: 50 }).due, false)
})

test('saveTidy 写的是原子 JSON（load 读得回来）', () => {
  const dir = lib(0)
  saveTidy(dir, { rows: 7, lastTidyRows: 7, lastTidyAt: '2026-11-07T00:00:00.000Z', lastPackRows: 7 })
  const st = loadTidy(dir)
  assert.equal(st.rows, 7)
  assert.equal(st.lastTidyAt, '2026-11-07T00:00:00.000Z')
})
