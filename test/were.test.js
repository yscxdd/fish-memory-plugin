// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 「上次聊到哪儿」的纸条（v0.37.0，③ 组）——借自《AI伙伴运行机制》的"轻唤醒读的那张纸"。
 *
 * 钉住：
 *   ① 只摘原话，不写结论（不总结、不评价）；
 *   ② 没写完的半句单独留一行；
 *   ③ 去掉 markdown 标记（那不是字），但一个字都不删；
 *   ④ ≤300 字，人一眼能看完；
 *   ⑤ 什么时候重写：没有 / 跨天 / 隔 ≥6 小时回来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WERE_FILE, WERE_MAX_CHARS, lastExchanges, maybeWriteWere, readWere, renderWere, wereIsToday, writeWere } from '../lib/were.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function fixture(rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-were-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '31_dormant', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  if (rows.length) {
    writeFileSync(
      join(dir, '10_archive/messages/2026-11-03.jsonl'),
      rows
        .map((r, i) =>
          JSON.stringify({ id: `msg-${i + 1}`, seq: i + 1, role: r.role, text: r.text, ts: `2026-11-03T10:0${i}:00.000Z`, session: 's' }),
        )
        .join('\n') + '\n',
      'utf8',
    )
  }
  return dir
}

test('纸条：只摘原话，不写结论', () => {
  const dir = fixture([
    { role: 'user', text: '我最近有点不知道该怎么办' },
    { role: 'assistant', text: '那就先别急着决定' },
  ])
  const text = renderWere(dir, { now: NOW })
  assert.match(text, /他最后说：「我最近有点不知道该怎么办」/)
  assert.match(text, /她最后说：「那就先别急着决定」/)
  assert.doesNotMatch(text, /结论是|建议|总结/, '不许写结论')
})

test('没说完的半句单独留一行', () => {
  const dir = fixture([
    { role: 'user', text: '我跟你说个事' },
    { role: 'assistant', text: '你先说，我听着，' },
  ])
  const text = renderWere(dir, { now: NOW })
  assert.match(text, /没说完：「/)
})

test('markdown 标记去掉，字一个不删', () => {
  const dir = fixture([
    { role: 'user', text: '看看这个' },
    { role: 'assistant', text: '**重点**是这三条：\n- 第一条\n- 第二条' },
  ])
  const text = renderWere(dir, { now: NOW })
  assert.doesNotMatch(text, /\*\*/)
  assert.match(text, /重点是这三条/)
  assert.match(text, /第一条/)
})

test('优先挑短的那句（长清单不像话）', () => {
  const dir = fixture([
    { role: 'user', text: '好' },
    { role: 'assistant', text: '很长的清单'.repeat(40) },
    { role: 'assistant', text: '嗯，我在' },
  ])
  const { assistant } = lastExchanges(dir)
  assert.equal(assistant, '嗯，我在')
})

test('≤300 字（人一眼能看完）', () => {
  const dir = fixture([
    { role: 'user', text: '这是一段很长的输入'.repeat(10) },
    { role: 'assistant', text: '这是一段很长的回复'.repeat(10) },
  ])
  const r = writeWere(dir, { now: NOW })
  assert.ok(r.chars <= WERE_MAX_CHARS, `实际 ${r.chars} 字`)
})

test('什么时候重写：第一次 / 跨天 / 隔 ≥6 小时回来', () => {
  const dir = fixture([{ role: 'user', text: '在吗' }])

  const a = maybeWriteWere(dir, { now: NOW, gap: null })
  assert.equal(a.written, true)
  assert.equal(a.reason, 'first')

  const b = maybeWriteWere(dir, { now: NOW, gap: 1 })
  assert.equal(b.written, false, '同一天、刚说过话 → 不重写')

  const c = maybeWriteWere(dir, { now: NOW, gap: 9 })
  assert.equal(c.written, true)
  assert.equal(c.reason, 'back')

  const d = maybeWriteWere(dir, { now: new Date('2026-11-04T09:00:00Z'), gap: 1 })
  assert.equal(d.written, true)
  assert.equal(d.reason, 'new-day')
  assert.equal(wereIsToday(dir, new Date('2026-11-04T09:00:00Z')), true)
})

test('没有档案也能生成（空库不炸）', () => {
  const dir = fixture([])
  const text = renderWere(dir, { now: NOW })
  assert.match(text, /# 上次聊到哪儿/)
  assert.doesNotMatch(text, /他最后说/, '没有就不写，不编')
})

test('readWere：没有文件返回空串', () => {
  const dir = fixture([])
  assert.equal(readWere(dir), '')
  writeWere(dir, { now: NOW })
  assert.match(readWere(dir), /day: 2026-11-03/)
})
