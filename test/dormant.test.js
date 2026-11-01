// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 遗忘层 + 复活（v0.29，A+B）。
 *
 * 四档阶梯：active → demoted → **dormant（进 31_dormant/）** → purged（C 组，暂未做）。
 * 这里钉住：
 *   ① 第一轮真的把文件**移走**（不是只改 status），且留 dormant_at；
 *   ② 最近 30 天被注入过的、pin: hard、boundary/promise、复活已满 3 次——都不进层；
 *   ③ 复活：移回主层 + S×1.6 + resurrections+1 + 记 revival.log；
 *   ④ 每复活一次，下次进层的年龄门槛 +15 天（越常被想起越难忘）；
 *   ⑤ 旧 status=dormant 的点能被一次性迁移进层；
 *   ⑥ pack 会带上遗忘层（换机器不丢）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DORMANT_DAYS, RESURRECT_BOOST, RESURRECT_GRACE_DAYS, migrateLegacyDormant, planForget, applyForget, revivePoint, wasInjectedRecently } from '../lib/forget.js'
import { readPointFiles } from '../lib/toolkit.js'

const NOW = new Date('2026-11-01T00:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

function point(id, { salience = 2, date, status = 'active', pinned = false, type = 'event', extra = '' } = {}) {
  return `---
id: ${id}
title: ${id}
quote: null
date: ${date}
salience: ${salience}
type: ${type}
cluster: 测试
event: null
tags: []
status: ${status}
source: []
links: []
${pinned ? 'pinned: true' : ''}
${extra}
---

<!-- SUM -->
${id}
<!-- /SUM -->
`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-dormant-'))
  for (const d of ['00_core', '20_state', '20_index', '30_points', '31_dormant', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

test('第一轮：移进 31_dormant（不是只改 status），且留 dormant_at', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-06-01-001', { date: daysAgo(150) }), 'utf8')

  const { plan } = planForget(dir, { now: NOW })
  assert.equal(plan.find((x) => x.id === 'M-2026-06-01-001').action, 'dormant')

  applyForget(dir, { now: NOW })
  assert.equal(readPointFiles(dir, '30_points').length, 0, '主层要清空')
  const layer = readPointFiles(dir, '31_dormant')
  assert.equal(layer.length, 1)
  assert.equal(layer[0].status, 'dormant')
  assert.match(layer[0].raw, /^dormant_at:/m)
  assert.match(layer[0].raw, /^dormant_reason:/m)
})

test('不进层的四类：最近注入过 / pin hard / boundary / 复活满 3 次', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-06-01-001', { date: daysAgo(150) }), 'utf8')
  writeFileSync(join(dir, '30_points/B.md'), point('M-2026-06-01-002', { date: daysAgo(150), extra: 'pin: hard' }), 'utf8')
  writeFileSync(join(dir, '30_points/C.md'), point('M-2026-06-01-003', { date: daysAgo(150), type: 'boundary' }), 'utf8')
  writeFileSync(join(dir, '30_points/D.md'), point('M-2026-06-01-004', { date: daysAgo(400), extra: 'resurrections: 3' }), 'utf8')

  // A 最近被注入过（今天）
  const today = Math.floor(NOW.getTime() / 86_400_000)
  writeFileSync(join(dir, '20_state/inj10.json'), JSON.stringify({ tick: today, inj: { [today]: ['M-2026-06-01-001'] } }), 'utf8')
  assert.equal(wasInjectedRecently(dir, 'M-2026-06-01-001', NOW), true)

  const { plan } = planForget(dir, { now: NOW })
  const by = Object.fromEntries(plan.map((x) => [x.id, x.action]))
  assert.equal(by['M-2026-06-01-001'], 'keep', '最近注入过的不该进层')
  assert.equal(by['M-2026-06-01-002'], undefined, 'pin hard 不参与')
  assert.equal(by['M-2026-06-01-003'], undefined, 'boundary 不参与')
  assert.equal(by['M-2026-06-01-004'], 'keep', '复活满 3 次不再进层')
})

test('复活：移回主层、S×1.6、resurrections+1、写 revival.log', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/A.md'), point('M-2026-06-01-001', { date: daysAgo(200), status: 'dormant' }), 'utf8')

  const r = revivePoint(dir, 'M-2026-06-01-001', { now: NOW, score: 0.91 })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.revivals, 1)

  const live = readPointFiles(dir, '30_points')
  assert.equal(live.length, 1, '要回到主层')
  assert.equal(live[0].status, 'active')
  assert.match(live[0].raw, /^resurrections: 1$/m)
  assert.equal(readPointFiles(dir, '31_dormant').length, 0, '层里不该还有')

  const state = JSON.parse(readFileSync(join(dir, '20_state/state.json'), 'utf8'))
  const S0 = 7 // salience 2 的初始稳定度
  assert.ok(Math.abs(state['M-2026-06-01-001'].S - S0 * RESURRECT_BOOST) < 0.01, `S 应被乘 ${RESURRECT_BOOST}`)

  const log = readFileSync(join(dir, '50_log/revival.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log.length, 1)
  assert.equal(log[0].point, 'M-2026-06-01-001')
  assert.equal(log[0].revivals, 1)
})

test('复活 3 次 → 自动 pin: soft（永不再进层）', () => {
  const dir = fixture()
  writeFileSync(join(dir, '31_dormant/A.md'), point('M-2026-06-01-001', { date: daysAgo(200), status: 'dormant', extra: 'resurrections: 2' }), 'utf8')

  const r = revivePoint(dir, 'M-2026-06-01-001', { now: NOW })
  assert.equal(r.permanent, true)
  const live = readPointFiles(dir, '30_points')[0]
  assert.match(live.raw, /^pin: soft$/m)
  assert.match(live.raw, /^resurrections: 3$/m)
})

test('每复活一次，下次进层的年龄门槛 +15 天', () => {
  const dir = fixture()
  // 复活过一次的点：40 天（> 30 天但要等 45 天才够）
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-09-22-001', { date: daysAgo(40), extra: 'resurrections: 1' }), 'utf8')
  const { plan } = planForget(dir, { now: NOW })
  const a = plan.find((x) => x.id === 'M-2026-09-22-001')
  assert.equal(a.action, 'keep', `复活过的门槛应是 ${DORMANT_DAYS + RESURRECT_GRACE_DAYS} 天`)

  // 同样 40 天，但没复活过 → 进层
  const dir2 = fixture()
  writeFileSync(join(dir2, '30_points/A.md'), point('M-2026-09-22-001', { date: daysAgo(40) }), 'utf8')
  const p2 = planForget(dir2, { now: NOW }).plan.find((x) => x.id === 'M-2026-09-22-001')
  assert.equal(p2.action, 'dormant')
})

test('迁移：30_points 里旧的 dormant 点被移进 31_dormant', () => {
  const dir = fixture()
  writeFileSync(join(dir, '30_points/A.md'), point('M-2026-06-01-001', { date: daysAgo(150), status: 'dormant' }), 'utf8')
  const r = migrateLegacyDormant(dir, { now: NOW })
  assert.equal(r.moved, 1)
  assert.equal(readPointFiles(dir, '30_points').length, 0)
  assert.equal(readPointFiles(dir, '31_dormant').length, 1)
  assert.match(readFileSync(join(dir, '31_dormant/A.md'), 'utf8'), /^dormant_at:/m)
})

test('pack 会带上遗忘层（换机器不丢）', async () => {
  const { PACK_INCLUDE } = await import('../lib/pack.js')
  assert.ok(PACK_INCLUDE.includes('31_dormant'), JSON.stringify(PACK_INCLUDE))
})

test('scaffold 会建 31_dormant 目录', async () => {
  const { initMemory } = await import('../lib/scaffold.js')
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-scaffold-'))
  const { dir: lib } = initMemory(join(dir, 'fish-memory'))
  assert.equal(existsSync(join(lib, '31_dormant')), true)
})
