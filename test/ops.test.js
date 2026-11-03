// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 运维类不入库（v0.37.0，④ 组）——借自《AI伙伴运行机制》的写入判据。
 *
 * 他们的原话：*"不进运维类（进程挂了、端口不通）、临时状态、工具的调用细节。
 * 这些东西记进去只会淹掉真正重要的东西。"*
 *
 * 我们**只提醒不拦截**：这是风格问题，不是错误；而且误判的代价比漏判大。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeOps, opsKinds } from '../lib/ops.js'
import { validatePoint } from '../lib/toolkit.js'

const base = {
  id: 'M-2026-11-03-001',
  title: '标题',
  quote: null,
  date: '2026-11-03',
  salience: 3,
  type: 'event',
  cluster: '日常',
  status: 'active',
  source: ['msg-1'],
  links: [],
  summary: '摘要',
}

test('运维类能认出来', () => {
  assert.deepEqual(opsKinds('插件报错了，端口 8080 不通'), ['报错', '端口/网络'])
  assert.equal(looksLikeOps('进程挂了，重启一下'), true)
  assert.equal(looksLikeOps('编译失败，回滚到上一版'), true)
  assert.equal(looksLikeOps('把 .env 里的配置项改一下'), true)
})

test('真话题不该被误判', () => {
  assert.equal(looksLikeOps('我今天好累，想早点睡'), false)
  assert.equal(looksLikeOps('他说下次带我去看海'), false)
  assert.equal(looksLikeOps('她喜欢在雨天听歌'), false)
  assert.equal(looksLikeOps('这个 error 有点好笑'), false, '只是提到 error 这个词，不是运维记录')
})

test('validatePoint：像运维记录 → 警告（不拦截）', () => {
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: 'x' }]]) }
  const r = validatePoint({ ...base, title: '插件报错了', summary: '端口 8080 不通' }, { archive })
  assert.equal(r.errors.length, 0, '不该是错误')
  assert.ok(r.warnings.some((w) => /运维记录/.test(w.message || '')), JSON.stringify(r.warnings))
})

test('validatePoint：正常话题不该被警告', () => {
  const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: 'x' }]]) }
  const r = validatePoint({ ...base, title: '台风天他提前下班', summary: '公司提前放了' }, { archive })
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings))
})
