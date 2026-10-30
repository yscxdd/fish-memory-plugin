// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderRecall, searchArchive } from '../lib/recall.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-recall-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const rows = [
    { id: 'm1', ts: '2026-10-28T10:00:00.000Z', role: 'user', source_kind: 'user', text: '台风那天我们去看海了，风很大' },
    { id: 'm2', ts: '2026-10-28T10:01:00.000Z', role: 'assistant', source_kind: 'model', text: '记得，你冻得一直抖还嘴硬' },
  ]
  writeFileSync(join(dir, '10_archive/messages/2026-10-28.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return dir
}

test('recall：命中原文，带 id 与片段', () => {
  const hits = searchArchive(fixture(), '看海')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'm1')
  assert.match(hits[0].excerpt, /看海/)
  assert.match(renderRecall(hits), /你：.*看海/)
})

test('recall：找不到就说没有，不编', () => {
  const hits = searchArchive(fixture(), '去冰岛')
  assert.deepEqual(hits, [])
  assert.match(renderRecall(hits), /没有这句话/)
})
