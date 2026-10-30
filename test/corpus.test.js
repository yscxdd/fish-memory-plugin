// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 合成语料回归：不需要真实聊天，验证「切段 → 校验 → 提升 → 索引 → 检索」整条管线。
 * 压缩的"判断"仍由 agent 做；这里断言的是管线正确性与可检索性。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestPending, audit, readArchive, readPointFiles, splitSegments } from '../lib/toolkit.js'
import { buildGapDraft, writeGapDraft } from '../lib/gaps.js'
import { bigrams, rank } from '../lib/retrieve.js'

const SOUL = `# SOUL

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议
`

const SCENARIOS = [
  {
    quote: '我讨厌香菜',
    title: '他讨厌香菜',
    type: 'preference',
    salience: 3,
    cluster: '偏好',
    tags: ['香菜', '忌口'],
    query: '香菜',
    at: 0,
  },
  {
    quote: '你别总说我懂事',
    title: '别夸她懂事',
    type: 'boundary',
    salience: 5,
    cluster: '她的偏好',
    tags: ['懂事', '底线'],
    query: '懂事',
    at: 40,
  },
  {
    quote: '周末陪你去那家店',
    title: '周末去那家店',
    type: 'promise',
    salience: 4,
    cluster: '约定',
    tags: ['周末', '那家店'],
    query: '周末',
    at: 80,
  },
  {
    quote: '你根本没在听我说话',
    title: '吵架那天他没在听',
    type: 'conflict',
    salience: 4,
    cluster: '冲突',
    tags: ['吵架', '没在听'],
    query: '没在听',
    at: 120,
  },
]

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-corpus-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), SOUL)
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '40_pending'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  return dir
}

function dialogue() {
  const base = Date.parse('2026-10-20T02:00:00.000Z')
  const messages = []
  for (const [i, s] of SCENARIOS.entries()) {
    const ts = new Date(base + s.at * 60_000).toISOString()
    messages.push({
      id: `msg-u-${i}`,
      msgid_plat: `plat-u-${i}`,
      seq: i * 2 + 1,
      ts,
      role: 'user',
      source_kind: 'user',
      text: s.quote,
      session: 's1',
    })
    messages.push({
      id: `msg-a-${i}`,
      msgid_plat: `plat-a-${i}`,
      seq: i * 2 + 2,
      ts: new Date(Date.parse(ts) + 10_000).toISOString(),
      role: 'assistant',
      source_kind: 'model',
      text: '嗯，记住了。',
      session: 's1',
    })
  }
  return messages
}

function draft(id, s, i, segment) {
  return `---
id: ${id}
title: ${s.title}
quote: ${s.quote}
quote_by: ${s.type === 'boundary' ? 'her' : 'him'}
date: 2026-10-20
salience: ${s.salience}
type: ${s.type}
cluster: ${s.cluster}
event: null
tags: [${s.tags.join(', ')}]
status: pending
source: [msg-u-${i}]
links: []
segment: ${segment}
---

<!-- SUM -->
${s.title}。他说了这件事。
<!-- /SUM -->

## 发生了什么

[事实] ${s.quote}
`
}

test('合成语料：四段对话 → 四段切开 → 校验提升 → 每条都能被检索到', () => {
  const dir = makeDir()
  const messages = dialogue()
  writeFileSync(
    join(dir, '10_archive/messages/2026-10-20.jsonl'),
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
  )

  const { segments, gaps } = splitSegments(messages)
  assert.equal(segments.length, 4, '每段间隔 40 分钟，应切 4 段')
  assert.equal(gaps.length, 0)

  for (const [i, s] of SCENARIOS.entries()) {
    writeFileSync(join(dir, '40_pending', `M-2026-10-20-00${i + 1}.md`), draft(`M-2026-10-20-00${i + 1}`, s, i, segments[i].id))
  }

  const dry = ingestPending(dir)
  assert.equal(dry.results.filter((r) => !r.ok).length, 0, JSON.stringify(dry.results))

  const r = ingestPending(dir, { apply: true })
  assert.equal(r.promoted.length, 4)
  for (let i = 0; i < 4; i++) {
    assert.equal(existsSync(join(dir, '40_pending/_segments', `${segments[i].id}.done`)), true, '每段应打 .done')
  }

  const points = readPointFiles(dir, '30_points')
  for (const s of SCENARIOS) {
    const top = rank(points, bigrams(s.query), { threshold: 0.8, limit: 5 })
    assert.ok(top.length >= 1, `${s.query} 应命中`)
    assert.equal(top[0].point.id, points.find((p) => p.title === s.title).id, `${s.query} 应命中「${s.title}」`)
  }

  const report = audit(dir)
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)))
})

test('合成语料：空窗 3 天 → 生成 gap 草稿，能过校验并提升', () => {
  const dir = makeDir()
  const base = Date.parse('2026-10-20T02:00:00.000Z')
  writeFileSync(
    join(dir, '10_archive/messages/2026-10-20.jsonl'),
    [
      { id: 'msg-a', msgid_plat: 'pa', seq: 1, ts: new Date(base).toISOString(), role: 'user', source_kind: 'user', text: '我走了', session: 's1' },
      {
        id: 'msg-b',
        msgid_plat: 'pb',
        seq: 2,
        ts: new Date(base + 3 * 86_400_000).toISOString(),
        role: 'user',
        source_kind: 'user',
        text: '我回来了',
        session: 's1',
      },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  )

  const gap = buildGapDraft({
    dir,
    prev: { id: 'msg-a', ts: new Date(base).toISOString() },
    next: { id: 'msg-b', ts: new Date(base + 3 * 86_400_000).toISOString() },
  })
  assert.ok(gap)
  assert.equal(writeGapDraft(gap), true)

  const r = ingestPending(dir, { apply: true })
  assert.equal(r.promoted.length, 1)
  const p = readPointFiles(dir, '30_points')[0]
  assert.equal(p.type, 'gap')
  assert.match(p.summary, /无对话（3 天）/)
  assert.deepEqual(p.source, ['msg-a', 'msg-b'])
})
