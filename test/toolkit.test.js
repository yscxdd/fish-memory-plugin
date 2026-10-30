// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 离线工具测试：校验 / 索引 / 审计 / 切段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  audit,
  buildIndex,
  diffIndex,
  idxLine,
  ingestPending,
  listFixtures,
  readArchive,
  readPointFiles,
  renderDigest,
  resetFixtures,
  splitSegments,
  validatePoint,
  writeIndex,
} from '../lib/toolkit.js'

const SOUL = `# SOUL

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议
`

const POINT_A = `---
id: M-2026-10-28-001
title: 他讨厌香菜
quote: 我讨厌香菜
quote_by: him
date: 2026-10-28
salience: 3
type: preference
cluster: 偏好
event: null
tags: [香菜, 忌口]
status: active
source: [m-user-1]
links: []
---

<!-- SUM -->
他说他讨厌香菜，以后点菜得避开。
<!-- /SUM -->

## 发生了什么

[事实] 他说他讨厌香菜。
`

const POINT_B = `---
id: M-2026-10-28-002
title: 别夸她懂事
quote: 你别总说我懂事
quote_by: her
date: 2026-10-28
salience: 5
type: boundary
cluster: 她的偏好
event: null
tags: [底线]
status: active
source: [m-her-1]
links: []
---

<!-- SUM -->
她说别夸她懂事。
<!-- /SUM -->

## 发生了什么

[事实] 她说别这么讲。
`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tool-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), SOUL)
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const rec = (id, role, text, ts) => ({
    id,
    msgid_plat: `plat-${id}`,
    seq: 1,
    ts,
    role,
    source_kind: role === 'user' ? 'user' : 'model',
    text,
    session: 's1',
  })
  const lines = [
    rec('m-user-1', 'user', '我讨厌香菜', '2026-10-28T10:00:00.000Z'),
    rec('m-her-1', 'assistant', '知道了，你别总说我懂事', '2026-10-28T10:01:00.000Z'),
  ]
  writeFileSync(join(dir, '10_archive/messages/2026-10-28.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points/M-001.md'), POINT_A)
  writeFileSync(join(dir, '30_points/M-002.md'), POINT_B)
  mkdirSync(join(dir, '40_pending'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  return dir
}

test('readArchive：记录 id 与平台 msgid 都能查到', () => {
  const { messages, byId } = readArchive(fixture())
  assert.equal(messages.length, 2)
  assert.equal(byId.get('m-user-1').text, '我讨厌香菜')
  assert.equal(byId.get('plat-m-user-1').id, 'm-user-1')
})

test('validatePoint：合规点通过；缺来源、原话不符、SUM 超长都报错', () => {
  const dir = fixture()
  const archive = readArchive(dir)
  const [a] = readPointFiles(dir)
  const good = validatePoint(a, { archive })
  assert.deepEqual(good.errors, [])

  const noSource = validatePoint({ ...a, source: [] }, { archive })
  assert.ok(noSource.errors.some((e) => e.field === 'source'))

  const badQuote = validatePoint({ ...a, quote: '他讨厌芹菜' }, { archive })
  assert.ok(badQuote.errors.some((e) => e.field === 'quote'))

  const longSum = validatePoint({ ...a, summary: '很'.repeat(56) }, { archive })
  assert.ok(longSum.errors.some((e) => e.field === 'summary'))

  const badId = validatePoint({ ...a, id: 'M-1' }, { archive })
  assert.ok(badId.errors.some((e) => e.field === 'id'))
})

test('validatePoint：样例来源默认只是警告，严格模式才算错', () => {
  const p = {
    id: 'M-2026-10-28-009',
    title: '样例',
    date: '2026-10-28',
    salience: 2,
    type: 'event',
    cluster: '日常',
    status: 'active',
    summary: '摘要',
    quote: '',
    quote_by: null,
    source: ['msg-sample-1'],
    links: [],
    event: null,
  }
  assert.equal(validatePoint(p, { archive: { byId: new Map() } }).errors.length, 0)
  assert.ok(validatePoint(p, { archive: { byId: new Map() }, allowSample: false }).errors.length > 0)
})

test('buildIndex：可重放、近期按 salience 截断、suppressed 不进索引', () => {
  const points = [
    { ...readPointFiles(fixture())[0] },
    { ...readPointFiles(fixture())[1] },
    {
      id: 'M-2026-10-28-003',
      title: '被压掉的',
      date: '2026-10-28',
      salience: 4,
      type: 'event',
      cluster: '日常',
      tags: [],
      status: 'suppressed',
      summary: 'x',
    },
  ]
  const now = new Date('2026-10-29T00:00:00Z')
  const a = buildIndex(points, { now })
  const b = buildIndex(points, { now })
  assert.deepEqual(a, b)
  assert.equal(a['all.idx.jsonl'].trim().split('\n').length, 2)
  assert.doesNotMatch(a['all.idx.jsonl'], /被压掉的/)
  assert.match(a['clusters.md'], /\| 偏好 \| - \| 1 \| 2026-10-28 \|/)
  assert.equal(a['recent.idx.jsonl'].split('\n')[0], idxLine(points[1]))
})

test('index：写完 --check 一致，删掉一行就报差异', () => {
  const dir = fixture()
  const points = readPointFiles(dir)
  const built = buildIndex(points, { now: new Date('2026-10-29T00:00:00Z') })
  assert.deepEqual(diffIndex(dir, built).length, 4)
  writeIndex(dir, built)
  assert.deepEqual(diffIndex(dir, built), [])

  writeFileSync(join(dir, '20_index/all.sum.jsonl'), 'junk\n')
  assert.deepEqual(diffIndex(dir, built), ['all.sum.jsonl'])
})

test('audit：干净库通过；删掉金丝雀锚点就失败', () => {
  const dir = fixture()
  const built = buildIndex(readPointFiles(dir), { now: new Date('2026-10-29T00:00:00Z') })
  writeIndex(dir, built)
  const ok = audit(dir, { now: new Date('2026-10-29T00:00:00Z') })
  assert.equal(ok.passed, true, JSON.stringify(ok.checks.filter((c) => !c.ok)))
  assert.equal(ok.checks.find((c) => c.id === 'canary').anchors_recognized, 3)
  assert.equal(ok.checks.find((c) => c.id === 'fixtures').count, 0)
  assert.equal(ok.checks.find((c) => c.id === 'soul_guard').changes_7d, 0)

  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n没有锚点。\n')
  const bad = audit(dir, { now: new Date('2026-10-29T00:00:00Z') })
  assert.equal(bad.passed, false)
  assert.equal(bad.checks.find((c) => c.id === 'canary').ok, false)
})

test('audit：7 天内核心层改 3 次 = soul_guard 不过', () => {
  const dir = fixture()
  writeIndex(dir, buildIndex(readPointFiles(dir), { now: new Date('2026-10-29T00:00:00Z') }))
  writeFileSync(
    join(dir, '00_core/core_changelog.md'),
    ['2026-10-28 | user.md | v002 | 1', '2026-10-28 | user.md | v003 | 2', '2026-10-28 | user.md | v004 | 3', ''].join('\n'),
  )
  const r = audit(dir, { now: new Date('2026-10-29T00:00:00Z') })
  assert.equal(r.checks.find((c) => c.id === 'soul_guard').changes_7d, 3)
  assert.equal(r.passed, false)
})

test('fixtures：只删标了 fixture 的点和压缩包，archive 不动', () => {
  const dir = fixture()
  const a = readFileSync(join(dir, '30_points/M-001.md'), 'utf8').replace('status: active', 'status: active\nfixture: true')
  writeFileSync(join(dir, '30_points/M-001.md'), a)
  mkdirSync(join(dir, '40_pending/_segments'), { recursive: true })
  writeFileSync(join(dir, '40_pending/_segments/S-1.md'), '# 包\n')

  const list = listFixtures(dir)
  assert.equal(list.length, 2)
  assert.equal(list.some((f) => f.kind === 'segments'), true)

  const dry = resetFixtures(dir)
  assert.equal(dry.applied, false)
  assert.equal(existsSync(join(dir, '30_points/M-001.md')), true)

  const r = resetFixtures(dir, { apply: true })
  assert.equal(r.deleted, 2)
  assert.equal(existsSync(join(dir, '30_points/M-001.md')), false)
  assert.equal(existsSync(join(dir, '30_points/M-002.md')), true)
  assert.equal(existsSync(join(dir, '10_archive/messages/2026-10-28.jsonl')), true)
  assert.equal(listFixtures(dir).length, 0)
})

test('ingest：批量提升合格草稿，不合格的不动，并给段打 .done', () => {
  const dir = fixture()
  const draft = (id, quote, body) => `---
id: ${id}
title: 测试 ${id}
quote: ${quote}
quote_by: him
date: 2026-10-30
salience: 2
type: event
cluster: 测试
event: null
tags: []
status: pending
source: [m-user-1]
links: []
segment: S-20261029-01
---

<!-- SUM -->
${body}
<!-- /SUM -->
`
  writeFileSync(join(dir, '40_pending/M-2026-10-30-010.md'), draft('M-2026-10-30-010', '我讨厌香菜', '他说他讨厌香菜。'))
  writeFileSync(join(dir, '40_pending/M-2026-10-30-011.md'), draft('M-2026-10-30-011', '我没说过这句', '编的。'))

  const dry = ingestPending(dir)
  assert.equal(dry.applied, false)
  assert.equal(dry.results.filter((r) => r.ok).length, 1)

  const r = ingestPending(dir, { apply: true })
  assert.equal(r.promoted.length, 1)
  assert.equal(existsSync(join(dir, '30_points/M-2026-10-30-010.md')), true)
  assert.equal(existsSync(join(dir, '40_pending/M-2026-10-30-011.md')), true)
  assert.equal(existsSync(join(dir, '40_pending/M-2026-10-30-010.md')), false)
  assert.equal(existsSync(join(dir, '40_pending/_segments/S-20261029-01.done')), true)
  assert.match(readFileSync(join(dir, '30_points/M-2026-10-30-010.md'), 'utf8'), /status: active/)
})

test('audit：原话被改写 = provenance 违规', () => {
  const dir = fixture()
  const p = readFileSync(join(dir, '30_points/M-001.md'), 'utf8').replace('quote: 我讨厌香菜', 'quote: 他讨厌香菜')
  writeFileSync(join(dir, '30_points/M-001.md'), p)
  writeIndex(dir, buildIndex(readPointFiles(dir), { now: new Date('2026-10-29T00:00:00Z') }))
  const r = audit(dir, { now: new Date('2026-10-29T00:00:00Z') })
  assert.equal(r.checks.find((c) => c.id === 'provenance').violations, 1)
  assert.equal(r.passed, false)
})

test('splitSegments：30 分钟切段，24 小时记空窗', () => {
  const m = (iso, i) => ({ id: `m${i}`, ts: iso, role: 'user', text: `第${i}条` })
  const messages = [
    m('2026-10-28T10:00:00.000Z', 1),
    m('2026-10-28T10:10:00.000Z', 2),
    m('2026-10-28T10:41:00.000Z', 3), // 31 分钟 → 新段
    m('2026-10-29T12:00:00.000Z', 4), // 25 小时 → 空窗
  ]
  const { segments, gaps } = splitSegments(messages)
  assert.equal(segments.length, 3)
  assert.equal(segments[0].messages.length, 2)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].days, 1.1)
  assert.match(segments[0].id, /^S-\d{8}-01$/)
})

test('splitSegments：宿主上下文不进压缩包', () => {
  const messages = [
    { id: 'm1', ts: '2026-10-28T10:00:00.000Z', role: 'user', text: '我在成都', source_kind: 'user' },
    { id: 'm2', ts: '2026-10-28T10:00:10.000Z', role: 'user', text: 'Time sampled while preparing turn 4', source_kind: 'time-context' },
    { id: 'm3', ts: '2026-10-28T10:00:20.000Z', role: 'assistant', text: '记得', source_kind: 'model' },
  ]
  const { segments } = splitSegments(messages)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].messages.map((m) => m.id), ['m1', 'm3'])
})

test('renderDigest：带来源与压缩要求，角色写成你/她', () => {
  const messages = [
    { id: 'm1', ts: '2026-10-28T10:00:00.000Z', role: 'user', text: '我讨厌香菜' },
    { id: 'm2', ts: '2026-10-28T10:01:00.000Z', role: 'assistant', text: '知道了' },
  ]
  const { segments } = splitSegments(messages)
  const text = renderDigest(segments[0])
  assert.match(text, /segment: S-/)
  assert.match(text, /source: \[m1, m2\]/)
  assert.match(text, /你：我讨厌香菜/)
  assert.match(text, /她：知道了/)
  assert.match(text, /不许编造/)
})
