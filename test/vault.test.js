// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * vault 视图（v0.12.0）：把库变成 Obsidian/LogSeq 能直接打开的 vault。
 *
 * 三条要钉住的：
 *   ① **只写 20_index/**——真相层（档案、记忆点）一个字节都不许动；
 *   ② 消息里的 `[[` 必须拆开，否则聊天里随手一个 `[[xx]]` 会在图谱里凭空长边；
 *   ③ `TEMPLATE.md` 不是记忆点（否则会以"1 个记忆点"出现在入口页和关系图里）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { neutralizeWikilinks, readPoints, renderDayNote, renderLinksNote, writeVault } from '../lib/vault.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

const msg = (id, ts, role, text) => ({ id, ts, role, text, source_kind: role === 'user' ? 'user' : 'model' })

function seed() {
  const dir = tmp('fishmem-vault-')
  mkdirSync(join(dir, '10_archive', 'messages'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '40_pending'), { recursive: true })
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  writeFileSync(join(dir, '00_core', 'soul.md'), '# SOUL\n', 'utf8')

  const day1 = '2026-10-29'
  const day2 = '2026-10-30'
  const rows = [
    msg('m1', `${day1}T10:00:00.000Z`, 'user', '第一条：今天聊了天气'),
    msg('m2', `${day1}T10:00:10.000Z`, 'assistant', '嗯，天气不错'),
    msg('m3', `${day2}T09:30:00.000Z`, 'user', '第二条：他说了 [[某个东西]] 和 [[另一个]]'),
  ]
  writeFileSync(
    join(dir, '10_archive', 'messages', `${day1}.jsonl`),
    rows.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '10_archive', 'messages', `${day2}.jsonl`),
    rows.slice(2).map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )

  writeFileSync(
    join(dir, '30_points', 'M-2026-10-30-001.md'),
    '---\nid: M-2026-10-30-001\ntitle: 台风天看海\nstatus: active\ncluster: 出行\nlinks: [M-2026-10-30-002]\ncontradicts: [M-2026-10-30-003]\n---\n\n<!-- SUM -->\n台风夜去海边。\n<!-- /SUM -->\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '30_points', 'M-2026-10-30-002.md'),
    '---\nid: M-2026-10-30-002\ntitle: 别夸她懂事\nstatus: active\n---\n\n<!-- SUM -->\n她说不要夸她懂事。\n<!-- /SUM -->\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '30_points', 'TEMPLATE.md'),
    '---\nid: M-YYYY-MM-DD-NNN\ntitle: 事件名\nstatus: active\n---\n',
    'utf8',
  )
  writeFileSync(join(dir, '20_index', 'clusters.md'), '# 索引\n\n| 簇 | 数量 |\n|---|---|\n| 出行 | 1 |\n| 她的偏好 | 1 |\n', 'utf8')
  return dir
}

test('日笔记：一天一篇，带时间与说话人，正文按引用块保留', () => {
  const dir = seed()
  const r = writeVault(dir, { now: new Date('2026-10-30T12:00:00Z') })
  assert.equal(r.days, 2)
  const names = readdirSync(join(dir, '20_index', 'views')).sort()
  assert.deepEqual(names, ['2026-10-29.md', '2026-10-30.md'])

  const d1 = readFileSync(join(dir, '20_index', 'views', '2026-10-29.md'), 'utf8')
  assert.match(d1, /## \d{2}:\d{2} 他/)
  assert.match(d1, /## \d{2}:\d{2} 她/)
  assert.match(d1, /> 第一条：今天聊了天气/)
  assert.match(d1, /原文镜像/)
})

test('图谱安全：消息里的 [[...]] 被拆开，不会凭空长出图谱边', () => {
  const dir = seed()
  writeVault(dir)
  const d2 = readFileSync(join(dir, '20_index', 'views', '2026-10-30.md'), 'utf8')
  assert.equal(/\[\[某个东西\]\]/.test(d2), false, '原样留着就是注入图谱')
  assert.ok(d2.includes('\u200B'), '应插入零宽空格')
  // 逐字内容不丢：去掉零宽空格后应与原文一致
  assert.ok(d2.replace(/\u200B/g, '').includes('[[某个东西]]'))
  assert.equal(neutralizeWikilinks('a [[b]] c'), 'a [\u200B[b]\u200B] c')
})

test('入口页：只算真记忆点，TEMPLATE 不算；含天数、条数、日笔记链接', () => {
  const dir = seed()
  writeVault(dir, { now: new Date('2026-10-30T12:00:00Z') })
  const index = readFileSync(join(dir, '20_index', 'index.md'), 'utf8')
  assert.match(index, /记忆点：\*\*2\*\*/, 'TEMPLATE 不该被算进去')
  assert.match(index, /档案：\*\*3\*\* 条，跨 2 天/)
  assert.match(index, /\[\[2026-10-29\]\]/)
  assert.match(index, /\[\[2026-10-30\]\]/)
  assert.match(index, /出行/)
})

test('入口页：怎么用那段不许再说"首页在库根"（它在 20_index/ 里）', () => {
  const dir = seed()
  writeVault(dir, { now: new Date('2026-10-30T12:00:00Z') })
  const index = readFileSync(join(dir, '20_index', 'index.md'), 'utf8')
  assert.match(index, /20_index\/index\.md/, '要写出真实路径')
  assert.doesNotMatch(index, /故意放在库根/, 'v0.13.1 前这里是错的：入口页从来没生成在库根')
  assert.doesNotMatch(index, /把本页设成首页；$/, '别只说"本页"，人得先找到它在哪')
})

test('关系页：links / contradicts / merged_into 都变成 wikilink', () => {
  const note = renderLinksNote([
    { id: 'A', links: ['B'], contradicts: ['C'], merged_into: null },
    { id: 'D', links: [], contradicts: [], merged_into: 'core:user.md' },
  ])
  assert.match(note, /\[\[A\]\] → \[\[B\]\]/)
  assert.match(note, /\[\[A\]\] ↔ \[\[C\]\]（冲突）/)
  assert.match(note, /\[\[D\]\] → core:user\.md（已升级进核心层）/)
})

test('只写 20_index：档案与记忆点一个字节都不动', () => {
  const dir = seed()
  const before = {}
  for (const rel of ['10_archive/messages/2026-10-29.jsonl', '10_archive/messages/2026-10-30.jsonl', '30_points/M-2026-10-30-001.md']) {
    before[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  writeVault(dir)
  for (const [rel, text] of Object.entries(before)) {
    assert.equal(readFileSync(join(dir, rel), 'utf8'), text, `${rel} 被改了`)
  }
})

test('幂等：跑两次内容一样', () => {
  const dir = seed()
  writeVault(dir, { now: new Date('2026-10-30T12:00:00Z') })
  const a = readFileSync(join(dir, '20_index', 'views', '2026-10-29.md'), 'utf8')
  const ai = readFileSync(join(dir, '20_index', 'index.md'), 'utf8')
  writeVault(dir, { now: new Date('2026-10-30T12:00:00Z') })
  assert.equal(readFileSync(join(dir, '20_index', 'views', '2026-10-29.md'), 'utf8'), a)
  assert.equal(readFileSync(join(dir, '20_index', 'index.md'), 'utf8'), ai)
})

test('--days 只生成最近 N 天', () => {
  const dir = seed()
  const r = writeVault(dir, { days: 1 })
  assert.equal(r.days, 1)
  assert.deepEqual(readdirSync(join(dir, '20_index', 'views')).sort(), ['2026-10-30.md'])
})

test('空库也能跑：入口页说"还没有记忆点"', () => {
  const dir = tmp('fishmem-vault-empty-')
  mkdirSync(join(dir, '20_index'), { recursive: true })
  const r = writeVault(dir)
  assert.equal(r.messages, 0)
  assert.equal(existsSync(join(dir, '20_index', 'index.md')), true)
  assert.match(readFileSync(join(dir, '20_index', 'links.md'), 'utf8'), /还没有记忆点/)
})

test('readPoints：TEMPLATE 与不合法的 id 都被排除', () => {
  const dir = seed()
  writeFileSync(join(dir, '40_pending', '乱写.md'), '---\nid: 随便\n---\n', 'utf8')
  const pts = readPoints(dir)
  assert.deepEqual(pts.map((p) => p.id).sort(), ['M-2026-10-30-001', 'M-2026-10-30-002'])
})

test('renderDayNote：正文里的多行逐行引用，不改错行', () => {
  const note = renderDayNote('2026-10-30', [msg('m', '2026-10-30T10:00:00.000Z', 'user', '第一行\n第二行')])
  assert.match(note, /> 第一行\n> 第二行/)
})
