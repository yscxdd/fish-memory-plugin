// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 保真度两格（v0.56.0，N1）。
 *
 * 这个文件**故意把基线数字钉住**：矛盾 3/5、换窗 4/4。
 * 以后要是变好，测试会红——那不是坏事，是逼人**有意识地**更新基线
 * （否则基线会像"20/20"那样，悄悄失去分辨率）。
 *
 * 同时钉住两条容易量错的：
 *   ① 矛盾那一格必须复刻生产过滤（失效点不进注入），否则量的是"尺子错"；
 *   ② 换窗那一格的关键不是"有没有写包"，是"关键内容还在不在"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contradictionScore, handoffRetention, runFidelity } from '../lib/fidelity.js'

test('矛盾消解：失效的旧版本绝不进注入', () => {
  const r = contradictionScore()
  for (const row of r.rows) {
    assert.ok(!row.ids.includes('M-2026-10-26-001'), `旧点不该在候选里：${row.query} → ${row.ids.join(',')}`)
  }
})

test('矛盾消解：两个都有效时，冲突必须摊开', () => {
  const r = contradictionScore()
  const bothValid = r.rows.filter((x) => x.case === '两个版本都还有效')
  assert.equal(bothValid.length, 2)
  for (const row of bothValid) assert.ok(row.ok, `${row.query}：${row.note}`)
})

test('矛盾消解基线：3/5（60%）——空召回的那两条是"同义"缺口的证据', () => {
  const r = contradictionScore()
  assert.equal(r.total, 5)
  assert.equal(r.hit, 3, `当前基线变了：${r.rows.map((x) => `${x.query}=${x.ok ? '✓' : '✗'}`).join(' | ')}`)
  // 空的那两条：失效点被滤掉后，新版本的说法里没有旧话题词 → 门控直接跳过
  const empty = r.rows.filter((x) => x.top === null).map((x) => x.query)
  assert.deepEqual(empty.sort(), ['我们约的哪天见面', '见面改时间了吗'].sort(), '空召回的应该是这两条')
})

test('换窗保留：四条全过', () => {
  const r = handoffRetention()
  assert.equal(r.total, 4)
  assert.equal(r.hit, 4, r.rows.map((x) => `${x.ok ? '✓' : '✗'} ${x.name}`).join(' | '))
})

test('换窗保留：密钥绝不进注入（这条是安全，不是体验）', () => {
  const r = handoffRetention()
  const row = r.rows.find((x) => x.name.includes('密钥'))
  assert.ok(row?.ok, '密钥外泄直接算 0')
})

test('runFidelity：两格合起来还没满（基线），所以 ok=false', () => {
  const r = runFidelity()
  assert.equal(r.ok, false, '基线未满时 ok 必须是 false——别给自己发绿灯')
  assert.equal(r.contradiction.hit, 3)
  assert.equal(r.handoff.hit, 4)
})
