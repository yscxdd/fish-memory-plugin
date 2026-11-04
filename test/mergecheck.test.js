// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * merge-check（v0.51.0）——只读诊断，两个库差在哪。
 *
 * 为什么不做双向同步（写进测试，免得以后被"顺手"加上）：
 * 档案是 append-only + prev/hash 链、按天分文件；两边各写一天 → 同一个头分叉出两条链，
 * 合起来 verify 直接报坏链。点文件同名即同一件事 → 静默覆盖。所以这里只报不合并。
 *
 * 钉住：
 *   ① **不写一个字节**：跑完两边目录的 mtime 和文件数都不变；
 *   ② 天文件哈希不同 = 链分叉（这是最危险的一类差异）；
 *   ③ 同 id 点内容不同 = 冲突；
 *   ④ 核心层两边都改过 = 必须人工选，不自动裁决；
 *   ⑤ 结论里必须写"哪边新"和"别合并，选一台当主库"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeCheck } from '../lib/mergecheck.js'

function lib(name) {
  const dir = mkdtempSync(join(tmpdir(), `fishmem-mc-${name}-`))
  for (const d of ['10_archive/messages', '20_state', '30_points', '00_core', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 同一个她\n', 'utf8')
  return dir
}

function msg(dir, file, id, ts, text, role = 'user') {
  const p = join(dir, '10_archive/messages', file)
  const line = JSON.stringify({ id, seq: 1, session: 's1', role, ts, text }) + '\n'
  try {
    writeFileSync(p, line, { flag: 'a' })
  } catch {
    writeFileSync(p, line, 'utf8')
  }
}

function point(dir, id, title, summary) {
  writeFileSync(
    join(dir, '30_points', `${id}.md`),
    ['---', `id: ${id}`, `title: ${title}`, 'quote: null', 'date: 2026-11-01', 'salience: 3', 'type: event', 'cluster: 日常', 'status: active', 'source: []', 'links: []', '---', '', '<!-- SUM -->', summary, '<!-- /SUM -->'].join('\n'),
    'utf8',
  )
}

function snapshot(dir) {
  const out = {}
  const walk = (d, base = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = base ? base + '/' + e.name : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else out[rel] = statSync(join(d, e.name)).mtimeMs
    }
  }
  walk(dir)
  return out
}

test('两边一样 → 无冲突，谁都不新', () => {
  const a = lib('a')
  const b = lib('b')
  msg(a, 's1.jsonl', 'm1', '2026-11-01T10:00:00Z', '你好')
  msg(b, 's1.jsonl', 'm1', '2026-11-01T10:00:00Z', '你好')
  const r = mergeCheck(a, b)
  assert.equal(r.archive.onlyA, 0)
  assert.equal(r.archive.onlyB, 0)
  assert.equal(r.newer, 'same')
  assert.equal(r.safe, true)
})

test('只在一边有的消息能数出来，并说哪边新', () => {
  const a = lib('a')
  const b = lib('b')
  msg(a, 's1.jsonl', 'm1', '2026-11-01T10:00:00Z', '你好')
  msg(b, 's1.jsonl', 'm1', '2026-11-01T10:00:00Z', '你好')
  msg(a, 's1.jsonl', 'm2', '2026-11-02T10:00:00Z', '只有 A 有')
  const r = mergeCheck(a, b)
  assert.equal(r.archive.onlyA, 1)
  assert.equal(r.archive.onlyB, 0)
  assert.equal(r.newer, 'A', 'A 的最后一条更新')
})

test('天文件两边都改过 → 链分叉，判为危险', () => {
  const a = lib('a')
  const b = lib('b')
  msg(a, '2026-11-01.jsonl', 'm1', '2026-11-01T10:00:00Z', 'A 说的')
  msg(b, '2026-11-01.jsonl', 'm2', '2026-11-01T11:00:00Z', 'B 说的')
  const r = mergeCheck(a, b)
  assert.equal(r.archive.forks.length, 1)
  assert.equal(r.safe, false)
  assert.match(r.dangers.join('\n'), /档案链已经分叉/)
})

test('同一个点的内容不同 → 冲突（静默覆盖的前兆）', () => {
  const a = lib('a')
  const b = lib('b')
  point(a, 'P1', '他说要去游泳', '周末去游泳')
  point(b, 'P1', '他说要去游泳', '改成了去爬山')
  const r = mergeCheck(a, b)
  assert.equal(r.points.differ, 1)
  assert.equal(r.safe, false)
  assert.match(r.dangers.join('\n'), /静默覆盖/)
})

test('核心层两边都改过 → 不自动挑一个', () => {
  const a = lib('a')
  const b = lib('b')
  writeFileSync(join(a, '00_core/soul.md'), '# SOUL\n\n- A 版\n', 'utf8')
  writeFileSync(join(b, '00_core/soul.md'), '# SOUL\n\n- B 版\n', 'utf8')
  const r = mergeCheck(a, b)
  assert.deepEqual(r.core.differ, ['soul.md'])
  assert.match(r.dangers.join('\n'), /不能自动挑一个/)
})

test('只读：跑完两边文件数与 mtime 都不变', () => {
  const a = lib('a')
  const b = lib('b')
  msg(a, 's1.jsonl', 'm1', '2026-11-01T10:00:00Z', '你好')
  point(a, 'P1', 't', 's')
  point(b, 'P1', 't', 's2')
  const beforeA = snapshot(a)
  const beforeB = snapshot(b)
  mergeCheck(a, b)
  assert.deepEqual(snapshot(a), beforeA, 'A 不该被写')
  assert.deepEqual(snapshot(b), beforeB, 'B 不该被写')
})

test('路径不存在 → 抛错（不静默当空库）', () => {
  const a = lib('a')
  assert.throws(() => mergeCheck(a, join(a, '不存在')), /路径不存在/)
})
