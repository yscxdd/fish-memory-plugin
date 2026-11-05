// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 作用域隔离（v0.58.0）——把"这条记忆属于谁"这一列加上。
 *
 * 为什么先做这个、而不是先接 QQ：这个库一直把世界建模成"我和他两个人"。
 * `relation.md` 一份、`emotion.user` 一位、`touchSession` 里没有说话人。
 * 接进群聊之后，**群里任何人都能触发写入**——一句"我最怕被丢下"就可能进 `40_pending/`，
 * 过闸后变成主人的画像（OWASP ASI06：记忆写入是特权操作）。
 *
 * 钉住：
 *   ① 双向隔离：群 A 看不见私聊，私聊也看不见群 A（主人的库不该因为群聊膨胀）；
 *   ② `global` 永远可见（soul/rules 这类锚点不是某段关系的私有物）；
 *   ③ 历史点没有 scope → 按 global 处理，**不需要迁移**；
 *   ④ 判定只认不可改的 id，绝不认昵称（官方昵称可改，OneBot 群名片谁都能设）；
 *   ⑤ 群作用域的点：不能 pin:hard / 不能 origin:chosen / salience ≤ 3。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCOPE_DM_MASTER,
  SCOPE_GLOBAL,
  filterByScope,
  isGroupScope,
  resolveScope,
  scopeOf,
  visible,
} from '../lib/scope.js'
import { validatePoint } from '../lib/toolkit.js'

const ARCHIVE = { byId: new Map([['msg-1', { id: 'msg-1', text: '我最怕被丢下' }]]) }

function base(over = {}) {
  return {
    id: 'M-2026-11-05-001',
    title: '他说了什么',
    quote: '我最怕被丢下',
    quote_by: 'user',
    date: '2026-11-05',
    salience: 2,
    type: 'event',
    cluster: '日常',
    origin: 'told',
    status: 'active',
    source: ['msg-1'],
    links: [],
    summary: '他说了什么',
    ...over,
  }
}

test('resolveScope：私聊 + 白名单 = 主人', () => {
  const r = resolveScope({ channelType: 'private', senderId: 'u1', masterIds: ['u1'] })
  assert.equal(r.scope, SCOPE_DM_MASTER)
  assert.equal(r.role, 'master')
  assert.equal(r.readOnly, false)
})

test('resolveScope：私聊但不是白名单里的人 → 只读、独立 scope', () => {
  const r = resolveScope({ channelType: 'private', senderId: 'u9', masterIds: ['u1'] })
  assert.equal(r.scope, 'dm:u9')
  assert.equal(r.role, 'stranger')
  assert.equal(r.readOnly, true)
})

test('resolveScope：群 + 主人 id + 白名单群 → 仍然是 member（写入只进 pending）', () => {
  const r = resolveScope({ channelType: 'group', groupId: 'g1', senderId: 'u1', masterIds: ['u1'], homeGroups: ['g1'] })
  assert.equal(r.scope, 'group:g1')
  assert.equal(r.role, 'member', '群里一律 member：没有任何人能直接写核心层')
  assert.equal(r.readOnly, true)
  assert.match(r.reason, /只写 pending/)
})

test('resolveScope：群主但不在白名单里 → 也不当主人', () => {
  const r = resolveScope({ channelType: 'group', groupId: 'g1', senderId: 'u2', masterIds: ['u1'], homeGroups: ['g2'], memberRole: 'owner' })
  assert.equal(r.scope, 'group:g1')
  assert.equal(r.role, 'member')
  assert.match(r.reason, /群友/)
})

test('resolveScope：拿不到群标识也不崩（只读）', () => {
  const r = resolveScope({ channelType: 'group' })
  assert.equal(r.scope, 'group:unknown')
  assert.equal(r.readOnly, true)
})

test('双向隔离：群 A 的结果里不许有私聊，私聊里也不许有群 A', () => {
  const points = [
    { id: 'P1', scope: SCOPE_GLOBAL, title: '锚点' },
    { id: 'P2', scope: SCOPE_DM_MASTER, title: '私聊的事' },
    { id: 'P3', scope: 'group:g1', title: '群 A 的事' },
    { id: 'P4', scope: 'group:g2', title: '群 B 的事' },
  ]
  const dm = filterByScope(points, SCOPE_DM_MASTER).map((p) => p.id)
  assert.deepEqual(dm, ['P1', 'P2'], '主人库不该因为群聊膨胀')
  const ga = filterByScope(points, 'group:g1').map((p) => p.id)
  assert.deepEqual(ga, ['P1', 'P3'], '群里也不该读到家里的事')
})

test('历史点没有 scope → 按 global（不迁移）', () => {
  assert.equal(scopeOf({}), SCOPE_GLOBAL)
  assert.equal(scopeOf({ scope: null }), SCOPE_GLOBAL)
  assert.equal(visible({ title: '旧点' }, 'group:g1'), true)
})

test('isGroupScope 只看前缀', () => {
  assert.equal(isGroupScope('group:123'), true)
  assert.equal(isGroupScope(SCOPE_DM_MASTER), false)
  assert.equal(isGroupScope(undefined), false)
})

test('群作用域的点：不能 pin:hard', () => {
  const r = validatePoint(base({ scope: 'group:g1', pin: 'hard' }), { archive: ARCHIVE })
  assert.ok(r.errors.some((e) => e.field === 'pin'), JSON.stringify(r.errors))
})

test('群作用域的点：不能 origin:chosen', () => {
  const r = validatePoint(base({ scope: 'group:g1', origin: 'chosen' }), { archive: ARCHIVE })
  assert.ok(r.errors.some((e) => e.field === 'origin'), JSON.stringify(r.errors))
})

test('群作用域的点：salience 最高 3', () => {
  assert.ok(validatePoint(base({ scope: 'group:g1', salience: 5 }), { archive: ARCHIVE }).errors.some((e) => e.field === 'salience'))
  assert.ok(!validatePoint(base({ scope: 'group:g1', salience: 3 }), { archive: ARCHIVE }).errors.some((e) => e.field === 'salience'))
})

test('私聊作用域不受这三条限制（别把尺加到不该加的地方）', () => {
  const r = validatePoint(base({ scope: SCOPE_DM_MASTER, pin: 'hard', origin: 'chosen', salience: 5 }), { archive: ARCHIVE })
  assert.deepEqual(r.errors.map((e) => e.field).filter((f) => ['pin', 'origin', 'salience'].includes(f)), [])
})
