// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 对照跑分脚本的自检（v0.62.0）。
 *
 * 这个脚本依赖一个**已经删掉的第三方包**，所以它不能进 CI 的主链路；
 * 但它的题库本身要自洽——否则跑出来的数会骗人：
 *   · 每道题的 `expect` 必须真的在记忆里存在（否则永远不可能命中，看着像引擎差）；
 *   · 三个档位都要有题（只有 `kw` 的话，谁都是 100%）；
 *   · 题目不能重复（重复会把某一类问题的权重放大）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MEMORIES, QUERIES } from '../lib/benchdata.js'

test('每道题的 expect 都在记忆里（否则是题出错了，不是引擎差）', () => {
  const ids = new Set(MEMORIES.map((m) => m.id))
  for (const item of QUERIES) {
    assert.ok(ids.has(item.expect), `「${item.q}」指向不存在的记忆 ${item.expect}`)
  }
})

test('三个档位都有题（只有关键词档的话，谁都是 100%）', () => {
  for (const kind of ['kw', 'sent', 'para']) {
    assert.ok(QUERIES.some((q) => q.kind === kind), `缺档位：${kind}`)
  }
})

test('题目不重复（重复会放大某一类问题的权重）', () => {
  const seen = new Set()
  for (const item of QUERIES) {
    assert.ok(!seen.has(item.q), `重复的题：${item.q}`)
    seen.add(item.q)
  }
})

test('记忆 id 不重复，文本不为空', () => {
  const seen = new Set()
  for (const m of MEMORIES) {
    assert.ok(!seen.has(m.id), `重复的 id：${m.id}`)
    seen.add(m.id)
    assert.ok(String(m.text || '').trim().length > 0, `${m.id} 文本是空的`)
  }
})
