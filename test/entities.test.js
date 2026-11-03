// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 实体表（v0.40.0，② 组）。
 *
 * 补的是"关于某个人的所有事"：以前"我妈"、"广州"只能靠词面碰运气。
 *
 * 三条规矩（都有测试）：
 *   ① 登记表**人写**（代码不从对话里抓名字——抓错比漏抓更糟）；
 *   ② 索引是**派生的**（`rebuild` 随时重来，删了不丢东西）；
 *   ③ 命中实体只**加候选**，不硬塞注入（还要过分数门槛）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addEntity,
  entityCandidates,
  entitiesIn,
  loadEntityIndex,
  loadEntityRegistry,
  rebuildEntityIndex,
  removeEntity,
} from '../lib/entities.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-entity-'))
  for (const d of ['20_state', '30_points']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

function point(dir, id, title, summary = '') {
  writeFileSync(
    join(dir, '30_points', `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\nquote: null\ndate: 2026-11-01\nsalience: 2\ntype: event\ncluster: 日常\nstatus: active\nsource: []\nlinks: []\n---\n\n<!-- SUM -->\n${summary || title}\n<!-- /SUM -->\n`,
    'utf8',
  )
}

test('登记：加一个实体，别名合并；重名不乱加', () => {
  const dir = fixture()
  const a = addEntity(dir, { name: '我妈', kind: 'person', aliases: ['妈妈'] })
  assert.equal(a.ok, true)
  assert.equal(a.merged, false)
  const b = addEntity(dir, { name: '我妈', aliases: ['母亲'] })
  assert.equal(b.merged, true)
  assert.deepEqual(loadEntityRegistry(dir).entities[0].aliases, ['妈妈', '母亲'])
  assert.equal(loadEntityRegistry(dir).entities.length, 1)
  assert.equal(addEntity(dir, { name: '  ' }).ok, false)
})

test('kind 不合法就退回 thing（不报错、不乱存）', () => {
  const dir = fixture()
  addEntity(dir, { name: '广州', kind: 'city' })
  assert.equal(loadEntityRegistry(dir).entities[0].kind, 'thing')
})

test('识别：名字或别名出现在话里就算提到', () => {
  const dir = fixture()
  addEntity(dir, { name: '我妈', kind: 'person', aliases: ['妈妈'] })
  addEntity(dir, { name: '广州', kind: 'place' })
  assert.deepEqual(entitiesIn(dir, '我妈今天去医院了').map((e) => e.name), ['我妈'])
  assert.deepEqual(entitiesIn(dir, '妈妈打电话来了').map((e) => e.name), ['我妈'])
  assert.deepEqual(entitiesIn(dir, '今天吃什么').map((e) => e.name), [])
})

test('索引：重建后能把实体的点全找出来', () => {
  const dir = fixture()
  addEntity(dir, { name: '我妈', kind: 'person', aliases: ['妈妈'] })
  point(dir, 'M-1', '妈妈打电话来', '说她腰疼')
  point(dir, 'M-2', '台风天他提前下班')
  const r = rebuildEntityIndex(dir)
  assert.equal(r.matched, 1)
  const idx = loadEntityIndex(dir)
  assert.deepEqual(idx['我妈'], ['M-1'])
})

test('检索：提到实体就把它的点并进来；没提到就是空', () => {
  const dir = fixture()
  addEntity(dir, { name: '我妈', aliases: ['妈妈'] })
  point(dir, 'M-1', '妈妈打电话来')
  const hit = entityCandidates(dir, '我妈最近怎么样')
  assert.deepEqual(hit.entities, ['我妈'])
  assert.deepEqual(hit.ids, ['M-1'])
  assert.deepEqual(entityCandidates(dir, '今天天气不错').ids, [])
})

test('索引不存在时会自动重建（不用先手动跑）', () => {
  const dir = fixture()
  addEntity(dir, { name: '广州', kind: 'place' })
  point(dir, 'M-2', '在广州吃了早茶')
  const r = entityCandidates(dir, '广州那家店')
  assert.deepEqual(r.ids, ['M-2'])
})

test('删实体：登记表里没了，索引重建后也不再命中', () => {
  const dir = fixture()
  addEntity(dir, { name: '老张' })
  point(dir, 'M-3', '老张来借伞')
  rebuildEntityIndex(dir)
  assert.equal(removeEntity(dir, '老张').ok, true)
  rebuildEntityIndex(dir)
  assert.deepEqual(entityCandidates(dir, '老张来了').ids, [])
})
