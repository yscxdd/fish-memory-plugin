// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 行为账本（v0.38.0，④ 组）——借自《MBTI 八维系统》的"只记数，绝不推分"。
 *
 * 三条纪律：
 *   ① 只记对方说的话（她自己说的不算）；
 *   ② 同类 3 分钟一次；
 *   ③ 只记数，绝不推分——**计数封顶 5**，防止一次长对话把某根顶满。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BEHAVIOR_COUNT_CAP,
  BEHAVIOR_FILE,
  BEHAVIOR_KEEP_DAYS,
  BEHAVIOR_THROTTLE_MIN,
  behaviorByDay,
  behaviorCounts,
  detectBehaviors,
  noteBehavior,
  pruneBehavior,
} from '../lib/behavior.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const plus = (min) => new Date(NOW.getTime() + min * 60_000)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-behavior-'))
  mkdirSync(join(dir, '50_log'), { recursive: true })
  return dir
}

test('六类行为能认出来', () => {
  assert.deepEqual(detectBehaviors('你为什么这么说'), ['被追问理由'])
  assert.deepEqual(detectBehaviors('说重点，给个结论'), ['被催结论'])
  assert.deepEqual(detectBehaviors('你刚才明明说是这样'), ['抓住矛盾'])
  assert.deepEqual(detectBehaviors('上次不是说好了吗'), ['翻旧账'])
  assert.deepEqual(detectBehaviors('就像那天一样'), ['打了比方'])
  assert.deepEqual(detectBehaviors('别难过，我在听'), ['哄人'])
})

test('普通聊天不记账（别把什么都记成行为）', () => {
  assert.deepEqual(detectBehaviors('今天天气不错'), [])
  assert.deepEqual(detectBehaviors(''), [])
})

test('记一笔：只记数，不推分', () => {
  const dir = fixture()
  const r = noteBehavior(dir, '你为什么这么说', { now: NOW })
  assert.deepEqual(r.recorded, ['被追问理由'])
  const text = readFileSync(join(dir, BEHAVIOR_FILE), 'utf8')
  const row = JSON.parse(text.trim().split('\n')[0])
  assert.equal(row.kind, '被追问理由')
  assert.equal(typeof row.at, 'number')
  assert.equal(Object.keys(row).length, 2, '只有 at + kind，没有任何分数')
})

test('同类 3 分钟内不重复计', () => {
  const dir = fixture()
  noteBehavior(dir, '为什么', { now: NOW })
  const r = noteBehavior(dir, '为什么啊', { now: plus(1) })
  assert.deepEqual(r.recorded, [])
  assert.deepEqual(r.skipped, ['被追问理由'])
  const r2 = noteBehavior(dir, '为什么嘛', { now: plus(BEHAVIOR_THROTTLE_MIN + 1) })
  assert.deepEqual(r2.recorded, ['被追问理由'])
})

test('读计数：封顶 5（一次长对话不能把某根顶满）', () => {
  const dir = fixture()
  for (let i = 0; i < 8; i++) noteBehavior(dir, '为什么', { now: plus(i * 5) })
  const r = behaviorCounts(dir, { days: 1, now: plus(60) })
  assert.equal(r.raw['被追问理由'], 8)
  assert.equal(r.counts['被追问理由'], BEHAVIOR_COUNT_CAP)
})

test('窗口：7 天外的账不算', () => {
  const dir = fixture()
  noteBehavior(dir, '为什么', { now: NOW })
  const later = new Date(NOW.getTime() + 8 * 86_400_000)
  assert.equal(behaviorCounts(dir, { days: 7, now: later }).total, 0)
  assert.equal(behaviorCounts(dir, { days: 30, now: later }).raw['被追问理由'], 1)
})

test('修剪：14 天前的行会被清掉', () => {
  const dir = fixture()
  noteBehavior(dir, '为什么', { now: NOW })
  noteBehavior(dir, '上次不是说好了吗', { now: plus(1) })
  const r = pruneBehavior(dir, new Date(NOW.getTime() + (BEHAVIOR_KEEP_DAYS + 1) * 86_400_000))
  assert.equal(r.before, 2)
  assert.equal(r.after, 0)
})

test('按天分组（给 CLI 看趋势）', () => {
  const dir = fixture()
  noteBehavior(dir, '为什么', { now: NOW })
  noteBehavior(dir, '哄人一句', { now: NOW })
  const days = behaviorByDay(dir, { days: 7, now: NOW })
  assert.equal(days.length, 1)
  assert.equal(Object.keys(days[0][1]).length >= 1, true)
})
