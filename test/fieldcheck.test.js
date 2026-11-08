// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * front matter 字段的接线检查（v0.76.0）。
 *
 * 起因：同一个错犯了四次——字段一头接上了、另一头没接：
 *   contradicts（有人读没人写）→ refuted_by（有人写没人读）→ scope（有人读没人写）
 *   → learned_at（有人读没人写）
 *
 * 这里钉的是**检查本身能抓错**，以及**仓库当前是干净的**。
 * 注意第①条：它不是"跑通就好"，而是"这条检查必须能在被人改坏时报红"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { POINT_FIELDS, checkFields, hasWriteSite, parsedFields, renderFields } from '../lib/fieldcheck.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一个假的插件根：只需要检查要扫的那几个文件 */
function fakeRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-fields-'))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }
  return dir
}

test('检查本身能抓「读了没人写」：解析器认了新字段，表里没登记', () => {
  const dir = fakeRoot({
    'lib/toolkit.js': "const x = { a: 1 }\n  foo: typeof meta.foo === 'string' ? meta.foo : null,\n",
  })
  const r = checkFields(dir)
  assert.deepEqual(r.unregistered, ['foo'], '新字段没登记必须报出来')
  assert.equal(r.total, 1)
})

test('检查本身能抓「写在没人读」：表里登记的写入方在代码里消失了', () => {
  const dir = fakeRoot({
    'lib/toolkit.js': "  invalid_at: typeof meta.invalid_at === 'string' ? meta.invalid_at : null,\n",
    'scripts/memory.mjs': '\n// 这里本来该有 invalid_at 的写入\n',
  })
  const r = checkFields(dir)
  assert.ok(
    r.deadWriters.some((x) => x.field === 'invalid_at'),
    `没找到死写入方：${JSON.stringify(r.deadWriters)}`,
  )
})

test('检查本身能抓孤儿：没人教也没人写（learned_at 在 v0.76 之前就是这样）', () => {
  const dir = fakeRoot({
    'lib/toolkit.js': "  ghost_field: typeof meta.ghost_field === 'string' ? meta.ghost_field : null,\n",
  })
  // ghost_field 表里没登记 → 先报 unregistered；把表临时补上再确认会落到 orphan
  const r1 = checkFields(dir)
  assert.deepEqual(r1.unregistered, ['ghost_field'])

  const had = POINT_FIELDS.ghost_field
  POINT_FIELDS.ghost_field = { writers: [], note: '测试用' }
  try {
    const r2 = checkFields(dir)
    assert.ok(
      r2.orphans.some((x) => x.field === 'ghost_field'),
      '没人教也没人写 → 必须是孤儿',
    )
    assert.match(renderFields(r2), /没人教、也没人写/)
  } finally {
    if (had === undefined) delete POINT_FIELDS.ghost_field
    else POINT_FIELDS.ghost_field = had
  }
})

test('表里每一项都必须有出处或明确标记 retro（不许悄悄加个字段进来）', () => {
  for (const [field, spec] of Object.entries(POINT_FIELDS)) {
    const ok = spec.taught || (spec.writers && spec.writers.length > 0) || spec.retro
    assert.ok(ok, `${field} 既没 taught、也没 writers、也没标 retro——加字段时必须选一种`)
    assert.ok(typeof spec.note === 'string' && spec.note.length > 0, `${field} 缺 note（要给三个月后的自己留话）`)
  }
})

test('解析器里的每个字段都在表里（否则新增字段会漏登记）', () => {
  const parsed = parsedFields(ROOT)
  const missing = parsed.filter((f) => !POINT_FIELDS[f])
  assert.deepEqual(missing, [], `lib/toolkit.js 解析了但表里没有：${missing.join(', ')}`)
})

test('仓库当前是干净的：没有孤儿、没有死写入方', () => {
  const r = checkFields(ROOT)
  assert.deepEqual(r.orphans, [], `孤儿字段：${JSON.stringify(r.orphans)}`)
  assert.deepEqual(r.deadWriters, [], `写入方不见了：${JSON.stringify(r.deadWriters)}`)
  assert.deepEqual(r.unregistered, [], `未登记的字段：${r.unregistered.join(', ')}`)
})

test('learned_at 现在有写入方了（memory promote）', () => {
  const site = hasWriteSite(ROOT, 'scripts/memory.mjs', 'learned_at')
  assert.ok(site, 'learned_at 必须有一个真的写入点，否则又回到"读了没人写"')
})
