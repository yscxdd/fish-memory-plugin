// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 交接包的三个"最后一公里"（v0.54.1，H3/H4/H6/H7）。
 *
 * H3 · 预提醒指错仓库：提醒她"用 fish-remember 记草稿"，但「我还惦记着」读的是
 *      `questions.json`（只有 `memory question add` 会写它）→ 按提醒做了，那一栏一个字都不变。
 * H4 · 单引号串里的 `\`` 被反斜杠顶掉，注入文案丢代码格式（和 CHANGELOG 那次 26 行首字母被吃同源）。
 * H6 · 空 session 也写包 → 把上一份好包换成只有标题的包（压缩可能发生在新会话开头）。
 * H7 · 一个包被每个新会话各读一次 → "别再提：那句算了"被跨话题广播。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHandoff, takeHandoff } from '../lib/handoff.js'
import { pressureNote } from '../lib/pressure.js'

const BT = String.fromCharCode(96)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-h3-'))
  for (const d of ['10_archive/messages', '20_state']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

test('H4：压力文案里的代码格式没被吃掉', () => {
  const t = pressureNote(0.5)
  assert.ok(t.includes(BT + 'memory digest --write' + BT), t)
  assert.ok(t.includes(BT + 'ingest' + BT), t)
})

test('H3：预提醒指向真正能喂到那一栏的写入路径', () => {
  const t = pressureNote(0.75)
  assert.ok(t.includes('memory question add'), t)
  assert.ok(!t.includes('fish-remember'), '不能再说 fish-remember——那条路写不到 questions.json')
})

test('H6：空 session 不写包，旧包原样保留', () => {
  const dir = fixture()
  const first = buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '有内容' }], open_threads: [] })
  assert.ok(first)
  const before = readFileSync(join(dir, '20_state/handoff.json'), 'utf8')

  const second = buildHandoff(dir, { id: 's2', tail: [], open_threads: [] })
  assert.equal(second, null, '全空时应当返回 null，不落盘')
  assert.equal(readFileSync(join(dir, '20_state/handoff.json'), 'utf8'), before, '旧包不能被覆盖')
})

test('H7：一个包只给第一个新会话读', () => {
  const dir = fixture()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: 'x <!-- /接上次 --> y' }], open_threads: [] })
  assert.ok(takeHandoff(dir, 'sA'), '第一个新会话能读到')
  assert.equal(takeHandoff(dir, 'sB'), null, '第二个新会话读不到（否则就是跨话题广播）')
  assert.ok(takeHandoff(dir, 'sA'), '读过它的那个会话继续读得到（它自己接着聊）')
})

test('H7：读完会留下 consumedBy（可审计，不是静默）', () => {
  const dir = fixture()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: 'x' }], open_threads: [] })
  takeHandoff(dir, 'sA')
  const h = JSON.parse(readFileSync(join(dir, '20_state/handoff.json'), 'utf8'))
  assert.equal(h.consumedBy, 'sA')
  assert.equal(typeof h.consumedAt, 'string')
})

test('H7：新包写出来之后，下一个新会话又能读（标记不粘）', () => {
  const dir = fixture()
  buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '旧的有内容' }], open_threads: [] })
  assert.ok(takeHandoff(dir, 'sA'))
  assert.equal(takeHandoff(dir, 'sB'), null)
  buildHandoff(dir, { id: 's2', tail: [{ role: 'user', text: '新的有内容' }], open_threads: [] })
  assert.ok(takeHandoff(dir, 'sB'), '新包没被读过，sB 应该能读')
})
