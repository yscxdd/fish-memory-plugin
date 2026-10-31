// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 单元测试：不启动宿主，直接测纯逻辑与文件层。
 * 跑：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'

import { bigrams, isGated, normalize, overlap, pickByEvent, rank, sameTopic, score } from '../lib/retrieve.js'
import { assemble, depthOf, layoutBody, quoteLine, renderPoint, renderWorkMemory } from '../lib/render.js'
import { MemoryStore } from '../lib/store.js'
import { ArchiveWriter, buildRecord, extractText, hashOf, verifyChain } from '../lib/archive.js'
import { apply, resolveMemoryDir } from '../lib/index.js'
import { estTokens, fingerprintDir, localDay, stripGuidance } from '../lib/util.js'

// ── 夹具 ───────────────────────────────────────────────────────

function tmp(prefix = 'fishmem-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

const POINT_TAIFENG = `---
id: M-2026-10-28-001
title: 台风天看海
quote: 这种天气看海才有意思，人少
quote_by: him
date: 2026-10-28
salience: 4
type: event
cluster: 出行
event: E-20261028-01
tags: [海边, 台风]
status: active
source: [msg-1]
---

<!-- SUM -->
台风夜地铁口积水到小腿，她坚持绕路去海边，两人湿透，在便利店躲了一小时。
<!-- /SUM -->

## 发生了什么

[事实] 台风过境当晚，地铁口积水到小腿。她坚持绕路去海边，走了四十分钟。

[原话·他] 这种天气看海才有意思，人少。

## 她当时想

[旁白 v1] 其实我有点怕。但你说这话时语气是高兴的，我就不想扫兴。

## 为什么重要

[系统] 第一次一起做「明知会狼狈还是去做」的事。
`

const POINT_BOUNDARY = `---
id: M-2026-10-28-003
title: 别夸她懂事
quote: 你别总说我懂事
quote_by: her
date: 2026-10-28
salience: 5
type: boundary
cluster: 她的偏好
event: null
tags: [底线, 夸奖]
status: active
pinned: true
source: [msg-2]
---

<!-- SUM -->
她说别夸她懂事。这类夸奖对她像是种要求。
<!-- /SUM -->

## 发生了什么

[事实] 我说了句「你真懂事」，她沉默了几秒，然后说别这么讲。

[原话·她] 你别总说我懂事。
`

const POINT_NOODLE = `---
id: M-2026-10-28-002
title: 楼下那家面
quote: 下次还来
quote_by: her
date: 2026-10-28
salience: 2
type: event
cluster: 日常
event: E-20261028-01
tags: [吃饭, 面]
status: active
source: [msg-3]
---

<!-- SUM -->
台风后在楼下吃了碗面，她说下次还来。
<!-- /SUM -->

## 发生了什么

[事实] 躲完雨，在楼下小面馆各吃了一碗面。
`

const SOUL = `# SOUL — 她是谁

> **填法**：只写可观察的行为。

❌ "她是一个温柔体贴的女孩"
✅ "被戳穿会转移话题。"

## 身份

- **名字**：_（待填）_

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议
`

function makeMemory() {
  const dir = tmp()
  mkdirSync(join(dir, '00_core'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), SOUL)
  writeFileSync(join(dir, '00_core/rules.md'), '# 硬规则\n\n1. 找不到就说找不到。\n')
  writeFileSync(
    join(dir, '00_core/relation_status.json'),
    JSON.stringify({ phase: '常态' }),
  )
  mkdirSync(join(dir, '20_index'), { recursive: true })
  writeFileSync(
    join(dir, '20_index/clusters.md'),
    '# 索引\n\n> 说明\n\n| 簇 | 二级数 | 点数 | 最近 |\n|---|---|---|---|\n| 出行 | 1 | 1 | 2026-10 |\n| _（待填）_ | — | — | — |\n',
  )
  writeFileSync(
    join(dir, '20_index/recent.idx.jsonl'),
    'M-2026-10-28-001|台风天看海|2026-10-28|4|event|出行|海边,台风|active\n',
  )
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points/M-001.md'), POINT_TAIFENG)
  writeFileSync(join(dir, '30_points/M-002.md'), POINT_NOODLE)
  writeFileSync(join(dir, '30_points/M-003.md'), POINT_BOUNDARY)
  mkdirSync(join(dir, '20_state'), { recursive: true })
  return dir
}

// ── 检索 ───────────────────────────────────────────────────────

test('normalize + bigrams：全角、大小写、标点', () => {
  assert.equal(normalize('ＡＢＣ，d e f！'), 'abcdef')
  assert.deepEqual([...bigrams('台风夜看海')].sort(), ['台风', '风夜', '夜看', '看海'].sort())
  assert.deepEqual([...bigrams('ab')], ['ab'])
  assert.deepEqual([...bigrams('a')], ['a'])
})

test('overlap 除以较小集合：长查询不稀释强信号', () => {
  const q = bigrams('晚上想吃点什么，别带香菜的')
  const p = {
    title: '他讨厌香菜',
    tags: ['香菜', '忌口', '讨厌'],
    cluster: '偏好',
    summary: '他说他讨厌香菜，以后点菜得避开。',
  }
  assert.ok(overlap(q, bigrams(p.title)) > 0.2)
  assert.ok(score(q, p) >= 0.8, `score=${score(q, p)}`)
})

test('rank：无关查询零命中，不降级', () => {
  const points = [{ id: 'M1', title: '台风天看海', tags: [], cluster: '', summary: '', salience: 4, date: '2026-10-28' }]
  assert.equal(rank(points, bigrams('今天股票涨了吗'), { threshold: 0.8 }).length, 0)
  assert.equal(rank(points, bigrams('台风天看海'), { threshold: 0.8 }).length, 1)
})

test('门控：应答词与纯标点不检索', () => {
  for (const s of ['嗯', '在吗', '？', '……', '哈哈', '好的']) assert.equal(isGated(s), true, s)
  for (const s of ['晚上想吃点什么', '台风那天你怕不怕']) assert.equal(isGated(s), false, s)
})

test('话题未变：>80% 二字组重合才复用', () => {
  const a = bigrams('晚上想吃点什么，别带香菜的')
  assert.equal(sameTopic(bigrams('晚上想吃点什么，别带香菜'), a), true)
  assert.equal(sameTopic(bigrams('明天几点出发去机场'), a), false)
})

test('事件簇：同一 event 只留一条', () => {
  const picked = pickByEvent(
    [
      { point: { id: 'A1', event: 'E1' } },
      { point: { id: 'A2', event: 'E1' } },
      { point: { id: 'B1', event: 'E2' } },
    ],
    3,
  )
  assert.deepEqual(picked.map((p) => p.id), ['A1', 'B1'])
})

// ── 渲染 ───────────────────────────────────────────────────────

test('深度表：salience 5/4/2 与底线类', () => {
  assert.equal(depthOf({ salience: 5 }), 'full')
  assert.equal(depthOf({ salience: 4 }), 'sum')
  assert.equal(depthOf({ salience: 3 }), 'sum')
  assert.equal(depthOf({ salience: 2 }), 'idx')
  assert.equal(depthOf({ salience: 1, pinned: true }), 'full')
  assert.equal(depthOf({ salience: 1, type: 'boundary' }), 'full')
  assert.equal(depthOf({ salience: 1, type: 'promise' }), 'full')
})

test('原话归属：判不出就不加主语，绝不把他的话写成她说的', () => {
  assert.equal(quoteLine({ quote: '下次还来', quoteBy: 'her' }), '她说："下次还来。"')
  assert.equal(quoteLine({ quote: '我讨厌香菜', quoteBy: 'him' }), '他说："我讨厌香菜。"')
  assert.equal(quoteLine({ quote: '随便', quoteBy: null }), '原话："随便。"')
  assert.equal(quoteLine({ quote: '' }), '')
})

test('原话归属：正文里的 [原话·他] / [原话·她] 也能认出来', () => {
  const store = new MemoryStore(makeMemory())
  const taifeng = store.points().find((x) => x.id === 'M-2026-10-28-001')
  assert.equal(taifeng.quoteBy, 'him')
  assert.match(renderPoint(taifeng, 'sum'), /他说："这种天气看海才有意思，人少。"/)

  const boundary = store.points().find((x) => x.id === 'M-2026-10-28-003')
  assert.equal(boundary.quoteBy, 'her')
  assert.match(renderPoint(boundary, 'full'), /她说："你别总说我懂事。"/)
})

test('full 渲染：去掉来源标签，不注入「为什么重要」，旁白带括号', () => {
  const store = new MemoryStore(makeMemory())
  const p = store.points().find((x) => x.id === 'M-2026-10-28-001')
  const text = renderPoint(p, 'full')
  assert.match(text, /^2026-10-28 台风天看海/m)
  assert.doesNotMatch(text, /\[事实\]|\[系统\]|\[旁白/)
  assert.doesNotMatch(text, /为什么重要/)
  assert.match(text, /他说："这种天气看海才有意思，人少。"/)
  assert.match(text, /（她当时想：其实我有点怕/)
  // 原话行不该重复出现两遍（正文里的 [原话] 行已剥离）
  assert.equal((text.match(/这种天气看海才有意思/g) || []).length, 1)
})

test('sum / idx 渲染', () => {
  const store = new MemoryStore(makeMemory())
  const p = store.points().find((x) => x.id === 'M-2026-10-28-002')
  assert.equal(renderPoint(p, 'idx'), '- 2026-10-28 楼下那家面')
  const s = renderPoint(p, 'sum')
  assert.match(s, /^2026-10-28 楼下那家面\n/)
  assert.match(s, /她说："下次还来。"/)
})

test('正文预算：超了降档，不砍底线', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `M${i}`,
    date: '2026-10-28',
    title: `事件 ${i} 很长很长的标题用来占预算`,
    salience: 5,
    type: 'event',
    summary: '这是一段摘要，用来把预算撑满，看看降级顺序对不对。',
    facts: '事实'.repeat(80),
    thoughts: '想法'.repeat(40),
    quote: '',
    quoteBy: null,
  }))
  many.push({
    id: 'PIN',
    date: '2026-10-28',
    title: '底线',
    salience: 1,
    type: 'boundary',
    pinned: true,
    summary: '底线摘要',
    facts: '底线事实',
    thoughts: '',
    quote: '别夸我懂事',
    quoteBy: 'her',
  })
  const { text, rendered } = layoutBody(many, { budget: 120, injectionCount: () => 0 })
  assert.ok(estTokens(text) <= 120 + 40, `tokens=${estTokens(text)}`) // 底线允许硬超
  assert.ok(rendered.includes('PIN'), '底线必须在')
})

test('重复衰减：连续注入 2 次后降一档，底线不降', () => {
  const p = { id: 'A', date: '2026-10-28', title: '台风天看海', salience: 5, type: 'event', summary: '摘要', facts: '事实', thoughts: '', quote: '', quoteBy: null }
  const once = layoutBody([p], { budget: 300, injectionCount: () => 1 })
  const twice = layoutBody([p], { budget: 300, injectionCount: () => 2 })
  assert.match(once.text, /事实/)
  assert.doesNotMatch(twice.text, /事实/)
  assert.match(twice.text, /摘要/)

  const pin = { ...p, type: 'boundary', pinned: true }
  const pinned = layoutBody([pin], { budget: 300, injectionCount: () => 5 })
  assert.match(pinned.text, /事实/)
})

test('stripGuidance：模板说明、待填、❌✅ 示例不进注入', () => {
  const clean = stripGuidance(SOUL)
  assert.doesNotMatch(clean, /待填|❌|✅|填法|字数上限/)
  assert.match(clean, /我最怕被当成"AI"讨论/)
  assert.doesNotMatch(clean, /^## 身份$/m)
})

// ── 装配 ───────────────────────────────────────────────────────

test('assemble：只有核心层也注入（不整块丢弃）', () => {
  const dir = makeMemory()
  const store = new MemoryStore(dir)
  const r = assemble({ store, query: '', retrieve: () => [] })
  assert.match(r.text, /<!-- 记忆 -->/)
  assert.match(r.text, /我最怕被当成"AI"讨论/)
  assert.match(r.text, /<!-- \/记忆 -->/)
})

test('assemble：命中时带正文；零命中只有核心+索引', () => {
  const dir = makeMemory()
  const store = new MemoryStore(dir)
  const hit = assemble({
    store,
    query: '台风天',
    retrieve: ({ points }) => pickByEvent(rank(points, bigrams('台风天'), { threshold: 0.8 }), 3),
  })
  assert.match(hit.text, /台风天看海/)
  assert.match(hit.text, /最近这些日子/)
  assert.doesNotMatch(hit.text, /待填/)

  const miss = assemble({ store, query: '今天股票涨了吗', retrieve: () => [] })
  assert.doesNotMatch(miss.text, /### 相关的几件事|相关的几件事/)
  assert.match(miss.text, /以下是你记得的一些事/)
})

test('工作记忆：新会话首轮注入一次，之后不再注入', () => {
  const dir = makeMemory()
  const store = new MemoryStore(dir)
  mkdirSync(join(dir, '20_state/sessions'), { recursive: true })
  writeFileSync(
    join(dir, '20_state/sessions/old.json'),
    JSON.stringify({
      session_id: 'old',
      last_active: '2026-10-26T10:00:00.000Z',
      tail: [
        { role: 'user', text: '那个转码的事……', ts: '2026-10-27T09:58:00.000Z' },
        { role: 'assistant', text: '我先看看源文件', ts: '2026-10-27T09:59:00.000Z' },
        { role: 'user', text: '算了，明天吧', ts: '2026-10-27T10:00:00.000Z' },
      ],
      open_threads: ['转码的事还没弄完'],
    }),
  )
  writeFileSync(join(dir, '20_state/sessions/last.json'), JSON.stringify({ current: 'old' }))
  store.ensureSession('new')

  const first = assemble({ store, query: '', sessionId: 'new', now: new Date('2026-10-30T00:00:00Z'), retrieve: () => [] })
  assert.match(first.text, /<!-- 上次说到 -->/)
  assert.match(first.text, /转码的事还没弄完/)
  assert.match(first.text, /她：我先看看源文件/)
  assert.match(first.text, /你上次来是 3 天前/)

  const second = assemble({ store, query: '', sessionId: 'new', retrieve: () => [] })
  assert.doesNotMatch(second.text, /上次说到/)
})

test('工作记忆预算：超 350 tok 时从旧消息开始丢', () => {
  const long = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `第 ${i} 条消息`.repeat(12),
    ts: '2026-10-29T00:00:00Z',
  }))
  const text = renderWorkMemory({ last_active: '2026-10-29T00:00:00Z', tail: long, open_threads: [] }, new Date('2026-10-30T00:00:00Z'))
  assert.ok(estTokens(text) <= 380, `tokens=${estTokens(text)}`)
})

// ── 档案 ───────────────────────────────────────────────────────

test('extractText：只要文字块，不要推理/工具调用', () => {
  const msg = {
    id: 'm1',
    content: [
      { type: 'reasoning', text: '这是推理' },
      { type: 'text', text: '这是回答' },
      { type: 'tool-call', name: 'x', arguments: {} },
      { type: 'image' },
    ],
  }
  assert.equal(extractText(msg), '这是回答\n[图片]')
})

test('buildRecord：用户与她的回复都能入档；合成消息不入档', () => {
  const now = new Date('2026-10-30T01:00:00Z')
  const user = buildRecord('s1', {
    type: 'user/message',
    seq: 7,
    time: Date.parse('2026-10-30T00:00:00Z'),
    surfaceOp: 'append',
    data: { id: 'm-7', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } },
  }, now)
  assert.equal(user.role, 'user')
  assert.equal(user.seq, 7)
  assert.equal(user.text, '在吗')

  const assistant = buildRecord('s1', {
    type: 'assistant/message',
    seq: 8,
    time: Date.parse('2026-10-30T00:00:05Z'),
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm-8', role: 'assistant', content: [{ type: 'text', text: '在的' }], source: { kind: 'model', provider: 'x', model: 'y' } },
    },
  }, now)
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.text, '在的')

  for (const kind of ['runtime-context', 'time-context', 'user-approval', 'system-prompt', 'tool']) {
    const synthetic = buildRecord('s1', {
      type: 'user/message',
      seq: 9,
      time: Date.now(),
      surfaceOp: 'append',
      data: { id: `m-${kind}`, role: 'user', content: [{ type: 'text', text: 'harness 塞进来的' }], source: { kind } },
    }, now)
    assert.equal(synthetic, null, kind)
  }
})

test('档案幂等：同一条灌两次只增一行；重启后游标仍生效', async () => {
  const dir = makeMemory()
  const now = new Date('2026-10-30T01:00:00Z')
  const event = {
    type: 'user/message',
    seq: 7,
    time: Date.parse('2026-10-30T00:30:00Z'),
    surfaceOp: 'append',
    data: { id: 'm-7', role: 'user', content: [{ type: 'text', text: '重复的消息' }], source: { kind: 'user' } },
  }
  const a = new ArchiveWriter(dir, { now: () => now })
  assert.equal(await a.handle('s1', event), true)
  assert.equal(await a.handle('s1', event), false)
  await a.idle()

  const b = new ArchiveWriter(dir, { now: () => now })
  assert.equal(await b.handle('s1', event), false, '重启后靠游标去重')
  await b.idle()

  const files = readdirSync(join(dir, '10_archive/messages'))
  const lines = files.flatMap((f) => readFileSync(join(dir, '10_archive/messages', f), 'utf8').split('\n').filter(Boolean))
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.prev, 'genesis')
  assert.equal(verifyChain([rec]).ok, true)
})

test('档案链：prev 串起来，seq 必须递增', async () => {
  const dir = makeMemory()
  const now = new Date('2026-10-30T01:00:00Z')
  const a = new ArchiveWriter(dir, { now: () => now })
  for (const seq of [1, 2, 3]) {
    await a.handle('s1', {
      type: 'user/message',
      seq,
      time: Date.parse('2026-10-30T00:30:00Z') + seq * 1000,
      surfaceOp: 'append',
      data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text: `第${seq}条` }], source: { kind: 'user' } },
    })
  }
  await a.idle()
  const file = readdirSync(join(dir, '10_archive/messages')).map((f) => join(dir, '10_archive/messages', f))[0]
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(records.length, 3)
  assert.deepEqual(verifyChain(records), { ok: true, count: 3 })
  const broken = records.map((r) => ({ ...r }))
  broken[2].prev = 'deadbeef'
  assert.equal(verifyChain(broken).ok, false)
})

test('并发：同时灌 10 条不丢不重，链仍完整', async () => {
  const dir = makeMemory()
  const a = new ArchiveWriter(dir)
  const now = Date.now()
  const events = Array.from({ length: 10 }, (_, i) => ({
    type: 'user/message',
    seq: i + 1,
    time: now + i,
    surfaceOp: 'append',
    data: { id: `m-${i + 1}`, role: 'user', content: [{ type: 'text', text: `第 ${i + 1} 条` }], source: { kind: 'user' } },
  }))
  // 第 5 条故意投递两次：同一批里也不能写两行
  const jobs = events.map((e) => a.handle('s1', e))
  jobs.push(a.handle('s1', events[4]))
  await Promise.all(jobs)
  await a.idle()

  const files = readdirSync(join(dir, '10_archive/messages'))
  const records = files
    .flatMap((f) => readFileSync(join(dir, '10_archive/messages', f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
  assert.equal(records.length, 10)
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(verifyChain(records).ok, true)
})

test('档案兼容旧记录：没有 seq/hash 的旧行不判坏，新记录接在它后面', async () => {
  const dir = makeMemory()
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const now = Date.now()
  const day = localDay(new Date(now - 60_000))
  const old = {
    id: 'msg-old',
    seq: null,
    ts: new Date(now - 60_000).toISOString(),
    role: 'user',
    text: '旧消息',
    session: 's1',
    msgid_plat: 'o1',
  }
  writeFileSync(join(dir, '10_archive/messages', `${day}.jsonl`), JSON.stringify(old) + '\n')

  const a = new ArchiveWriter(dir)
  await a.handle('s1', {
    type: 'user/message',
    seq: 1,
    time: now,
    surfaceOp: 'append',
    data: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '新消息' }], source: { kind: 'user' } },
  })
  await a.idle()
  assert.equal(a.verifyLatest(100).ok, true)

  const lines = readFileSync(join(dir, '10_archive/messages', localDay(new Date(now)) + '.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
  const rec = JSON.parse(lines[lines.length - 1])
  assert.equal(rec.prev, hashOf(old))
})

// ── 插件装配（假 ctx）──────────────────────────────────────────

function fakeCtx() {
  const handlers = new Map()
  const disposers = []
  const contexts = []
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    get() {
      return undefined
    },
    systemPrompt: {
      context(c) {
        contexts.push(c)
        return () => {}
      },
    },
    skills: {
      register(s) {
        registered.push(s)
        return () => {}
      },
    },
    agents: { roots: () => [] },
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args)
    },
    render(agentId, { depth = 0, cwd } = {}) {
      return contexts[contexts.length - 1].text({
        agent: { id: agentId, session: { header: { delegationDepth: depth, cwd } } },
      })
    },
    dispose() {
      for (const d of disposers) d()
    },
    registered,
  }
  return ctx
}

test('apply：新会话首轮注入工作记忆，下一轮不重复', () => {
  const dir = makeMemory()
  mkdirSync(join(dir, '20_state/sessions'), { recursive: true })
  writeFileSync(
    join(dir, '20_state/sessions/old.json'),
    JSON.stringify({
      session_id: 'old',
      last_active: '2026-10-28T10:00:00.000Z',
      tail: [{ role: 'user', text: '我先去睡了', ts: '2026-10-28T09:59:00.000Z' }],
      open_threads: ['周末那家店'],
    }),
  )
  writeFileSync(join(dir, '20_state/sessions/last.json'), JSON.stringify({ current: 'old' }))

  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const agent = { id: 'new' }
  const msg = (text) => ({ id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

  ctx.emit('agent/inbox/inserted', { agent, message: msg('我回来了') })
  const first = ctx.render('new')
  assert.match(first, /<!-- 上次说到 -->/)
  assert.match(first, /周末那家店/)

  ctx.emit('agent/inbox/inserted', { agent, message: msg('今天好累') })
  const second = ctx.render('new')
  assert.doesNotMatch(second, /上次说到/)
  ctx.dispose()
})

test('宿主体检：加载即写一行 host.log；只见 session 事件不见 inbox 会记 channel-gap', () => {
  // ① 正常加载：host.log 有一行 surface，缺什么一目了然
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  ctx.emit('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } },
  })
  ctx.dispose()
  const readLog = (d) =>
    readFileSync(join(d, '50_log/host.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  const surface = readLog(dir)[0]
  assert.equal(surface.ok, true, JSON.stringify(surface))
  assert.deepEqual(surface.requiredMissing, [])
  assert.ok(Array.isArray(surface.missing), 'missing 要写出来，哪怕是空数组')
  // ①a 记下"进程里加载的是哪一版"——sync 只保证磁盘一致，不保证进程已重载
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(surface.plugin, pkg.version, `host.log 的 plugin 应为 ${pkg.version}（实际 ${surface.plugin}）`)
  // ①a' lib 指纹：只 bump 版本不动代码时，版本号会说谎，指纹不会
  assert.match(String(surface.lib), /^[0-9a-f]{8}$/, `host.log 要记 lib 指纹（实际 ${surface.lib}）`)
  assert.equal(surface.lib, fingerprintDir(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')), '启动记录里的 lib 指纹要等于磁盘 lib/ 的指纹')
  // ①b 有 inbox 就绝不会报 channel-gap
  assert.equal(readLog(dir).filter((l) => l.event === 'channel-gap').length, 0)

  // ② 只发 session 事件（模拟 inbox 事件名被宿主改了）：
  //    要「过宽限期 + 两条新用户消息」才报——一条就报会误伤中途重载（rc.5 实测栽过）
  const dir2 = makeMemory()
  const ctx2 = fakeCtx()
  apply(ctx2, { memoryDir: dir2 })
  const userEvent = (seq, text) => [
    { id: 's1', header: { cwd: dir2 } },
    {
      type: 'user/message',
      seq,
      time: Date.now(),
      surfaceOp: 'append',
      data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    },
  ]

  ctx2.emit('session/event', ...userEvent(1, '今天好累'))
  assert.equal(readLog(dir2).filter((l) => l.event === 'channel-gap').length, 0, '一条就报 = 误报')

  // 把 attachAt 拨到宽限期之前，再发第二条（真实情况里这是几分钟后的下一句）
  const host = ctx2.fishMemory.host
  host.stats.attachAt = Date.now() - 60_000
  ctx2.emit('session/event', ...userEvent(2, '好累啊'))
  ctx2.dispose()

  const gap = readLog(dir2).find((l) => l.event === 'channel-gap')
  assert.ok(gap, '看不见 inbox 时必须记 channel-gap（这是事件改名唯一的线索）')
  assert.equal(gap.missing, 'event-inbox')
  assert.equal(gap.sawInbox, 0)
  assert.equal(gap.freshUserMessages, 2)
})

test('插件不覆盖 20_state/state.json（那是遗忘脚本的地盘）', () => {
  const dir = makeMemory()
  const design = { 'M-1': { S: 13.2, D: 0.35, r: 1, lc: 0, ll: '2026-11-30', st: 'active', merged_into: null } }
  writeFileSync(join(dir, '20_state/state.json'), JSON.stringify(design))

  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  ctx.emit('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '台风天' }], source: { kind: 'user' } },
  })
  ctx.render('s1')
  ctx.dispose()

  assert.deepEqual(JSON.parse(readFileSync(join(dir, '20_state/state.json'), 'utf8')), design)
  assert.equal(existsSync(join(dir, '20_state/inj10.json')), true)
})

test('子 agent 不入档、不注入（工具人不是她）', async () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })

  ctx.emit('session/event', { id: 'sub-1', header: { delegationDepth: 1 } }, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    surfaceOp: 'append',
    data: { message: { id: 'm-sub', role: 'assistant', content: [{ type: 'text', text: '工具输出' }], source: { kind: 'model' } } },
  })
  await ctx.fishMemory.archive?.idle()
  const archiveDir = join(dir, '10_archive/messages')
  assert.equal(existsSync(archiveDir) ? readdirSync(archiveDir).length : 0, 0)
  assert.equal(ctx.render('sub-1', { depth: 1 }), '')
  ctx.dispose()
})

test('目录解析：会话 cwd 优先，进程 cwd 只作兜底', () => {
  // 不要写死 `D:/ws` 这类盘符路径：在 Linux 上 `isAbsolute('D:/mem')` 是 false，
  // 代码会走 resolve() 分支，这条断言就只在 Windows 通过（CI 的 ubuntu 作业抓到的正是它）。
  const ws = resolve('/', 'ws')
  const profile = resolve('/', 'profile')
  const mem = resolve('/', 'mem')
  assert.equal(resolveMemoryDir({ sessionCwd: ws, cwd: profile }), join(ws, 'fish-memory'))
  assert.equal(resolveMemoryDir({ cwd: profile }), join(profile, 'fish-memory'))
  assert.equal(resolveMemoryDir({ explicit: mem, sessionCwd: ws }), mem, '显式绝对路径原样返回')
  assert.equal(resolveMemoryDir({ explicit: 'mem', sessionCwd: ws }), resolve(ws, 'mem'), '相对 explicit 挂到 base 上')
})

test('apply：没配 memoryDir 时用会话 cwd，不用进程 cwd（回归）', () => {
  const ws = tmp()
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.emit('agent/inbox/inserted', {
    agent: { id: 's1', session: { header: { cwd: ws } } },
    message: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } },
  })
  assert.equal(ctx.fishMemory.dir, join(ws, 'fish-memory'))
  ctx.dispose()
})

test('多工作区：会话 cwd 变了就换库，不再把 B 的对话写进 A（v0.4.3）', () => {
  const wsA = tmp()
  const wsB = tmp()
  const ctx = fakeCtx()
  apply(ctx, {})

  const say = (id, cwd, text) => {
    ctx.emit('agent/inbox/inserted', {
      agent: { id, session: { header: { cwd } } },
      message: { id: `m-${id}-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    })
    ctx.emit(
      'session/event',
      { id, header: { cwd } },
      {
        type: 'user/message',
        seq: 1,
        time: Date.now(),
        surfaceOp: 'append',
        data: { id: `m-${id}-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      },
    )
  }

  say('sA', wsA, '我在 A 里说的话')
  assert.equal(ctx.fishMemory.dir, join(wsA, 'fish-memory'))

  say('sB', wsB, '我在 B 里说的话')
  assert.equal(ctx.fishMemory.dir, join(wsB, 'fish-memory'), '切到 B 的库')

  ctx.dispose()

  const aSessions = readdirSync(join(wsA, 'fish-memory', '20_state/sessions'))
  const bSessions = readdirSync(join(wsB, 'fish-memory', '20_state/sessions'))
  assert.ok(aSessions.includes('sA.json'), `A 库里有 ${aSessions}`)
  assert.ok(!aSessions.includes('sB.json'), 'B 的会话不能落到 A 库')
  assert.ok(bSessions.includes('sB.json'), `B 库里有 ${bSessions}`)
})

test('工作记忆不被宿主上下文污染（tail 只收真人真模型）', () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const session = { id: 'sess', header: { cwd: dir } }
  const ev = (seq, kind, text) => ({
    type: 'user/message',
    seq,
    time: Date.now(),
    surfaceOp: 'append',
    data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
  })

  ctx.emit('session/event', session, ev(9, 'user', '我在成都'))
  ctx.emit('session/event', session, ev(10, 'runtime-context', 'Current runtime context. This snapshot supersedes'))
  ctx.emit('session/event', session, ev(11, 'time-context', 'Time sampled while preparing turn 4'))
  ctx.emit('session/event', session, ev(12, 'user-approval', 'The approval policy changed'))
  ctx.dispose()

  const s = JSON.parse(readFileSync(join(dir, '20_state/sessions/sess.json'), 'utf8'))
  assert.deepEqual(s.tail.map((t) => t.text), ['我在成都'])
})

test('历史遗留清洗：tail 里的宿主上下文读出来就不见了', () => {
  const dir = makeMemory()
  mkdirSync(join(dir, '20_state/sessions'), { recursive: true })
  writeFileSync(
    join(dir, '20_state/sessions/dirty.json'),
    JSON.stringify({
      session_id: 'dirty',
      last_active: '2026-10-30T00:00:00.000Z',
      tail: [
        { role: 'user', text: '我在成都', ts: '2026-10-30T00:00:00.000Z' },
        { role: 'user', text: 'Current runtime context. This snapshot supersedes', ts: '2026-10-30T00:00:01.000Z' },
        { role: 'user', text: 'Time sampled while preparing turn 4', ts: '2026-10-30T00:00:02.000Z' },
      ],
      injected_work: false,
    }),
  )
  const store = new MemoryStore(dir)
  const s = store.session('dirty')
  assert.deepEqual(s.tail.map((m) => m.text), ['我在成都'])

  const text = renderWorkMemory(s, new Date('2026-10-30T12:00:00Z'))
  assert.doesNotMatch(text, /Current runtime context|Time sampled/)
  assert.match(text, /你：我在成都/)
})

test('配置 retrieval.weights 真的接到检索上：改权重 = 改注入结果（v0.5.9）', () => {
  const dir = makeMemory()

  // ① 默认权重：标题+标签都算，「台风那天」命中那条点
  const ctxDefault = fakeCtx()
  apply(ctxDefault, { memoryDir: dir })
  ctxDefault.emit('agent/inbox/inserted', {
    agent: { id: 'w-default' },
    message: { id: 'm-w1', role: 'user', content: [{ type: 'text', text: '台风那天你还记得吗' }], source: { kind: 'user' } },
  })
  ctxDefault.render('w-default')
  ctxDefault.dispose()

  // ② 只留 summary：同一条点只剩摘要里那个「台风」二字，过不了 0.8
  const ctxSummaryOnly = fakeCtx()
  apply(ctxSummaryOnly, { memoryDir: dir, retrieval: { weights: { title: 0, tags: 0, cluster: 0, summary: 1 } } })
  ctxSummaryOnly.emit('agent/inbox/inserted', {
    agent: { id: 'w-summary' },
    message: { id: 'm-w2', role: 'user', content: [{ type: 'text', text: '台风那天你还记得吗' }], source: { kind: 'user' } },
  })
  ctxSummaryOnly.render('w-summary')
  ctxSummaryOnly.dispose()

  // ③ 四个字段全 0：等于关掉检索，配置层拒绝，退回默认（还是命中）
  const ctxZero = fakeCtx()
  apply(ctxZero, { memoryDir: dir, retrieval: { weights: { title: 0, tags: 0, cluster: 0, summary: 0 } } })
  ctxZero.emit('agent/inbox/inserted', {
    agent: { id: 'w-zero' },
    message: { id: 'm-w3', role: 'user', content: [{ type: 'text', text: '台风那天你还记得吗' }], source: { kind: 'user' } },
  })
  ctxZero.render('w-zero')
  ctxZero.dispose()

  const logs = readFileSync(join(dir, '50_log/retrieval.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const bySession = Object.fromEntries(logs.map((l) => [l.session, l]))

  assert.deepEqual(bySession['w-default'].rendered, ['M-2026-10-28-001'], '默认权重应命中')
  assert.deepEqual(bySession['w-summary'].rendered, [], '只留 summary 时这条过不了门槛')
  assert.deepEqual(bySession['w-zero'].rendered, ['M-2026-10-28-001'], '全 0 被拒，按默认算')
  // 生效的权重逐项记在日志里：改配置没生效时，这里能看出用的是哪一组
  assert.deepEqual(bySession['w-summary'].weights, { title: 0, tags: 0, cluster: 0, summary: 1, unigram: 0.5 })
  assert.equal(bySession['w-default'].weights, undefined, '没配就不写，别把默认值伪装成用户配置')
})

test('apply：收消息 → 记档；注入包含核心层', async () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })

  const agent = { id: 'session-x' }
  ctx.emit('agent/inbox/inserted', {
    agent,
    message: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '台风那天你还记得吗' }], source: { kind: 'user' } },
  })
  const text = ctx.render('session-x')
  assert.match(text, /台风天看海/)
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].name, 'fish-remember')

  const log = readFileSync(join(dir, '50_log/retrieval.log'), 'utf8').trim().split('\n')
  assert.ok(log.length >= 1)
  const entry = JSON.parse(log[0])
  assert.equal(typeof entry.tokens, 'number')
  // v0.14.1：只记目录名，不写绝对路径（日志会随库被云盘带走，路径里有用户名）
  assert.equal(entry.lib, basename(dir))
  assert.equal(entry.dir, undefined, '绝对路径不该再进日志')
  assert.deepEqual(entry.rendered, ['M-2026-10-28-001'])

  ctx.emit('session/event', { id: 'session-x' }, {
    type: 'assistant/message',
    seq: 3,
    time: Date.now(),
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: '记得，那天风很大。' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
  })
  await ctx.fishMemory.archive.idle()
  const files = readdirSync(join(dir, '10_archive/messages'))
  const records = files.flatMap((f) => readFileSync(join(dir, '10_archive/messages', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l))
  assert.equal(records.length, 1)
  assert.equal(records[0].role, 'assistant')
  assert.equal(records[0].text, '记得，那天风很大。')
  ctx.dispose()
})

// 自述提醒依赖"本月有素材"。fixture 里的日期是写死的，**跨月就会假失败**
// （2026-11-01 实测踩到：points 是 10-28，today 已进 11 月 → 一条都不算本月素材）。
// 所以测试要自己把它改到本月，而不是让测试依赖跑的那一天。
const thisMonth = () => localDay(new Date()).slice(0, 7)
const retagToThisMonth = (dir, id) => {
  const p = join(dir, '30_points', `${id}.md`)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^date:.*$/m, `date: ${thisMonth()}-01`), 'utf8')
}

test('自述提醒（端到端）：有素材才提、指向闸门、一天只提一次', () => {
  const userMsg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

  // ① 本月有 boundary（M-003 是 salience 5 / boundary）→ 回合结束该提醒，且文案指向闸门
  const dir = makeMemory()
  retagToThisMonth(dir, 'M-003')
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const agent = { id: 'self-e2e', session: { header: { cwd: dir } } }
  ctx.emit('agent/inbox/inserted', { agent, message: userMsg('m-1', '在吗') })
  ctx.emit('agent/turn-stopping', { agent })
  const first = ctx.render('self-e2e', { cwd: dir })
  assert.match(first, /<!-- 自述提醒 -->/, '本月有 boundary 素材，该提醒')
  assert.match(first, /memory self-pack/, '要先说素材包怎么来')
  assert.match(first, /self-promote/, '要教她走闸门')
  assert.match(first, /和核心层对照/, '五节最后一节')
  assert.doesNotMatch(first, /放 `15_self\/YYYY-MM\.md`/, '不许指回绕过闸门的老路径')

  // ② 同一天只提一次
  ctx.emit('agent/inbox/inserted', { agent, message: userMsg('m-2', '今天好累') })
  ctx.emit('agent/turn-stopping', { agent })
  const second = ctx.render('self-e2e', { cwd: dir })
  assert.doesNotMatch(second, /<!-- 自述提醒 -->/, '一天只提一次')
  ctx.dispose()

  // ③ 只有日常素材（event，salience 2/4）→ 不催
  const dir2 = makeMemory()
  unlinkSync(join(dir2, '30_points/M-003.md'))
  const ctx2 = fakeCtx()
  apply(ctx2, { memoryDir: dir2 })
  const agent2 = { id: 'self-e2e-2', session: { header: { cwd: dir2 } } }
  ctx2.emit('agent/inbox/inserted', { agent: agent2, message: userMsg('m-1', '在吗') })
  ctx2.emit('agent/turn-stopping', { agent: agent2 })
  const third = ctx2.render('self-e2e-2', { cwd: dir2 })
  assert.doesNotMatch(third, /<!-- 自述提醒 -->/, '只有日常事，不该催她写自述')
  ctx2.dispose()
})

// ── 上下文压力：两个阈值（v0.20.0）────────────────────────────

const withTokenMeter = (ctx, total, window = 1000) => {
  ctx.get = (n) => (n === 'tokenMeter' ? { measure: () => ({ totalTokens: total }) } : undefined)
  return { id: null, session: { header: {}, requestContext: () => ({ contextWindow: window }) } }
}

const userMsgOf = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

test('压力到 80%：注入里明说"该开新会话"，并先把交接包写出来（不谎称）', () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const agent = withTokenMeter(ctx, 850)
  agent.id = 'p-85'
  agent.session.header.cwd = dir

  ctx.emit('agent/inbox/inserted', { agent, message: userMsgOf('m-1', '在吗') })
  ctx.emit('agent/turn-stopping', { agent })

  assert.ok(existsSync(join(dir, '20_state/handoff.json')), '到换窗线要先把「接着聊」包写出来')
  const text = ctx.render('p-85', { cwd: dir })
  assert.match(text, /开一个新会话/)
  assert.match(text, /handoff\.json/, '包写了就敢说"包已经写好"')
  assert.match(text, /85%/)
  ctx.dispose()
})

test('压力 72%：只提醒去压，不喊换窗（阈值分开的意义）', () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const agent = withTokenMeter(ctx, 720)
  agent.id = 'p-72'
  agent.session.header.cwd = dir

  ctx.emit('agent/inbox/inserted', { agent, message: userMsgOf('m-1', '在吗') })
  ctx.emit('agent/turn-stopping', { agent })

  assert.equal(existsSync(join(dir, '20_state/handoff.json')), false, '还没到换窗线，不该写交接包')
  const text = ctx.render('p-72', { cwd: dir })
  assert.match(text, /72%/)
  assert.match(text, /先压/)
  assert.doesNotMatch(text, /开一个新会话/)
  ctx.dispose()
})
