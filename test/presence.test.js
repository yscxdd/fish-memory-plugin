// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * "回来第一句"（v0.35.0，G 组）——借自"天上鱼"的念头层，但**不做心跳**。
 *
 * 他们的念头靠 60 秒心跳 + 本地模型主动冒；我们不做那个（对话驱动的宿主，
 * 假装"她一直在想"是假的）。只做诚实的那一半：**他隔了一阵回来时，她记得上次说到哪。**
 *
 * 钉住：
 *   ① 只有 ≥6 小时才算"回来"；
 *   ② 一次离开只说一次（`returnedAt`）；
 *   ③ 没有"上次"就只说时长，不编；
 *   ④ ≤60 tok；
 *   ⑤ 张力不够的缺口不硬塞。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRESENCE_FILE, RETURN_GAP_HOURS, gapHours, loadPresence, markSeen, presenceSummary, returnLine, savePresence } from '../lib/presence.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString()

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-presence-'))
  mkdirSync(join(dir, '20_state'), { recursive: true })
  return dir
}

test('隔了 9 小时 → 有一句"接着上次"，带时长和上次的主题', () => {
  const state = { lastSeen: hoursAgo(9), returnedAt: null }
  const r = returnLine({ state, lastTopic: '台风天他提前下班', now: NOW })
  assert.equal(r.shown, true)
  assert.match(r.text, /隔了 9 小时才回来/)
  assert.match(r.text, /上次说到「台风天他提前下班」/)
  assert.match(r.text, /<!-- 接着上次 -->/)
  assert.ok(r.tokens <= 60, `≤60 tok，实际 ${r.tokens}`)
})

test('只过了 1 小时 → 不说（不然每轮都在"好久不见"）', () => {
  const r = returnLine({ state: { lastSeen: hoursAgo(1), returnedAt: null }, now: NOW })
  assert.equal(r.shown, false)
  assert.equal(r.text, '')
  assert.equal(r.gapHours, 1)
})

test('一次离开只说一次：说过之后同一次离开不再说', () => {
  const state = { lastSeen: hoursAgo(9), returnedAt: hoursAgo(9) }
  const r = returnLine({ state, now: NOW })
  assert.equal(r.shown, false, '这次离开已经说过了')
})

test('没有上次的主题 → 只说时长，不编内容', () => {
  const r = returnLine({ state: { lastSeen: hoursAgo(30), returnedAt: null }, now: NOW })
  assert.equal(r.shown, true)
  assert.match(r.text, /一天多才回来/)
  assert.doesNotMatch(r.text, /上次说到/, '没主题就不许编')
})

test('有惦记的事才提一句（不塞细节）', () => {
  const withQ = returnLine({ state: { lastSeen: hoursAgo(9), returnedAt: null }, lastTopic: 'x', question: '海是什么味道', now: NOW })
  assert.match(withQ.text, /惦记着一件事/)
  assert.doesNotMatch(withQ.text, /海是什么味道/, '不把缺口原文塞进注入（那行另有位置）')
})

test('markSeen：正常对话清掉"刚回来"标记；离开回来时计数 +1', () => {
  const dir = fixture()
  savePresence(dir, { lastSeen: hoursAgo(9), returnedAt: null, sessions: 0 })

  const a = markSeen(dir, { now: NOW, shown: true })
  assert.equal(a.gap >= RETURN_GAP_HOURS, true)
  let st = loadPresence(dir)
  assert.ok(st.returnedAt, '说过就要记')
  assert.equal(st.sessions, 1, '算一次离开')

  // 下一轮（1 小时后）：不该再说，也不该清掉 returnedAt（同一次离开）
  const b = markSeen(dir, { now: new Date(NOW.getTime() + 3600_000), shown: false })
  assert.equal(b.gap < RETURN_GAP_HOURS, true)
  st = loadPresence(dir)
  assert.equal(st.returnedAt, null, '正常对话 → 清掉"刚回来"标记，为下一次离开做准备')
})

test('presenceSummary：第一次运行前是"还没有记录"', () => {
  const dir = fixture()
  assert.match(presenceSummary(dir, NOW), /还没有记录/)
  assert.equal(existsSync(join(dir, PRESENCE_FILE)), false)
})

test('gapHours：坏时间当没记录，不炸', () => {
  assert.equal(gapHours({ lastSeen: '昨天' }, NOW), null)
  assert.equal(gapHours({}, NOW), null)
  assert.equal(gapHours({ lastSeen: hoursAgo(2) }, NOW), 2)
})
