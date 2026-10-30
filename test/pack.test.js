// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 迁移包测试：打包只含不可再生层；解包先验哈希、再重建索引。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { packMemory, unpackMemory } from '../lib/pack.js'
import { audit } from '../lib/toolkit.js'

const SOUL = `# SOUL

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议
`

const POINT = `---
id: M-2026-10-20-001
title: 他讨厌香菜
quote: 我讨厌香菜
quote_by: him
date: 2026-10-20
salience: 3
type: preference
cluster: 偏好
event: null
tags: [香菜]
status: active
source: [msg-1]
links: []
---

<!-- SUM -->
他说他讨厌香菜。
<!-- /SUM -->
`

function source() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-pack-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), SOUL)
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points/M-1.md'), POINT)
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  writeFileSync(
    join(dir, '10_archive/messages/2026-10-20.jsonl'),
    JSON.stringify({ id: 'msg-1', msgid_plat: 'p1', seq: 1, ts: '2026-10-20T02:00:00.000Z', role: 'user', source_kind: 'user', text: '我讨厌香菜', session: 's1' }) + '\n',
  )
  mkdirSync(join(dir, '20_index'), { recursive: true })
  writeFileSync(join(dir, '20_index/all.idx.jsonl'), 'junk\n')
  mkdirSync(join(dir, '_samples'), { recursive: true })
  writeFileSync(join(dir, '_samples/x.md'), 'junk')
  return dir
}

test('pack：只打不可再生层，排除索引与样例，带 MANIFEST', () => {
  const src = source()
  const dest = join(mkdtempSync(join(tmpdir(), 'fishmem-packout-')), 'pkg')
  const r = packMemory(src, dest)
  assert.ok(r.files >= 3)
  assert.equal(existsSync(join(dest, 'MANIFEST.json')), true)
  const manifest = JSON.parse(readFileSync(join(dest, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifest.format, 'fish-memory-pack')
  const paths = manifest.files.map((f) => f.path)
  assert.ok(paths.includes('00_core/soul.md'))
  assert.ok(paths.includes('30_points/M-1.md'))
  assert.ok(!paths.some((p) => p.startsWith('20_index/')))
  assert.ok(!paths.some((p) => p.startsWith('_samples/')))
})

test('unpack：校验哈希、重建索引，迁到新目录后审计仍通过', () => {
  const src = source()
  const base = mkdtempSync(join(tmpdir(), 'fishmem-unpack-'))
  const pkg = join(base, 'pkg')
  const restored = join(base, 'restored')
  packMemory(src, pkg)
  const r = unpackMemory(pkg, restored)
  assert.equal(r.verified, r.files)
  assert.equal(existsSync(join(restored, '20_index/all.idx.jsonl')), true)

  const report = audit(restored)
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)))
})

test('unpack：包被改过就拒绝，目标非空也拒绝', () => {
  const src = source()
  const base = mkdtempSync(join(tmpdir(), 'fishmem-tamper-'))
  const pkg = join(base, 'pkg')
  packMemory(src, pkg)
  writeFileSync(join(pkg, '00_core/soul.md'), '被改过')

  assert.throws(() => unpackMemory(pkg, join(base, 'a')), /哈希不符/)

  const pkg2 = join(base, 'pkg2')
  packMemory(src, pkg2)
  const nonEmpty = join(base, 'nonempty')
  mkdirSync(nonEmpty)
  writeFileSync(join(nonEmpty, 'x.txt'), 'x')
  assert.throws(() => unpackMemory(pkg2, nonEmpty), /目标目录非空/)
})
