// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * v0.22.1：**不再依赖 inbox 事件**取当轮 query。
 *
 * 现场：这个宿主版本里 `agent/inbox/inserted` 不触发（host.log 记了 channel-gap），
 * 而 query 只从 inbox 取 → `st.current` 永远为空 → 检索永远"门控跳过"，
 * 记忆等于没接上（token.log 里 `gate: "skip"` 就是证据）。
 *
 * 实测通的是 session/event（档案一直在长），所以把 session 变成主路径，inbox 只当加速通道。
 * 这里钉三件事：
 *   ① 只发 session 事件，检索也要真的跑（注入里能命中点）；
 *   ② 同一句话经由两条通道各来一次，只算一轮（不能重复 tick）；
 *   ③ `resetStats` 每次 apply 重新计时（热重载不再误报 channel-gap）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { attachHost } from '../lib/host.js'

function makeMemory() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-sess-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  mkdirSync(join(dir, '50_log'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n')
  writeFileSync(
    join(dir, '30_points/M-2026-10-28-001.md'),
    `---
id: M-2026-10-28-001
title: 台风天看海
quote: 这种天气看海才有意思
quote_by: him
date: 2026-10-28
salience: 4
type: event
cluster: 出行
event: E-20261028-01
tags: [海边, 台风]
status: active
source: [msg-sample-001]
links: []
---

<!-- SUM -->
台风夜地铁口积水到小腿，她坚持绕路去海边，两人湿透。
<!-- /SUM -->
`,
  )
  return dir
}

function fakeCtx() {
  const handlers = new Map()
  const contexts = []
  const disposers = []
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    inject() {},
    get() {
      return undefined
    },
    systemPrompt: {
      context(c) {
        contexts.push(c)
        return () => {}
      },
    },
    skills: { register: () => () => {} },
    agents: { roots: () => [] },
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args)
    },
    render(agentId, { depth = 0, cwd } = {}) {
      return contexts[contexts.length - 1].text({
        agent: { id: agentId, session: { header: { delegationDepth: depth, cwd } } },
      })
    },
    dispose() {
      for (const d of disposers) d()
    },
  }
}

const ev = (seq, text, id = `m-${seq}`) => [
  { id: 's1', header: { cwd: '' } },
  {
    type: 'user/message',
    seq,
    time: Date.now(),
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  },
]

test('只发 session 事件（没有 inbox）也能提供当轮 query：检索真的跑了', () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })

  const session = { id: 's1', header: { cwd: dir } }
  const [, event] = ev(1, '台风天去海边看海')
  ctx.emit('session/event', session, event)

  const text = ctx.render('s1', { cwd: dir })
  assert.match(text, /台风天看海/, `检索应当命中那条点；实际注入：${text.slice(0, 200)}`)

  // token.log 里这一轮不该是 gate: skip（那正是"query 永远为空"的症状）
  const log = readFileSync(join(dir, '50_log', 'token.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
  const last = JSON.parse(log[log.length - 1])
  assert.notEqual(last.gate, 'skip', `gate 仍是 skip = query 没进来：${JSON.stringify(last)}`)
  ctx.dispose()
})

test('同一句话从两条通道各来一次：只算一轮（不重复 tick）', () => {
  const dir = makeMemory()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })

  const session = { id: 's1', header: { cwd: dir } }
  const agent = { id: 's1' }
  const message = { id: 'm-same', role: 'user', content: [{ type: 'text', text: '台风' }], source: { kind: 'user' } }
  const event = {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    surfaceOp: 'append',
    data: message,
  }

  ctx.emit('session/event', session, event)
  ctx.emit('agent/inbox/inserted', { agent, message })
  ctx.dispose()

  const statePath = join(dir, '20_state', 'inj10.json')
  if (existsSync(statePath)) {
    const inj = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.ok(Number(inj.tick) <= 1, `同一条消息不该 tick 两次（实际 tick=${inj.tick}）`)
  }
})

test('resetStats：每次 apply 重新计时（热重载不再一上来就过期）', () => {
  const ctx = {
    on: () => () => {},
    effect: (f) => f(),
    inject: () => {},
    get: () => null,
    logger: { warn() {} },
  }
  const host = attachHost(ctx)
  host.stats.attachAt = Date.now() - 3600_000
  host.stats.userSeen = 7
  host.resetStats()
  assert.ok(Date.now() - host.stats.attachAt < 1000, 'attachAt 应当被重置到刚才')
  assert.equal(host.stats.userSeen, 0)
})
