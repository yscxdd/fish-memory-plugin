// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪闸按**内容**，不按会话（v0.65.0 的决定）。
 *
 * 为什么不是按会话：同一个会话里既有调试也有真事。
 * 按会话闸 = "这一整天她都不会有情绪"；按内容闸 = "这破 bug 又炸了"不算，"我今天很难受"算。
 *
 * 这个文件测**判据本身**；端到端的"work 句不改 emotion.json"在 `plugin.test.js` 里
 * （那里才有 fakeCtx）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeChat, looksLikeWork } from '../lib/textkind.js'

test('工作句：代码/路径/报错/长文 都算 work', () => {
  for (const t of [
    '这个报错怎么修',
    '我先跑一遍测试再提交',
    '`npm test` 挂了',
    '把 lib/index.js 那个函数抽一下',
    '这段代码看起来没问题，但日志里还有一条 warning，我先看看是不是缓存的问题，然后再决定要不要改配置',
  ]) {
    assert.equal(looksLikeWork(t), true, t)
  }
})

test('聊天句：不该被当成 work', () => {
  for (const t of ['我今天很难受', '算了，不说了', '那你猜呀', '嗯，我在', '雨停了，你那边呢']) {
    assert.equal(looksLikeWork(t), false, t)
  }
})

test('looksLikeChat 正好是反义', () => {
  assert.equal(looksLikeChat('我今天很难受'), true)
  assert.equal(looksLikeChat('这个报错怎么修'), false)
})
