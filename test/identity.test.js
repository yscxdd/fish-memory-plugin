// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QUESTIONS, RUBRIC, latestRun, renderSheet, startRun } from '../lib/identity.js'

test('20 题：四类各 5 题，题号连续', () => {
  assert.equal(QUESTIONS.length, 20)
  for (const cat of ['底线', '事实', '风格', '记忆']) {
    assert.equal(QUESTIONS.filter((q) => q.cat === cat).length, 5, cat)
  }
  assert.deepEqual(QUESTIONS.map((q) => q.id), Array.from({ length: 20 }, (_, i) => i + 1))
})

test('答题卡：20 个小题 + 评分规则', () => {
  const sheet = renderSheet('2026-10-30-01')
  assert.match(sheet, /# 同一性测试/)
  for (const q of QUESTIONS) assert.ok(sheet.includes(q.q), q.id)
  assert.equal((sheet.match(/### \d+\./g) || []).length, 20)
  assert.ok(sheet.includes(RUBRIC))
  assert.match(sheet, /一票否决/)
})

test('startRun：同一天第二次自动加序号，latestRun 指对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-id-'))
  const a = startRun(dir, { now: new Date('2026-10-30T01:00:00Z') })
  const b = startRun(dir, { now: new Date('2026-10-30T02:00:00Z') })
  assert.notEqual(a, b)
  assert.match(a, /2026-10-30-01$/)
  assert.match(b, /2026-10-30-02$/)
  assert.equal(latestRun(dir), b)
  assert.match(readFileSync(join(b, 'sheet.md'), 'utf8'), /同一性测试/)
  assert.equal(readdirSync(join(dir, '50_log/identity')).length, 2)
})
