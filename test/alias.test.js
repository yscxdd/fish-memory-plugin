// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 别名半自动（v0.48.0）——只提案，人点头才写回点。
 *
 * 钉住七件事：
 *   ① 候选必须**与点已有的词共现**在同一批消息里（不是全库高频词）；
 *   ② 共现的消息数不够 minSupport 就不提（一次口误不算）；
 *   ③ 点词表里已有的词、以及包含现有词的长词，都不提（加了不增加召回路径）；
 *   ④ reject 过的不再提（`20_state/alias-reject.json`）；
 *   ⑤ 写回只动 front matter 那一行，正文逐字不变，三种现状（行内/块状/无键）都要会；
 *   ⑥ accept 幂等，重复 accept 不产生重复项；
 *   ⑦ **端到端**：写回之后，他那套措辞真的能召回这条点（这是这个模块存在的理由）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acceptAlias,
  aliasCoverage,
  aliasOverview,
  contentWords,
  isRejected,
  loadRejections,
  mineAliases,
  pointVocab,
  rejectAlias,
  setAliasesInText,
  validTerm,
} from '../lib/alias.js'
import { rankHybrid } from '../lib/retrieve.js'
import { readPointFiles, scanPointFiles } from '../lib/toolkit.js'

const NOW = new Date('2026-11-04T12:00:00Z')

const POINT = `---
id: M-2026-10-20-001
title: 他膝盖疼
quote: 一下雨膝盖就疼
date: 2026-10-20
salience: 3
type: event
cluster: 日常
event: E-20261020-01
tags: [下雨, 膝盖]
status: active
source: [msg-1]
links: []
---

<!-- SUM -->
下雨天他膝盖疼，难受。
<!-- /SUM -->

## 发生了什么

[事实] 下雨那天他说膝盖疼。

---

正文里也有"关节"两个字，但不该被改。
`

function fixture({ point = POINT, messages = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-alias-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '30_points/M-2026-10-20-001.md'), point, 'utf8')
  const lines = messages.map((m, i) =>
    JSON.stringify({
      id: m.id || `msg-${i + 1}`,
      seq: i + 1,
      ts: m.ts || '2026-10-20T10:00:00.000Z',
      role: m.role || 'user',
      source_kind: m.role === 'model' ? 'model' : 'user',
      text: m.text,
    }),
  )
  writeFileSync(join(dir, '10_archive/messages/2026-10-20.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return dir
}

const p1 = (dir) => scanPointFiles(dir).points[0]

// ── ① 词提取 ───────────────────────────────────────────────────

test('contentWords：切词并去掉功能词', () => {
  const w = contentWords('我今天关节有点不舒服，是不是要下雨了')
  assert.ok(w.includes('关节'), `应含"关节"，实际 ${w.join('/')}`)
  assert.ok(!w.includes('的'), '功能词要滤掉')
  assert.ok(!w.includes('我'), '代词要滤掉')
})

test('validTerm：会破坏 front matter 的形状一律拒绝', () => {
  assert.equal(validTerm('关节').ok, true)
  assert.equal(validTerm('').ok, false)
  assert.equal(validTerm('a,b').ok, false, '逗号会切断数组')
  assert.equal(validTerm('a]b').ok, false)
  assert.equal(validTerm('的').ok, false, '功能词不能当别名')
  assert.equal(validTerm('一二三四五六七八九十十一十二').ok, false, '过长')
})

// ── ② 候选必须共现 ─────────────────────────────────────────────

test('共现才提：3 条含"膝盖"的消息里都出现了"关节"', () => {
  const dir = fixture({
    messages: [
      { text: '一下雨膝盖就疼，关节跟生锈一样' },
      { text: '今天关节又不行了，膝盖也是' },
      { text: '膝盖疼的时候关节会肿', role: 'model' },
    ],
  })
  const r = mineAliases(dir, p1(dir), { minSupport: 3 })
  const terms = r.candidates.map((c) => c.term)
  assert.ok(terms.includes('关节'), `应提出"关节"，实际 ${terms.join('/')}`)
  const j = r.candidates.find((c) => c.term === '关节')
  assert.equal(j.support, 3)
  assert.equal(j.inUser, 2, '三条里两条是他说的')
})

test('不共现就不提：消息里只有"关节"、没有该点任何已有的词', () => {
  const dir = fixture({
    messages: [
      { text: '关节不舒服' },
      { text: '关节又疼了' },
      { text: '关节肿了' },
    ],
  })
  const r = mineAliases(dir, p1(dir), { minSupport: 3 })
  assert.ok(!r.candidates.some((c) => c.term === '关节'), '没有共现，不该提')
})

test('消息数不够 minSupport 就不提（一次口误不算）', () => {
  const dir = fixture({
    messages: [{ text: '膝盖和关节都疼' }, { text: '膝盖疼，关节也是' }],
  })
  const r = mineAliases(dir, p1(dir), { minSupport: 3 })
  assert.ok(!r.candidates.some((c) => c.term === '关节'), '只共现 2 条，达不到 3')
})

test('点词表里已有的词不再提（提了也不增加召回路径）', () => {
  const dir = fixture({ messages: Array(4).fill({ text: '膝盖疼，膝盖受不了' }) })
  const r = mineAliases(dir, p1(dir), { minSupport: 3 })
  assert.ok(!r.candidates.some((c) => c.term === '膝盖'), '已有词不该进候选')
  assert.ok(!pointVocab(p1(dir)).has('关节'), '词表里本来没有关节')
})

// ── ③ 拒绝表 ───────────────────────────────────────────────────

test('reject 之后不再提，并落盘', () => {
  const dir = fixture({ messages: Array(4).fill({ text: '膝盖疼，关节也疼' }) })
  assert.ok(mineAliases(dir, p1(dir), { minSupport: 3 }).candidates.some((c) => c.term === '关节'))
  const r = rejectAlias(dir, 'M-2026-10-20-001', '关节', { now: NOW })
  assert.equal(r.ok, true)
  assert.equal(isRejected(dir, 'M-2026-10-20-001', '关节'), true)
  assert.deepEqual(loadRejections(dir)['M-2026-10-20-001'], ['关节'])
  assert.ok(!mineAliases(dir, p1(dir), { minSupport: 3 }).candidates.some((c) => c.term === '关节'))
})

// ── ④ 写回 front matter ────────────────────────────────────────

test('setAliasesInText：没有这个键 → 插在字段区末尾，正文一字不动', () => {
  const out = setAliasesInText(POINT, ['关节', '骨节'])
  assert.equal(out.ok, true)
  assert.match(out.text, /^aliases: \[关节, 骨节\]$/m)
  assert.ok(out.text.endsWith(POINT.slice(POINT.indexOf('<!-- SUM -->'))), '正文必须逐字不变')
})

test('setAliasesInText：行内数组 → 整行替换', () => {
  const src = POINT.replace('tags: [下雨, 膝盖]', 'tags: [下雨, 膝盖]\naliases: [老寒腿]')
  const out = setAliasesInText(src, ['关节'])
  assert.match(out.text, /^aliases: \[关节\]$/m)
  assert.ok(!out.text.includes('老寒腿'))
})

test('setAliasesInText：块状列表 → 收成行内，且不留空壳', () => {
  const src = POINT.replace('tags: [下雨, 膝盖]', 'tags: [下雨, 膝盖]\naliases:\n  - 老寒腿\n  - 风湿')
  const out = setAliasesInText(src, ['关节'])
  assert.match(out.text, /^aliases: \[关节\]$/m)
  assert.ok(!out.text.includes('老寒腿') && !out.text.includes('风湿'), '旧块要吃掉')
  assert.ok(!/^aliases:\s*$/m.test(out.text), '不能留下空的 aliases:')
})

test('setAliasesInText：CRLF 文件写回还是 CRLF', () => {
  const src = POINT.replace(/\n/g, '\r\n')
  const out = setAliasesInText(src, ['关节'])
  assert.ok(out.text.includes('\r\n'), '换行风格要跟原文件')
  assert.ok(!/[^\r]\n/.test(out.text), '不能混进裸 LF')
})

// ── ⑤ accept 幂等 + 端到端召回 ─────────────────────────────────

test('accept：写回后 scanPointFiles 能读到，重复 accept 不出重复项', () => {
  const dir = fixture()
  const a = acceptAlias(dir, 'M-2026-10-20-001', '关节', { now: NOW })
  assert.equal(a.ok, true)
  assert.equal(a.added, true)
  assert.deepEqual(a.aliases, ['关节'])
  assert.deepEqual(p1(dir).aliases, ['关节'], '离线扫描要能看到')

  const b = acceptAlias(dir, 'M-2026-10-20-001', '关节', { now: NOW })
  assert.equal(b.added, false, '幂等')
  assert.deepEqual(p1(dir).aliases, ['关节'])

  const log = readFileSync(join(dir, '50_log/alias.log'), 'utf8').trim().split('\n')
  assert.equal(log.length, 1, '重复 accept 不该写第二条流水')
})

test('accept：词不合法就拒绝，且不写文件', () => {
  const dir = fixture()
  const before = readFileSync(join(dir, '30_points/M-2026-10-20-001.md'), 'utf8')
  const r = acceptAlias(dir, 'M-2026-10-20-001', 'a,b', { now: NOW })
  assert.equal(r.ok, false)
  assert.equal(readFileSync(join(dir, '30_points/M-2026-10-20-001.md'), 'utf8'), before)
})

test('端到端：他那套措辞本来召不回，accept 别名之后就召回了', () => {
  const dir = fixture()
  const q = '关节不舒服'
  const opts = { threshold: 0.8, limit: 3, rebalance: true }
  assert.equal(rankHybrid(readPointFiles(dir), q, opts).length, 0, '前提：本来召不回')

  acceptAlias(dir, 'M-2026-10-20-001', '关节', { now: NOW })
  const hit = rankHybrid(readPointFiles(dir), q, opts)
  assert.equal(hit.length, 1, '写完别名应能召回')
  assert.equal(hit[0].point.id, 'M-2026-10-20-001')
})

// ── ⑥ 覆盖率 ───────────────────────────────────────────────────

test('覆盖率与一览', () => {
  const dir = fixture()
  assert.deepEqual(aliasCoverage(dir), { points: 1, withAlias: 0, rate: 0 })
  acceptAlias(dir, 'M-2026-10-20-001', '关节', { now: NOW })
  assert.deepEqual(aliasCoverage(dir), { points: 1, withAlias: 1, rate: 1 })
  assert.deepEqual(aliasOverview(dir), [{ id: 'M-2026-10-20-001', title: '他膝盖疼', aliases: ['关节'] }])
})
