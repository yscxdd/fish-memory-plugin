// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 别名救不救得回来（v0.50.1）——把"看起来有用"变成"难题组上的一个数字"。
 *
 * 两条路都要测：
 *   ① **离线**：难题组里给 H1 加 `关节`，看它从 `✗ 空` 变成 `✓ H1`（7/10 → 8/10）；
 *   ② **端到端**：真库里的点文件写进 `aliases:`（走 `acceptAlias`，和 CLI 同一个函数），
 *      再 `readPointFiles` + `rankHybrid` 检索——证明"写进去"和"用得上"是一条链。
 *
 * 同时记录一个诚实的负结果：**别名能把"空"救进候选，但不保证到 top-1**
 * （H2 加了 `检查结果` 也只是 near，因为 T2 那条"又跑了一趟医院"更近）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acceptAlias } from '../lib/alias.js'
import { rankHybrid } from '../lib/retrieve.js'
import { readPointFiles } from '../lib/toolkit.js'
import { runHard } from '../scripts/gold-hard.mjs'

const NOW = new Date(2026, 10, 5, 12)

test('基线：关节不舒服 → 空（这是缺口本身）', () => {
  const r = runHard({ now: NOW })
  const h1 = r.rows.find((x) => x.query === '关节不舒服')
  assert.equal(h1.got, null)
  assert.equal(h1.verdict, 'miss')
  assert.equal(r.hit, 7)
})

test('加上别名 `关节`：同一条题从 miss 变 hit（7/10 → 8/10）', () => {
  const r = runHard({ now: NOW, aliases: { H1: ['关节'] } })
  const h1 = r.rows.find((x) => x.query === '关节不舒服')
  assert.equal(h1.verdict, 'hit')
  assert.equal(h1.got, 'H1')
  assert.equal(r.hit, 8)
})

test('负结果：别名救得进候选，不保证 top-1（H2 加了也只是 near）', () => {
  const r = runHard({ now: NOW, aliases: { H2: ['检查结果'] } })
  const h2 = r.rows.find((x) => x.query === '医院的检查结果')
  assert.equal(h2.verdict, 'near', '进了前 3，但 top-1 还是更近的那条')
  assert.notEqual(h2.got, 'H2')
})

test('端到端：acceptAlias 写进点文件 → readPointFiles 读得出 → 检索用得上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-alias-e2e-'))
  for (const d of ['10_archive/messages', '20_state', '30_points', '50_log']) mkdirSync(join(dir, d), { recursive: true })

  const pointFile = join(dir, '30_points', 'H1.md')
  writeFileSync(
    pointFile,
    [
      '---',
      'id: H1',
      'title: 他膝盖疼得下不了楼',
      'quote: null',
      'date: 2026-10-16',
      'salience: 3',
      'type: event',
      'cluster: 健康',
      'status: active',
      'source: []',
      'links: []',
      '---',
      '',
      '<!-- SUM -->',
      '这几天膝盖不好，走楼梯都费劲',
      '<!-- /SUM -->',
    ].join('\n'),
    'utf8',
  )

  const before = readPointFiles(dir, '30_points')
  assert.equal(rankHybrid(before, '关节不舒服', { threshold: 0.3, limit: 3 }).length, 0, '没别名时是空召回')

  const acc = acceptAlias(dir, 'H1', '关节')
  assert.equal(acc.ok, true)
  assert.equal(acc.added, true)
  assert.match(readFileSync(pointFile, 'utf8'), /aliases:/)

  const after = readPointFiles(dir, '30_points')
  assert.deepEqual(after[0].aliases, ['关节'])
  const ranked = rankHybrid(after, '关节不舒服', { threshold: 0.3, limit: 3 })
  assert.equal(ranked[0]?.point.id, 'H1', '写进去之后就该搜得到')
})
