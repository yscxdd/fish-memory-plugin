// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initMemory } from '../lib/scaffold.js'
import { audit } from '../lib/toolkit.js'

test('init：建出骨架，索引为空，审计通过', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'fishmem-init-')), 'my-memory')
  const r = initMemory(target)
  assert.equal(r.dir, target)

  for (const f of ['00_core/soul.md', '00_core/user.md', '00_core/rules.md', 'MEMORY.md', '30_points', '20_index/all.idx.jsonl']) {
    assert.equal(existsSync(join(target, f)), true, f)
  }
  assert.match(readFileSync(join(target, '00_core/soul.md'), 'utf8'), /我绝不会说"作为一个AI"/)
  assert.equal(readFileSync(join(target, '20_index/all.idx.jsonl'), 'utf8'), '')

  const report = audit(target)
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)))
})

test('init：非空目录拒绝，不覆盖已有记忆', () => {
  const target = mkdtempSync(join(tmpdir(), 'fishmem-init2-'))
  writeFileSync(join(target, 'x.txt'), 'x')
  assert.throws(() => initMemory(target), /目标目录非空/)
})
