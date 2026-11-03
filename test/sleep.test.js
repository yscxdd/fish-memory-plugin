// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 最小睡眠 + 统一结算（v0.39.0）。
 *
 * 要修的 bug：凌晨 2 点生气到 tier 1，睡到早 9 点回来还是 tier 1——
 * 因为档位只在"有输入"时动，夜里没人说话。
 *
 * 钉住：
 *   ① 只有静默**重叠夜间窗口（00:00–06:00）≥4 小时**才算睡过；白天补觉不算；
 *   ② 睡醒：tier → 3；有 until 的特殊情绪清掉；until=0 的留 90 分钟尾巴（不当作没发生）；
 *   ③ valence/arousal 只留 35% 的偏离（再收 65%）；
 *   ④ 同一段夜只结算一次（幂等）；
 *   ⑤ 醒来那句 ≤20 tok。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addSpecial, emptyState, loadEmotion, saveEmotion, specialsLine } from '../lib/emotion.js'
import { savePresence } from '../lib/presence.js'
import {
  SLEEP_DRIFT_KEEP,
  SLEEP_MIN_HOURS,
  detectSleep,
  loadSleep,
  nightOverlapHours,
  settle,
  sleepLine,
} from '../lib/sleep.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-sleep-'))
  for (const d of ['00_core', '20_state', '30_points', '31_dormant', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const at = (y, mo, d, h) => new Date(y, mo - 1, d, h, 0, 0)

test('夜间重叠：只有落在 00:00–06:00 的那段才算', () => {
  assert.equal(nightOverlapHours(at(2026, 11, 3, 2), at(2026, 11, 3, 9)), 4)
  assert.equal(nightOverlapHours(at(2026, 11, 2, 23), at(2026, 11, 3, 7)), 6)
  assert.equal(nightOverlapHours(at(2026, 11, 3, 9), at(2026, 11, 3, 15)), 0)
  assert.equal(nightOverlapHours(at(2026, 11, 1, 23), at(2026, 11, 3, 8)), 12)
})

test('判定：夜里静默 ≥4h 算睡过；白天不算；太短不算', () => {
  const dir = fixture()
  savePresence(dir, { lastSeen: at(2026, 11, 3, 2).toISOString(), returnedAt: null, sessions: 0 })
  assert.equal(detectSleep(dir, { now: at(2026, 11, 3, 9) }).slept, true)
  assert.equal(detectSleep(dir, { now: at(2026, 11, 3, 5) }).slept, false, '只有 3 小时')

  const day = fixture()
  savePresence(day, { lastSeen: at(2026, 11, 3, 9).toISOString(), returnedAt: null, sessions: 0 })
  const r = detectSleep(day, { now: at(2026, 11, 3, 15) })
  assert.equal(r.slept, false)
  assert.equal(r.reason, 'not-night')
})

test('睡醒：tier 回 3；有 until 的清掉；until=0 的留 90 分钟尾巴', () => {
  const dir = fixture()
  const night = at(2026, 11, 3, 2)
  const st = { ...emptyState(), tier: 1, at: night.toISOString(), ai: { valence: -0.8, arousal: 0.8 } }
  addSpecial(st, { id: '委屈', minutes: 0, cause: '他说那话没看我' }, night)
  addSpecial(st, { id: '感动', minutes: 40 }, night)
  saveEmotion(dir, st)
  savePresence(dir, { lastSeen: night.toISOString(), returnedAt: null, sessions: 0 })

  const morning = at(2026, 11, 3, 9)
  const r = settle(dir, { now: morning })
  assert.equal(r.slept, true)
  assert.equal(r.hours >= SLEEP_MIN_HOURS, true)

  const after = loadEmotion(dir)
  assert.equal(after.tier, 3, '睡一觉不记仇')
  assert.equal(after.specials.length, 1, '停时的那个清掉，等对方开口的留下')
  assert.equal(after.specials[0].id, '委屈')
  const tailMin = Math.round((after.specials[0].until - morning.getTime()) / 60_000)
  assert.equal(tailMin, 90)
  assert.match(specialsLine(after), /委屈/)
})

test('偏离只留 35%（再收 65%），且不越过底色', () => {
  const dir = fixture()
  const night = at(2026, 11, 3, 2)
  saveEmotion(dir, { ...emptyState(), at: night.toISOString(), ai: { valence: -0.8, arousal: 0.9 } })
  savePresence(dir, { lastSeen: night.toISOString(), returnedAt: null, sessions: 0 })
  settle(dir, { now: at(2026, 11, 3, 9) })
  const after = loadEmotion(dir)
  assert.ok(Math.abs(after.ai.valence - -0.8 * SLEEP_DRIFT_KEEP) < 0.02, `实际 ${after.ai.valence}`)
  assert.ok(after.ai.valence < 0, '不越过底色')
})

test('幂等：同一段夜只结算一次', () => {
  const dir = fixture()
  const night = at(2026, 11, 3, 2)
  savePresence(dir, { lastSeen: night.toISOString(), returnedAt: null, sessions: 0 })
  const morning = at(2026, 11, 3, 9)
  assert.equal(settle(dir, { now: morning }).slept, true)
  const second = settle(dir, { now: new Date(morning.getTime() + 60_000) })
  assert.equal(second.slept, false)
  assert.equal(second.reason, 'already')
  assert.equal(loadSleep(dir).nights, 1)
})

test('写了 sleep.log（几点睡、睡多久、结算了什么）', () => {
  const dir = fixture()
  const night = at(2026, 11, 3, 2)
  savePresence(dir, { lastSeen: night.toISOString(), returnedAt: null, sessions: 0 })
  settle(dir, { now: at(2026, 11, 3, 9) })
  const log = join(dir, '50_log', 'sleep.log')
  assert.equal(existsSync(log), true)
  const row = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop())
  assert.equal(row.slept >= SLEEP_MIN_HOURS, true)
  assert.match(row.tier, /->3$/)
  assert.equal(typeof row.specials.cleared, 'number')
})

test('醒来那句 ≤20 tok，且没睡就没有', () => {
  const dir = fixture()
  const night = at(2026, 11, 3, 2)
  savePresence(dir, { lastSeen: night.toISOString(), returnedAt: null, sessions: 0 })
  const r = settle(dir, { now: at(2026, 11, 3, 9) })
  const line = sleepLine(r)
  assert.match(line.text, /刚睡醒/)
  assert.ok(line.tokens <= 20, `实际 ${line.tokens}`)
  assert.equal(sleepLine({ slept: false }).text, '')
})
