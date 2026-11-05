// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 「她的今天」（v0.63.0，A+B）。
 *
 * 钉住四件事：
 *   ① **只读**——跑一屏不改任何文件（连 emotion 的 drift 都不补算）；
 *   ② **某块坏不拖垮整屏**——缺文件时显示"无数据"，其余照常；
 *   ③ **草稿口径和 scanPointFiles 一致**——README 不算草稿（第一版就数错过，把说明文件报成"1 条待审"）；
 *   ④ 心情给**句子**（档位 + 原因 + 解冻），不给刻度盘。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { draftsOf, moodOf, renderToday, talkOf, todayView } from '../lib/today.js'
import { renderDashboardHtml } from '../scripts/dashboard-html.mjs'

const NOW = new Date(2026, 10, 6, 12, 0, 0)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-today-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  return dir
}

const writeEmotion = (dir, over) =>
  writeFileSync(
    join(dir, '20_state/emotion.json'),
    JSON.stringify({
      version: 1,
      turns: 12,
      at: '2026-11-06T03:00:00Z',
      ai: { valence: -0.2, arousal: 0.5 },
      tier: 2,
      tierCause: '他让我降温',
      frozenUntil: NOW.getTime() + 25 * 60_000,
      ...over,
    }),
    'utf8',
  )

test('心情：给句子（档位 + 原因 + 解冻），不是刻度盘', () => {
  const dir = fixture()
  writeEmotion(dir, {})
  const m = moodOf(dir, NOW)
  assert.equal(m.ok, true)
  assert.equal(m.label, '有点生气')
  assert.match(m.text, /有点生气/)
  assert.match(m.text, /他让我降温/)
  assert.match(m.detail, /解冻/)
  assert.match(m.detail, /还有 25 分钟/)
})

test('心情：解冻时间已过就不说"还有几分钟"', () => {
  const dir = fixture()
  writeEmotion(dir, { frozenUntil: NOW.getTime() - 60_000 })
  const m = moodOf(dir, NOW)
  assert.equal(m.detail, '')
})

test('心情：没有 emotion.json 时说"无数据"，不抛', () => {
  const dir = fixture()
  const m = moodOf(dir, NOW)
  assert.equal(m.ok, false)
  assert.equal(m.text, '无数据')
})

test('聊了：只算今天，分角色', () => {
  const dir = fixture()
  const lines = [
    { id: 'm1', seq: 1, session: 's1', role: 'user', ts: '2026-11-06T10:00:00Z', text: '早' },
    { id: 'm2', seq: 2, session: 's1', role: 'assistant', ts: '2026-11-06T10:01:00Z', text: '嗯' },
    { id: 'm3', seq: 3, session: 's1', role: 'assistant', ts: '2026-11-05T10:00:00Z', text: '昨天' },
  ]
  writeFileSync(join(dir, '10_archive/messages/s1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  const t = talkOf(dir, NOW)
  assert.equal(t.total, 2, '昨天那条不算今天')
  assert.equal(t.user, 1)
  assert.equal(t.assistant, 1)
})

test('写了：README 不算草稿（第一版把说明文件数成"1 条待审"）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '40_pending/README.md'), '# 说明\n\n这不是草稿。', 'utf8')
  assert.equal(draftsOf(dir).count, 0, 'README 不该算草稿')

  writeFileSync(join(dir, '40_pending/M-2026-11-06-001.md'), '---\nid: M-2026-11-06-001\n---\n\n正文', 'utf8')
  assert.equal(draftsOf(dir).count, 1, '带 front matter 的才算')
})

test('只读：跑一屏不改任何文件', () => {
  const dir = fixture()
  writeEmotion(dir, {})
  writeFileSync(join(dir, '10_archive/messages/s1.jsonl'), JSON.stringify({ id: 'm1', seq: 1, session: 's1', role: 'user', ts: '2026-11-06T10:00:00Z', text: '早' }) + '\n', 'utf8')
  const before = readFileSync(join(dir, '20_state/emotion.json'), 'utf8')
  todayView(dir, NOW)
  const after = readFileSync(join(dir, '20_state/emotion.json'), 'utf8')
  assert.equal(after, before, '心情文件不该被补算/回写')
})

test('空库：六块都出得来，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-today-empty-'))
  const v = todayView(dir, NOW)
  assert.equal(v.day, '2026-11-06')
  assert.equal(v.weekday, '五')
  assert.match(renderToday(v), /她今天/)
  assert.match(renderToday(v), /心情/)
})

test('页面：自包含、2 秒刷新、写明只绑本机', () => {
  const html = renderDashboardHtml()
  assert.match(html, /她今天/)
  assert.match(html, /setInterval\(tick, 2000\)/)
  assert.match(html, /127\.0\.0\.1/)
  assert.ok(!/<script src=/.test(html), '不许有外链脚本（自包含）')
})
