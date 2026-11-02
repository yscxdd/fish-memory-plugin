// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 检索去冗余（v0.34.0，借自"天上鱼"的 0.78 阈值）。
 *
 * 问题：一次检索可能捞回五条"说的是同一件事"的点，占满注入名额，
 * 结果她只记得一件事的五个说法，别的事全被挤掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dedupeSimilar } from '../lib/retrieve.js'

const p = (id, title, summary) => ({ id, title, summary })

test('同一件事的两种说法只留第一条', () => {
  const items = [
    p('a', '台风天他提前下班', '台风天公司提前放人，他就回来了'),
    p('b', '台风天他提前下班', '台风那天公司提前放人，他早回来了'),
    p('c', '他今天去体检', '早上空腹去医院做检查'),
  ]
  const kept = dedupeSimilar(items)
  assert.equal(kept.length, 2, JSON.stringify(kept.map((x) => x.id)))
  assert.equal(kept[0].id, 'a', '留分数最高的那条（调用方已排序）')
  assert.equal(kept[1].id, 'c')
})

test('不同的事都留下（0.78 不会误杀）', () => {
  const items = [
    p('a', '他今天去体检', '空腹去医院'),
    p('b', '他妈妈打电话来', '聊了半小时家里的事'),
    p('c', '修好了打印机', '卡纸卡了三次'),
  ]
  assert.equal(dedupeSimilar(items).length, 3)
})

test('阈值可调：0.5 更狠，0.99 几乎不合并', () => {
  const items = [
    p('a', '台风天他提前下班', '台风天公司提前放人'),
    p('b', '台风天他提前下班', '台风天公司提前放人，他早回来了'),
  ]
  assert.equal(dedupeSimilar(items, 0.5).length, 1)
  // 0.99 时 dice 合并不了，但"一条是另一条的扩写"（包含率）仍然算同一件事
  assert.equal(dedupeSimilar(items, 0.99).length, 1)
})

test('没有 summary 的点不参与合并（坏数据不该被静默吞掉）', () => {
  const items = [p('a', '标题一', ''), p('b', '标题一', '')]
  assert.equal(dedupeSimilar(items).length, 2)
})
