// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 习惯权重（v0.36.0，C 组）——借自"天上鱼"的习惯层，但**只做能测的**。
 *
 * 他们的公式一字不改：命中 w += 0.06×(1−w)、违反 w −= 0.05×w、每天 ×0.98、单日最多 3 次。
 * 我们的裁剪：只保留三条能规则判断的（一句一条 / 结尾不用句号 / ≤40 字）；
 * "不重复问"、"不为留人编话" 判断不了，**不做**——宁缺毋滥。
 *
 * 钉住：
 *   ① 文本人写、代码只动 w（和 soul 文本 / origin 权重同一个模式）；
 *   ② 单日最多计 3 次（防一天狂刷把权重顶满）；
 *   ③ 跨天先衰减再计数；
 *   ④ 门限：≥0.75 硬性 · ≥0.5 平时 · <0.3 归档（不注入）；
 *   ⑤ 注入最多 4 条、≤60 tok。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DAILY_CAP,
  DAILY_DECAY,
  HIT_GAIN,
  INJECT_HARD,
  INJECT_NORMAL,
  MAX_INJECT,
  SEED_HABITS,
  VIOLATE_LOSS,
  addHabit,
  emptyHabits,
  habitsBlock,
  habitsSummary,
  inspectReply,
  loadHabits,
  recordReply,
  saveHabits,
} from '../lib/habits.js'

const NOW = new Date('2026-11-03T12:00:00Z')
const nextDay = new Date('2026-11-04T12:00:00Z')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-habits-'))
  mkdirSync(join(dir, '20_state'), { recursive: true })
  return dir
}

const get = (dir, id) => loadHabits(dir).items.find((x) => x.id === id)

test('体检：一句一条 / 结尾不用句号 / ≤40 字', () => {
  const a = inspectReply('才不呢')
  assert.equal(a.sentences, 1)
  assert.equal(a.endsWithPeriod, false)
  assert.equal(a.verdict['one-sentence'], true)
  assert.equal(a.verdict['no-period'], true)
  assert.equal(a.verdict.short, true)

  const b = inspectReply('好的。我先看看。然后再告诉你。')
  assert.equal(b.sentences, 3)
  assert.equal(b.verdict['one-sentence'], false)
  assert.equal(b.endsWithPeriod, true)
  assert.equal(b.verdict['no-period'], false)

  const long = inspectReply('这'.repeat(60))
  assert.equal(long.verdict.short, false)
})

test('命中一次：w += 0.06×(1−w)', () => {
  const dir = fixture()
  saveHabits(dir, emptyHabits())
  const before = get(dir, 'no-period').w
  recordReply(dir, '才不呢', { now: NOW })
  const after = get(dir, 'no-period').w
  assert.ok(Math.abs(after - (before + HIT_GAIN * (1 - before))) < 0.002, `${before}→${after}`)
})

test('违反一次：w −= 0.05×w', () => {
  const dir = fixture()
  saveHabits(dir, emptyHabits())
  const before = get(dir, 'no-period').w
  recordReply(dir, '好的，我记下了。', { now: NOW })
  const after = get(dir, 'no-period').w
  assert.ok(Math.abs(after - (before - VIOLATE_LOSS * before)) < 0.002, `${before}→${after}`)
})

test('单日上限 3 次：第四、五条不再计入', () => {
  const dir = fixture()
  saveHabits(dir, emptyHabits())
  for (let i = 0; i < 5; i++) recordReply(dir, '才不呢', { now: NOW })
  assert.equal(get(dir, 'no-period').dayCount, DAILY_CAP)
  assert.equal(get(dir, 'no-period').hits, DAILY_CAP)
})

test('跨天：先衰减再计数', () => {
  const dir = fixture()
  saveHabits(dir, emptyHabits())
  recordReply(dir, '才不呢', { now: NOW })
  const w1 = get(dir, 'no-period').w
  recordReply(dir, '才不呢', { now: nextDay })
  const w2 = get(dir, 'no-period').w
  const expected = w1 * DAILY_DECAY
  assert.ok(w2 > expected - 0.01, `衰减后应约 ${expected.toFixed(3)}，实际 ${w2}`)
  assert.equal(get(dir, 'no-period').dayCount, 1, '新的一天重新计数')
})

test('不可检测的习惯：权重永远不动（宁缺毋滥）', () => {
  const dir = fixture()
  const st = emptyHabits()
  st.items.push({ id: 'never-repeat', text: '不重复问已经问过的问题', w: 0.5, hits: 0, violations: 0, lastHit: null, lastViolation: null, day: null, dayCount: 0 })
  saveHabits(dir, st)
  recordReply(dir, '才不呢', { now: NOW })
  assert.equal(get(dir, 'never-repeat').w, 0.5)
  assert.equal(get(dir, 'never-repeat').dayCount, 0)
})

test('注入门限：w 够重才出现，最多 4 条，≤60 tok', () => {
  const dir = fixture()
  const st = emptyHabits()
  st.items[0].w = 0.8 // 硬性
  st.items[1].w = 0.55 // 平时
  st.items[2].w = 0.2 // 归档 → 不出现
  saveHabits(dir, st)
  const r = habitsBlock(dir)
  assert.ok(r.text.includes('一句一条'))
  assert.ok(r.text.includes('结尾不用句号'))
  assert.equal(r.text.includes('40 字'), false, '<0.3 的不该出现')
  assert.ok(r.tokens <= 60)
  assert.ok(r.picked.length <= MAX_INJECT)

  const empty = fixture()
  saveHabits(empty, emptyHabits())
  assert.equal(habitsBlock(empty).text, '', '全是 0.5 以下时不该硬塞')
})

test('addHabit：文本人写、去重、太长拒绝', () => {
  const dir = fixture()
  saveHabits(dir, emptyHabits())
  assert.equal(addHabit(dir, '不主动说教').ok, true)
  assert.equal(addHabit(dir, '不主动说教').ok, false, '重复要拒')
  assert.equal(addHabit(dir, '好'.repeat(40)).ok, false, '太长要拒')
  assert.equal(loadHabits(dir).items.length, SEED_HABITS.length + 1)
})

test('summary：按权重排序并标出门限', () => {
  const dir = fixture()
  const st = emptyHabits()
  st.items[0].w = 0.9
  saveHabits(dir, st)
  const s = habitsSummary(dir)
  assert.equal(s[0].id, 'one-sentence')
  assert.equal(s[0].level, '硬性')
  assert.ok(s.some((x) => x.level === '平时' || x.level === '偏低'))
})

test('坏文件/空文件：退回种子，不炸', () => {
  const dir = fixture()
  assert.equal(loadHabits(dir).items.length, SEED_HABITS.length)
  saveHabits(dir, { items: [] })
  assert.equal(loadHabits(dir).items.length, SEED_HABITS.length)
  assert.equal(INJECT_HARD > INJECT_NORMAL, true)
})
