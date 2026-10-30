// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * v0.14.0：三件事的测试
 *   A1 冲突可见：`contradicts` 不再只是"字段存在"，而是出现在注入里、审计里
 *   A2 坏点不静默：读不出来的点文件必须报出来（mem0 的教训：静默 [] 分不清"没有"和"坏了"）
 *   A3 事实失效：`invalid_at` 标记不再成立——标记不是删除，boundary/promise 永不失效
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assemble, renderPoint } from '../lib/render.js'
import { MemoryStore } from '../lib/store.js'
import { audit, scanPointFiles, validatePoint } from '../lib/toolkit.js'
import { isInvalidated } from '../lib/util.js'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))

/** 造一条点（可覆写任意 front matter 字段） */
function point({ id = 'M-2026-10-28-001', title = '台风天看海', date = '2026-10-28', type = 'event', status = 'active', salience = 4, contradicts = [], invalid_at = null, quote = '这种天气看海才有意思' } = {}) {
  const extra = []
  if (invalid_at) extra.push(`invalid_at: ${invalid_at}`)
  return `---
id: ${id}
title: ${title}
quote: ${quote}
quote_by: him
date: ${date}
salience: ${salience}
type: ${type}
cluster: 出行
event: null
tags: [海边]
status: ${status}
contradicts: [${contradicts.join(', ')}]
source: [msg-1]
links: []
${extra.join('\n')}
---

<!-- SUM -->
台风夜去看海。
<!-- /SUM -->

## 发生了什么

[事实] 台风夜去了海边。
`
}

function makeLib(points = []) {
  const dir = tmp('fishmem-inv-')
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '40_pending'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成"AI"讨论\n- 我绝不会说"作为一个AI"\n- 我不会给人生建议\n')
  writeFileSync(join(dir, '00_core/rules.md'), '# 硬规则\n\n1. 找不到就说找不到。\n')
  writeFileSync(join(dir, '00_core/relation_status.json'), JSON.stringify({ phase: '常态' }))
  for (const p of points) writeFileSync(join(dir, '30_points', `${p.id}.md`), p.raw)
  return dir
}

// ── A3 · isInvalidated 语义 ────────────────────────────────────

test('失效判断：过去=失效；未来/null/坏日期=不失效（老点无字段）', () => {
  const now = new Date('2026-10-31T12:00:00+08:00')
  assert.equal(isInvalidated({ invalid_at: '2026-10-30' }, now), true)
  assert.equal(isInvalidated({ invalidAt: '2026-10-30' }, now), true, 'store 里是 camelCase')
  assert.equal(isInvalidated({ invalid_at: '2026-12-01' }, now), false)
  assert.equal(isInvalidated({}, now), false, '没写 = 仍成立（老点不迁移）')
  assert.equal(isInvalidated({ invalid_at: null }, now), false)
  assert.equal(isInvalidated({ invalid_at: '不是日期' }, now), false, '写坏了当仍有效，校验会另报错')
})

test('失效规则：boundary / promise 不许写 invalid_at（soft deadlines 不算失效）', () => {
  for (const type of ['boundary', 'promise']) {
    const v = validatePoint({ ...basePoint(), type, invalid_at: '2026-10-30' }, { archive: { byId: new Map([['msg-1', { id: 'msg-1', text: '这种天气看海才有意思' }]]) }, points: [] })
    assert.ok(v.errors.some((e) => e.field === 'invalid_at' && /不许写/.test(e.message)), `${type}: ${JSON.stringify(v.errors)}`)
  }
  const ok = validatePoint({ ...basePoint(), type: 'preference', invalid_at: '2026-10-30' }, { archive: { byId: new Map([['msg-1', { id: 'msg-1', text: '这种天气看海才有意思' }]]) }, points: [] })
  assert.equal(ok.errors.filter((e) => e.field === 'invalid_at').length, 0, JSON.stringify(ok.errors))
})

function basePoint(over = {}) {
  return {
    id: 'M-2026-10-28-001',
    title: '台风天看海',
    quote: '这种天气看海才有意思',
    quote_by: 'him',
    date: '2026-10-28',
    salience: 4,
    type: 'event',
    cluster: '出行',
    event: null,
    tags: [],
    status: 'active',
    contradicts: [],
    links: [],
    source: ['msg-1'],
    summary: '台风夜去看海。',
    facts: '',
    thoughts: '',
    ...over,
  }
}

// ── A2 · 坏点文件不许静默 ──────────────────────────────────────

test('扫点：front matter 坏掉的文件要报出来，README 不报（它不是点）', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-ok.md'), point())
  writeFileSync(join(dir, '30_points/M-broken.md'), '---\ntitle: 没 id 的坏文件\n---\n\n正文\n')
  writeFileSync(join(dir, '30_points/README.md'), '# 说明文件，没有 front matter\n')

  const { points, skipped } = scanPointFiles(dir, '30_points')
  assert.equal(points.length, 1, '好的点还在')
  assert.equal(points[0].id, 'M-2026-10-28-001')
  assert.equal(skipped.length, 1, `只有真的坏掉的那个要报：${JSON.stringify(skipped)}`)
  assert.match(skipped[0].file, /M-broken\.md/)
  assert.match(skipped[0].reason, /没有 id/)
})

test('扫点：store 也要记下跳过的文件（不再"单条坏了不影响全量"就算了）', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-good.md'), point())
  writeFileSync(join(dir, '30_points/M-broken.md'), '---\ntitle: 坏的\n---\n\nx\n')
  const store = new MemoryStore(dir)
  assert.equal(store.points().length, 1)
  assert.equal(store.skipped().length, 1, JSON.stringify(store.skipped()))
})

test('审计：读不出来的点进 unreadable，且**不改变**审计结论（不阻塞）；memory check 硬失败', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-good.md'), point())
  const before = audit(dir).passed

  writeFileSync(join(dir, '30_points/M-broken.md'), '---\ntitle: 坏的\n---\n\nx\n')
  const report = audit(dir)
  const un = report.checks.find((c) => c.id === 'unreadable')
  assert.equal(un.ok, false)
  assert.ok(un.files.some((f) => /M-broken/.test(f)), JSON.stringify(un))
  assert.equal(report.passed, before, '坏文件不该改变审计结论（它是报告项）')

  const r = spawnSync(process.execPath, [join(pkgRoot, 'scripts/memory.mjs'), 'check', '--dir', dir], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'check 必须失败')
  assert.match(r.stderr + r.stdout, /读不出来/)
})

// ── A1 · 冲突可见 ─────────────────────────────────────────────

test('冲突附注：渲染时把"和谁的哪句话冲突"摊开，且标明那是记录里的说法', () => {
  const a = basePoint({ id: 'M-2026-10-28-001', title: '他喝美式', contradicts: ['M-2026-10-30-002'] })
  const b = basePoint({ id: 'M-2026-10-30-002', title: '他改喝拿铁', date: '2026-10-30', summary: '十月起他只喝拿铁。' })
  const byId = new Map([[a.id, a], [b.id, b]])

  const withNote = renderPoint(a, 'sum', { byId })
  assert.match(withNote, /记录冲突/)
  assert.match(withNote, /他改喝拿铁/)
  assert.match(withNote, /那边的说法是/)
  assert.match(withNote, /十月起他只喝拿铁/)
  // 不传 byId 就没有附注（兼容旧调用）
  assert.doesNotMatch(renderPoint(a, 'sum'), /记录冲突/)
  // 指向已失效的点 → 不算冲突
  assert.doesNotMatch(renderPoint(a, 'sum', { byId: new Map([[a.id, a], [b.id, { ...b, invalid_at: '2026-10-30' }]]) }), /记录冲突/)
})

test('审计：未解决冲突要数出来（只报告，不裁决）', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-a.md'), point({ id: 'M-2026-10-28-001', contradicts: ['M-2026-10-30-002'] }))
  writeFileSync(join(dir, '30_points/M-b.md'), point({ id: 'M-2026-10-30-002', title: '他改喝拿铁', date: '2026-10-30', contradicts: [] }))
  const report = audit(dir)
  const c = report.checks.find((x) => x.id === 'open_conflicts')
  assert.equal(c.open, 1, JSON.stringify(c))
  assert.equal(c.ok, true, '冲突不是"错"，只是要人看见')
})

test('注入装配：被检索到且有冲突的点，正文里带一行冲突附注', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-a.md'), point({ id: 'M-2026-10-28-001', title: '他喝美式', contradicts: ['M-2026-10-30-002'] }))
  writeFileSync(join(dir, '30_points/M-b.md'), point({ id: 'M-2026-10-30-002', title: '他改喝拿铁', date: '2026-10-30' }))
  const store = new MemoryStore(dir)
  const picked = store.points()
  const r = assemble({
    store,
    query: '他喝什么',
    sessionId: '',
    retrieve: () => picked,
    budget: { core: 700, index: 700, body: 300, work: 350 },
  })
  assert.match(r.text, /记录冲突/)
  assert.match(r.text, /他改喝拿铁/)
})

// ── A3 · 失效的点不进注入 ─────────────────────────────────────

test('已失效的点：不进 store.points()，也不进注入（即使调用方硬塞）', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-old.md'), point({ id: 'M-2026-10-01-001', title: '他喝美式', date: '2026-10-01', invalid_at: '2026-10-20' }))
  writeFileSync(join(dir, '30_points/M-new.md'), point({ id: 'M-2026-10-30-002', title: '他改喝拿铁', date: '2026-10-30' }))

  const store = new MemoryStore(dir)
  const ids = store.points().map((p) => p.id)
  assert.deepEqual(ids, ['M-2026-10-30-002'], '失效的那条不该出现在检索池')

  // 审计仍看得见它（标记不是删除）
  const report = audit(dir)
  assert.equal(report.checks.find((c) => c.id === 'points').invalidated, 1, JSON.stringify(report.checks.find((c) => c.id === 'points')))

  // 就算 retrieve 硬塞回来，assemble 也不渲染
  const stale = { ...basePoint({ id: 'M-2026-10-01-001', title: '他喝美式', date: '2026-10-01' }), invalidAt: '2026-10-20' }
  const r = assemble({ store, query: '他喝什么', sessionId: '', retrieve: () => [stale], budget: { core: 700, index: 700, body: 300, work: 350 } })
  assert.doesNotMatch(r.text, /他喝美式/, '失效的点不许漏进注入')
})

// ── A3 · CLI ─────────────────────────────────────────────────

test('CLI invalidate：写进 front matter + 记日志；boundary/promise 拒绝', () => {
  const dir = makeLib()
  writeFileSync(join(dir, '30_points/M-2026-10-28-001.md'), point({ id: 'M-2026-10-28-001' }))

  const r = spawnSync(
    process.execPath,
    [join(pkgRoot, 'scripts/memory.mjs'), 'invalidate', 'M-2026-10-28-001', '--at', '2026-10-30', '--reason', '他改喝拿铁了', '--dir', dir],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const after = readFileSync(join(dir, '30_points/M-2026-10-28-001.md'), 'utf8')
  assert.match(after, /invalid_at: 2026-10-30/)
  assert.match(after, /invalid_reason: 他改喝拿铁了/)
  assert.match(readFileSync(join(dir, '50_log/invalidation.log'), 'utf8'), /M-2026-10-28-001/)

  // boundary 不许失效
  const dir2 = makeLib()
  writeFileSync(join(dir2, '30_points/M-2026-10-28-003.md'), point({ id: 'M-2026-10-28-003', type: 'boundary' }))
  const r2 = spawnSync(process.execPath, [join(pkgRoot, 'scripts/memory.mjs'), 'invalidate', 'M-2026-10-28-003', '--dir', dir2], { encoding: 'utf8' })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /不许失效/)
  assert.doesNotMatch(readFileSync(join(dir2, '30_points/M-2026-10-28-003.md'), 'utf8'), /invalid_at/)
  assert.equal(existsSync(join(dir2, '50_log/invalidation.log')), false)
})
