// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * inject-diff（v0.13.2）：改前/改后"她读到什么"的对比工具。
 *
 * 钉住四件事：
 *   ① 它复用的是真实装配（`assemble`），核心层按预算裁剪，不是另写一套；
 *   ② 段落级 diff 能指出"哪一段消失"（改参数最容易出的事故）；
 *   ③ 预算变化导致核心层被裁时，`coreDropped` 要点名（不是只说"tok 少了"）；
 *   ④ `_samples/` 的演示点必须被标出来——`store.indexPoints()` 会扫它，
 *      空库时她"检索到"的其实是演示素材（2026-10-30 真实注入过一次）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { capture, diffQueries, diffText, renderProbe, RETRIEVAL_DEFAULTS } from '../scripts/inject-diff.mjs'
import { DEFAULT_BUDGET } from '../lib/render.js'
import { MemoryStore } from '../lib/store.js'
import { estTokens } from '../lib/util.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

const SOUL = `# SOUL — 她是谁

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议
`

const RULES = `# 硬规则

## 写入

1. 只能写 \`40_pending/\`，不直写 \`30_points/\`。

## 读取

1. 找不到就说找不到。
`

const SAMPLE = `---
id: M-2026-10-28-001
title: 台风天看海
quote: 这种天气看海才有意思
quote_by: him
date: 2026-10-28
salience: 4
type: event
cluster: 出行
event: null
tags: [海边, 台风]
status: active
source: [msg-sample-00042]
links: []
---

<!-- SUM -->
台风夜地铁口积水到小腿，两人还是绕路去了海边。
<!-- /SUM -->
`

function makeLib({ withSample = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-injdiff-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), SOUL)
  writeFileSync(join(dir, '00_core/rules.md'), RULES)
  writeFileSync(join(dir, '00_core/relation_status.json'), JSON.stringify({ phase: '常态' }))
  if (withSample) {
    mkdirSync(join(dir, '_samples'), { recursive: true })
    writeFileSync(join(dir, '_samples/M-2026-10-28-001.md'), SAMPLE)
  }
  return dir
}

const cfg = (over = {}) => ({
  cfg: {},
  raw: {},
  budget: { ...DEFAULT_BUDGET, ...(over.inject || {}) },
  retrieval: { ...RETRIEVAL_DEFAULTS, ...(over.retrieval || {}) },
})

test('inject-diff：核心层与规则都在，模式按 detectMode 判', () => {
  const dir = makeLib()
  const store = new MemoryStore(dir)
  const chat = renderProbe({ store, dir, query: '今天有点累', budget: DEFAULT_BUDGET, retrieval: RETRIEVAL_DEFAULTS })
  assert.match(chat.text, /我最怕被当成/)
  assert.match(chat.text, /找不到就说找不到/)
  assert.equal(chat.mode, 'daily')
  assert.ok(chat.tokens > 0)

  const work = renderProbe({ store, dir, query: '帮我改一下 lib/self.js，然后跑测试', budget: DEFAULT_BUDGET, retrieval: RETRIEVAL_DEFAULTS })
  assert.equal(work.mode, 'task', '动作+路径 → 任务模式')
})

/** 只够装 soul+status 的预算：逼出"rules 被裁" */
function tightBudget(dir) {
  const parts = new MemoryStore(dir).coreParts()
  const keep = parts.filter((p) => p.name === 'soul' || p.name === 'status')
  return { ...DEFAULT_BUDGET, core: keep.reduce((n, p) => n + estTokens(p.text), 0) + 5 }
}

test('inject-diff：预算收紧时核心层被裁，要点名 rules（不是只说 tok 少了）', () => {
  const dir = makeLib()
  const store = new MemoryStore(dir)
  const before = renderProbe({ store, dir, query: '今天有点累', budget: DEFAULT_BUDGET, retrieval: RETRIEVAL_DEFAULTS })
  const after = renderProbe({ store, dir, query: '今天有点累', budget: tightBudget(dir), retrieval: RETRIEVAL_DEFAULTS })
  assert.ok(after.tokens < before.tokens)
  assert.ok(after.coreDropped.includes('rules'), `coreDropped=${JSON.stringify(after.coreDropped)}`)
  assert.doesNotMatch(after.text, /找不到就说找不到/, 'rules 被裁掉了就不该还在正文里')
  assert.match(after.text, /我最怕被当成/, 'soul 优先级最高，必须留下')
})

test('inject-diff：段落级 diff 指名道姓说哪一节消失', () => {
  const dir = makeLib()
  const store = new MemoryStore(dir)
  const a = renderProbe({ store, dir, query: '今天', budget: DEFAULT_BUDGET, retrieval: RETRIEVAL_DEFAULTS })
  const b = renderProbe({ store, dir, query: '今天', budget: tightBudget(dir), retrieval: RETRIEVAL_DEFAULTS })
  const d = diffText(a.text, b.text)
  assert.equal(d.changed, true)
  assert.ok(d.tokenDelta < 0)
  assert.ok(d.sectionsRemoved.some((s) => /硬规则/.test(s)), `sectionsRemoved=${JSON.stringify(d.sectionsRemoved)}`)
  assert.equal(d.sectionsAdded.length, 0)
})

test('inject-diff：没改动就是"没变"（不能把时间流逝算成变化）', () => {
  const dir = makeLib({ withSample: true })
  const base = capture({ dir, queries: [{ id: 'chat', q: '今天有点累' }], config: cfg(), mode: 'auto' })
  const cur = capture({ dir, queries: [{ id: 'chat', q: '今天有点累' }], config: cfg(), mode: 'auto' })
  const rows = diffQueries(base, cur)
  assert.equal(rows[0].changed, false)
  assert.equal(rows[0].tokenDelta, 0)
})

test('inject-diff：库里有遗留 _samples/ 也不再参与检索（v0.13.3）', () => {
  const dir = makeLib({ withSample: true })
  const snap = capture({ dir, queries: [{ id: 'recall', q: '上次台风那天我们去了哪' }], config: cfg(), mode: 'auto' })
  assert.equal(snap.samples.available, 1, '目录还在，工具要能发现它')
  assert.deepEqual(snap.samples.used, [], '但**不许**被读到——它不是她的记忆')
  assert.deepEqual(snap.queries[0].rendered, [], '台风那条样例不该出现在正文')
  assert.deepEqual(snap.queries[0].sampleHits, [])
  assert.doesNotMatch(snap.queries[0].text, /台风天看海/, '注入里不能出现没发生过的事')
})

test('inject-diff：没有 _samples/ 时就是干净的空库', () => {
  const dir = makeLib()
  const snap = capture({ dir, queries: [{ id: 'recall', q: '上次台风那天我们去了哪' }], config: cfg(), mode: 'auto' })
  assert.equal(snap.samples.available, 0)
  assert.deepEqual(snap.samples.used, [])
  assert.deepEqual(snap.queries[0].rendered, [])
})

test('inject-diff CLI：--print --json 能跑通并给出结构化结果', () => {
  const dir = makeLib()
  const r = spawnSync(process.execPath, [join(pkgRoot, 'scripts/inject-diff.mjs'), '--print', '--json', '--dir', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.match(out.plugin, /^\d+\.\d+\.\d+/)
  assert.equal(out.queries.length, 5, '默认 5 个问题：闲聊/回忆/工作/边界/空')
  assert.ok(out.queries.every((q) => typeof q.tokens === 'number'))
})
