// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 接入面（v0.59.0）：`/context?scope=` 与 `/scope` 的纯逻辑。
 *
 * 为什么这些测试最重要：它们是**通道接入的唯一接触面**。
 * 通道侧（QQ 插件）只需要记住两件事：
 *   ① 问 `/scope` 我是谁；
 *   ② 调 `/context` 时把 scope 带上。
 * 所以这两件事的每个"错法"都得有用例钉住——
 * 尤其 **`scope` 不合法时必须 400**：拼错的 scope 会让隔离静默失效，
 * 那比"没隔离"更糟（以为安全了）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filterForScope, parseContextQuery, scopeAnswer } from '../lib/serveapi.js'
import { SCOPE_DM_MASTER, validateScope } from '../lib/scope.js'

const params = (obj) => new URLSearchParams(obj)

test('没传 scope = 主人私聊（老客户端不用改）', () => {
  const r = parseContextQuery(params({ q: '在吗' }))
  assert.equal(r.ok, true)
  assert.equal(r.scope, SCOPE_DM_MASTER)
})

test('传了合法 scope 就按它', () => {
  const r = parseContextQuery(params({ q: 'x', scope: 'group:123' }))
  assert.equal(r.ok, true)
  assert.equal(r.scope, 'group:123')
})

test('scope 拼错必须 400（不能静默退回私聊）', () => {
  for (const bad of ['group', 'group:', 'Group:1', 'dm:', 'global ', '', 'group:1 2']) {
    const r = parseContextQuery(params({ q: 'x', scope: bad }))
    if (bad === '' || bad === 'global ') {
      // 空串 = 没传 → 走默认；只有真给了非空非法值才 400
      assert.equal(r.ok, true, `空/空白 scope 应当走默认：${JSON.stringify(bad)}`)
      continue
    }
    assert.equal(r.ok, false, `应该拒绝：${JSON.stringify(bad)}`)
    assert.equal(r.status, 400)
  }
})

test('mode 只能是 daily / task', () => {
  assert.equal(parseContextQuery(params({ mode: 'task' })).mode, 'task')
  const bad = parseContextQuery(params({ mode: 'fast' }))
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 400)
})

test('filterForScope：群 A 的结果里没有私聊，也没有群 B', () => {
  const points = [
    { id: 'P1', scope: 'global' },
    { id: 'P2', scope: SCOPE_DM_MASTER },
    { id: 'P3', scope: 'group:123' },
  ]
  assert.deepEqual(filterForScope(points, 'group:123').map((p) => p.id), ['P1', 'P3'])
  assert.deepEqual(filterForScope(points, SCOPE_DM_MASTER).map((p) => p.id), ['P1', 'P2'])
})

test('filterForScope：scope 非法时返回空（宁可什么都不给，也不给错的）', () => {
  const points = [{ id: 'P1', scope: 'global' }, { id: 'P2', scope: SCOPE_DM_MASTER }]
  assert.deepEqual(filterForScope(points, 'group:'), [])
})

test('scopeAnswer：群 + 主人 → member / 只读 / 只写 pending；核心层永远 false', () => {
  const a = scopeAnswer({ channelType: 'group', groupId: '123', senderId: 'u1', masterIds: 'u1', homeGroups: '123' })
  assert.equal(a.scope, 'group:123')
  assert.equal(a.role, 'member')
  assert.equal(a.readOnly, true)
  assert.equal(a.mayWriteCore, false, '任何渠道、任何人都不许直写核心层')
  assert.match(a.writeTarget, /40_pending/)
})

test('scopeAnswer：私聊陌生人 → 独立 scope + 只读', () => {
  const a = scopeAnswer({ channelType: 'private', senderId: 'u9', masterIds: 'u1' })
  assert.equal(a.scope, 'dm:u9')
  assert.equal(a.role, 'stranger')
  assert.equal(a.readOnly, true)
})

test('validateScope 的边界', () => {
  assert.equal(validateScope('global').ok, true)
  assert.equal(validateScope('dm:master').ok, true)
  assert.equal(validateScope('dm:abc_DEF-1').ok, true)
  assert.equal(validateScope('group:987654321').ok, true)
  assert.equal(validateScope('group:' + 'x'.repeat(65)).ok, false, '超长 id 要拒')
  assert.equal(validateScope(null).ok, false)
})
