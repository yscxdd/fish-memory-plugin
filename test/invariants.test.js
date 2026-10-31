// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 契约 §11 的「不变量」逐条变成断言（v0.20.2）。
 *
 * 为什么单独一个文件：`audit`（13 项）和 `selfcheck`（12 闸门）验的是**库的现状**，
 * 而这个文件验的是**设计承诺**——每一条都对应契约里的一句话。以前它们散落在各测试里，
 * 有的有、有的没有（"旁白不进事实段"根本没有测试），契约和代码就有机会悄悄漂移。
 *
 * 做法借鉴《性格与记忆情绪系统 v2》的 doctor/doctor-contract 思路：
 * **先写死"应该成立的那句话"，再写怎么验**；没实现的不许静默跳过，要 `todo` 标出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter, extractText, verifyChain } from '../lib/archive.js'
import { applyForget, planForget } from '../lib/forget.js'
import {
  DEFAULT_BUDGET,
  INJECT_HARD_CAP,
  assemble,
  depthOf,
  injectBudgetTotal,
  isProtected,
} from '../lib/render.js'
import { pickByEvent } from '../lib/retrieve.js'
import { MemoryStore } from '../lib/store.js'
import { audit, buildIndex, validatePoint } from '../lib/toolkit.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-inv-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '20_index', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n', 'utf8')
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

const P = (over = {}) => ({
  id: 'M-2026-10-30-001',
  title: '台风天看海',
  quote: '这种天气看海才有意思',
  quote_by: 'him',
  date: '2026-10-30',
  salience: 4,
  type: 'event',
  cluster: '出行',
  event: null,
  tags: [],
  status: 'active',
  contradicts: [],
  links: [],
  source: ['msg-1'],
  summary: '台风夜去海边。',
  ...over,
})

const ARCHIVE = { byId: new Map([['msg-1', { id: 'msg-1', text: '这种天气看海才有意思' }]]) }

// ── #1 档案只追加（例外只有 erase / reset --all）────────────────
test('#1 档案只追加：换掉一行的正文，链校验必须失败', async () => {
  const dir = fixture()
  const t0 = new Date('2026-10-30T03:00:00Z').getTime()
  const w = new ArchiveWriter(dir)
  for (let i = 1; i <= 3; i++) {
    await w.handle('s1', {
      type: 'user/message',
      seq: i,
      time: t0 + i,
      surfaceOp: 'append',
      data: { id: `m-${i}00`, role: 'user', content: [{ type: 'text', text: `第 ${i} 句` }], source: { kind: 'user' } },
    })
  }
  await w.idle()

  const file = join(dir, '10_archive', 'messages', '2026-10-30.jsonl')
  const before = verifyChain(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.equal(before.ok, true, '原样应当是合法链')

  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const rec = JSON.parse(lines[1])
  rec.text = '被改过的一句'
  lines[1] = JSON.stringify(rec)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')

  const after = verifyChain(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.equal(after.ok, false, '正文被换掉必须校验失败（接受追加 ≠ 接受改写）')
})

// ── #2 source 必须指向存在的 msg_id ─────────────────────────────
test('#2 source 必须存在：指向不存在的 msg_id 是硬错误', () => {
  const bad = validatePoint(P({ source: ['msg-不存在'] }), { archive: ARCHIVE, points: [] })
  assert.ok(
    bad.errors.some((e) => /档案/.test(e.message) || /source/.test(e.field)),
    `应当报 source 找不到，实际 ${JSON.stringify(bad.errors)}`,
  )
  const ok = validatePoint(P(), { archive: ARCHIVE, points: [] })
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors))
})

// ── #3 同一个 msgid_plat 只入库一次 ────────────────────────────
test('#3 幂等（实况）：同一 seq 只入库一次；同一 msgid_plat 换个 seq 会进两行，但审计必须报出来', async () => {
  const dir = fixture()
  const t0 = new Date('2026-10-30T03:00:00Z').getTime()
  const ev = (seq) => ({
    type: 'user/message',
    seq,
    time: t0 + seq,
    surfaceOp: 'append',
    data: { id: 'm-same', role: 'user', content: [{ type: 'text', text: '同一句' }], source: { kind: 'user' } },
  })
  const w = new ArchiveWriter(dir)
  await w.handle('s1', ev(1))
  await w.handle('s1', ev(1)) // 同 seq（宿主机重投）→ 必须丢掉
  await w.idle()

  const file = join(dir, '10_archive', 'messages', '2026-10-30.jsonl')
  let rows = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(rows.length, 1, `同一 seq 只能进 1 行，实际 ${rows.length} 行`)

  // 实况：去重键是「每会话 seq」，不是 msgid_plat。换 seq 重投会进两行——
  // 这**不丢数据**（宁可重，不可丢），但审计要能看见，由人决定。
  await w.handle('s1', ev(2))
  await w.idle()
  rows = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(rows.length, 2, '换 seq 重投会进两行（append-only 的取舍）')

  const report = audit(dir)
  const dup = report.checks.find((c) => c.id === 'duplicate_msgid')
  assert.ok(dup, '审计要有 duplicate_msgid 这一项')
  assert.equal(dup.ok, false, `重复的 msgid_plat 要报出来：${JSON.stringify(dup)}`)
  assert.equal(dup.duplicates.length, 1)
})

// ── #4 idx / sum 永远可由 full 重建 ────────────────────────────
test('#4 可重建：只给记忆点，索引能重新算出来（不需要任何历史）', () => {
  const built = buildIndex([P({ salience: 2 }), P({ id: 'M-2', title: '他讨厌香菜', cluster: '偏好' })], {
    now: new Date('2026-10-30T00:00:00Z'),
  })
  const files = Object.keys(built)
  for (const f of ['all.idx.jsonl', 'all.sum.jsonl', 'recent.idx.jsonl', 'clusters.md']) {
    assert.ok(files.includes(f), `重建结果里应当有 ${f}，实际 ${files.join(', ')}`)
  }
  assert.equal(typeof built['clusters.md'], 'string')
})

// ── #5 底线类永不降级 ──────────────────────────────────────────
test('#5 底线类永不降级：boundary / promise / pinned 恒为 full', () => {
  for (const p of [
    P({ type: 'boundary', salience: 1 }),
    P({ type: 'promise', salience: 1 }),
    P({ type: 'event', salience: 1, pinned: true }),
  ]) {
    assert.equal(isProtected(p), true, `${p.type} 应当是保护类`)
    assert.equal(depthOf(p), 'full', `${p.type} 不许降到 sum/idx`)
  }
})

// ── #6 注入包总预算 ≤ 硬上限 ───────────────────────────────────
test('#6 预算：core+index+body 合计 ≤ 上限，且默认就是顶格', () => {
  const total = injectBudgetTotal(DEFAULT_BUDGET)
  assert.ok(total != null, '默认预算必须可核算')
  assert.ok(total <= INJECT_HARD_CAP, `合计 ${total} 超过上限 ${INJECT_HARD_CAP}`)
  assert.equal(total, INJECT_HARD_CAP, '默认配置正好顶格（改预算要同时改 contract 与 budget.test）')
})

// ── #7 QUOTE 逐字 ──────────────────────────────────────────────
test('#7 QUOTE 逐字：原话在来源消息里找不到就报错，找到了就通过', () => {
  const notFound = validatePoint(P({ quote: '这句话根本没说过' }), { archive: ARCHIVE, points: [] })
  assert.ok(notFound.errors.some((e) => e.field === 'quote'), JSON.stringify(notFound.errors))
  const found = validatePoint(P(), { archive: ARCHIVE, points: [] })
  assert.equal(found.errors.filter((e) => e.field === 'quote').length, 0)
})

// ── #8 旁白不进事实段 ──────────────────────────────────────────
test('#8 旁白不进事实段：只取文字块，工具调用/旁白不算她说过的话', () => {
  // 现状：extractText 只拼 type:'text' 的块，其它块（工具调用、thinking）被跳过。
  // 这条以前没有测试，所以这里既验"只取 text"，也把边界写清楚。
  const text = extractText({
    role: 'assistant',
    content: [
      { type: 'text', text: '她说的那句' },
      { type: 'tool_use', name: 'read', input: { path: 'x' } },
      { type: 'thinking', thinking: '这是旁白/内心，不该进事实段' },
    ],
  })
  assert.equal(text, '她说的那句')
})

// ── #9 单次注入不含同一 event 的两个点 ─────────────────────────
test('#9 同一 event 只留一条：pickByEvent 去重', () => {
  const ranked = [
    { point: { id: 'A', event: 'e1' }, score: 0.9 },
    { point: { id: 'B', event: 'e1' }, score: 0.8 },
    { point: { id: 'C', event: 'e2' }, score: 0.7 },
  ]
  const ids = pickByEvent(ranked, 3).map((p) => p.id)
  assert.deepEqual(ids, ['A', 'C'], `同一 event 只能留一条，实际 ${ids.join(',')}`)
})

// ── #10 遗忘必留墓碑且含数值 ───────────────────────────────────
test('#10 遗忘留痕：掉级写进 eviction.log，且带数值（不是一句话）', () => {
  const dir = fixture()
  const old = '2026-01-01'
  writeFileSync(
    join(dir, '30_points/M-old.md'),
    `---
id: M-old
title: 很久以前的事
quote: null
date: ${old}
salience: 1
type: event
cluster: 测试
event: null
tags: []
status: active
source: []
links: []
---

<!-- SUM -->
很久以前。
<!-- /SUM -->
`,
    'utf8',
  )
  const now = new Date('2026-11-01T00:00:00Z')
  const { plan, state } = planForget(dir, { now })
  assert.ok(plan.length > 0, '一个十个月没提起的低权重点应当进计划')
  applyForget(dir, { now, plan, state })

  const log = readFileSync(join(dir, '50_log', 'eviction.log'), 'utf8').trim().split('\n')
  assert.ok(log.length > 0, '必须留墓碑')
  const row = JSON.parse(log[0])
  assert.ok(('point' in row || 'id' in row) && ('S' in row || 'R' in row), `墓碑里要有 id 与数值：${log[0]}`)
})

// ── #11 临时影响不写回持久层（v0.20.2 新增）────────────────────
test('#11 临时态不写回：注入一次不会改动 00_core / 20_state 的任何字节', () => {
  const dir = fixture()
  const store = new MemoryStore(dir)
  const snapshot = () => {
    const out = {}
    for (const rel of ['00_core/soul.md', '20_state/state.json']) out[rel] = readFileSync(join(dir, rel), 'utf8')
    return out
  }
  const before = snapshot()

  const r = assemble({
    store,
    query: '今天有点累',
    sessionId: '',
    retrieve: () => [P({ emotion: { user: { valence: -0.8, arousal: 0.7 }, self: null } })],
  })
  assert.ok(typeof r.text === 'string')
  assert.deepEqual(snapshot(), before, '渲染/注入绝不能顺手写回核心层或状态（临时态只作用于当轮）')
  store.dispose()
})
