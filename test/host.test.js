// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 宿主适配层（lib/host.js）与它的体检（lib/hostcheck.js）。
 *
 * 测三件事：
 *   ① 缺什么就报什么，不许抛错（宿主版更后最怕的是"静默"）
 *   ② 口子清单与代码里的 [HOST: …] 标记必须一一对应（加口子必须登记）
 *   ③ lib/ 下只有 host.js 能碰 ctx（否则这张表就会过时）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EVENTS, HOST_POINTS, attachHost, probeSurface, readContextWindow } from '../lib/host.js'
import { checkHost, stripComments, stripStrings } from '../lib/hostcheck.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fakeCtx(overrides = {}) {
  const subscriptions = []
  return {
    ...{
      logger: { info() {}, warn() {}, error() {} },
      effect(fn) {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      on(name, fn) {
        subscriptions.push({ name, fn })
        return () => {}
      },
      systemPrompt: { context: () => () => {} },
      tools: { register: () => () => {} },
      skills: { register: () => () => {} },
      interval: () => () => {},
      get: () => undefined,
    },
    ...overrides,
  }
}

test('口子清单：id 唯一，必需项都是真会毁功能的', () => {
  const ids = HOST_POINTS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
  for (const p of HOST_POINTS) {
    assert.ok(p.api && p.symptom && p.fix, `${p.id} 缺 api/symptom/fix`)
    assert.ok(['api', 'event', 'service', 'data'].includes(p.kind), `${p.id} 的 kind 不认识：${p.kind}`)
  }
  const required = HOST_POINTS.filter((p) => p.required).map((p) => p.id)
  // 这五个缺了就是"插件等于没装"，必须是必需
  for (const id of ['inject', 'event-inbox', 'event-session', 'effect', 'logger']) {
    assert.ok(required.includes(id), `${id} 应该标必需`)
  }
})

test('事件名只在 EVENTS 里定义一次', () => {
  assert.equal(EVENTS.inbox, 'agent/inbox/inserted')
  assert.equal(EVENTS.session, 'session/event')
  assert.equal(EVENTS.turnStopping, 'agent/turn-stopping')
  assert.equal(EVENTS.compaction, 'compaction/start')
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.doesNotMatch(src, /'(agent\/inbox\/inserted|session\/event|agent\/turn-stopping)'/, 'index.js 里不许再写死事件名')
})

test('probeSurface：全都在就 ok；缺 systemPrompt 报 inject 为必需缺口', () => {
  const full = probeSurface(fakeCtx())
  assert.equal(full.ok, true)
  assert.deepEqual(full.requiredMissing, [])
  assert.ok(full.found.includes('inject'))
  // 数据形状静态探不了，必须自己承认
  assert.ok(full.unprobeable.includes('data-message-shape'))
  assert.ok(full.unprobeable.includes('data-event-shape'))

  const noInject = probeSurface(fakeCtx({ systemPrompt: undefined }))
  assert.equal(noInject.ok, false)
  assert.deepEqual(noInject.requiredMissing, ['inject'])
})

test('缺能力不抛错：inject → noop，tool/skill → null，every → 兜底', () => {
  const host = attachHost(fakeCtx({ systemPrompt: undefined, tools: undefined, skills: undefined, interval: undefined }))
  assert.equal(typeof host.inject({ text: () => '' }), 'function', 'inject 应返回 noop 而不是 undefined')
  assert.equal(host.tool({}), null)
  assert.equal(host.skill({}), null)
  const stop = host.every(60_000, () => {})
  assert.equal(typeof stop, 'function')
  stop()
})

test('缺 effect / on：effect 立即执行一次，订阅退化成 noop（假 ctx 也能跑）', () => {
  const host = attachHost(fakeCtx({ effect: undefined, on: undefined }))
  let ran = 0
  host.effect(() => {
    ran += 1
  })
  assert.equal(ran, 1)
  assert.equal(typeof host.onInbox(() => {}), 'function')
})

test('订阅会记数：这是 channel-gap 唯一的线索', () => {
  const subs = []
  const host = attachHost(
    fakeCtx({
      on(name, fn) {
        subs.push({ name, fn })
        return () => {}
      },
    }),
  )
  host.onInbox(() => {})
  host.onSessionEvent(() => {})
  assert.equal(host.stats.inbox, 0)
  subs.find((s) => s.name === EVENTS.inbox).fn({})
  subs.find((s) => s.name === EVENTS.session).fn({}, { type: 'user/message' })
  assert.equal(host.stats.inbox, 1)
  assert.equal(host.stats.session, 1)
})

test('冻结的 ctx：testHook 不抛错（生产里 ctx 可能被 freeze）', () => {
  const host = attachHost(Object.freeze(fakeCtx()))
  assert.doesNotThrow(() => host.testHook('fishMemory', () => ({})))
})

test('readContextWindow：读不到就 undefined，绝不猜（v0.4.2 的坑）', () => {
  assert.equal(readContextWindow({ requestContext: () => ({ contextWindow: 64000 }) }), 64000)
  assert.equal(readContextWindow({ requestContext: () => ({}) }), undefined)
  assert.equal(readContextWindow({}), undefined)
  assert.equal(
    readContextWindow({
      requestContext: () => {
        throw new Error('no header')
      },
    }),
    undefined,
  )
})

test('stripComments：注释里的 ctx. 不算调用，字符串里的 // 不被当注释', () => {
  assert.equal(stripComments('// ctx.effect()\nconst a = 1').includes('ctx.'), false)
  assert.match(stripComments('const u = "http://x/y"'), /http:\/\/x\/y/)
})

test('体检：标记与表一一对应、host.js 之外没有 ctx 直呼、降级自检全过', () => {
  const r = checkHost(ROOT)
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors))
  assert.equal(r.ok, true)
  for (const p of r.points) assert.ok(p.sites.length, `${p.id} 没有 [HOST: …] 标记`)
  assert.equal(r.selfTest.ok, true)
})

test('host.js 不许直接读没 inject 的服务（rc.5 的 "cannot get property … without inject"）', () => {
  const code = stripStrings(stripComments(readFileSync(join(ROOT, 'lib/host.js'), 'utf8')))
  // 能直接读的：cordis 核心成员 + inject 里声明的三个
  const allowed = new Set(['logger', 'effect', 'on', 'get', 'systemPrompt', 'tools', 'skills'])
  const used = [...code.matchAll(/\bctx\s*\??\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  const bad = [...new Set(used)].filter((k) => !allowed.has(k))
  assert.deepEqual(bad, [], `这些 ctx 成员没进 inject，直接读会让整根 fiber failed：${bad.join(', ')}`)
})

test('回归（rc.5 真事故）：ctx.interval 直接读会抛，every 必须走 get("timer")', () => {
  let used = 0
  const ctx = fakeCtx({
    get: (name) =>
      name === 'timer'
        ? {
            interval: () => {
              used += 1
              return () => {}
            },
          }
        : undefined,
  })
  // 模拟 cordis 4：未 inject 的服务一读就抛
  Object.defineProperty(ctx, 'interval', {
    configurable: true,
    get() {
      throw new Error('cannot get property "timer" without inject')
    },
  })

  const host = attachHost(ctx)
  assert.doesNotThrow(() => host.every(60_000, () => {}))
  assert.equal(used, 1, '应该用上 timer 服务，而不是退回 setInterval')
})

test('回归（rc.5 真事故）：ctx.interval 会抛时，体检本身也不许炸', () => {
  const ctx = fakeCtx()
  Object.defineProperty(ctx, 'interval', {
    configurable: true,
    get() {
      throw new Error('cannot get property "timer" without inject')
    },
  })
  assert.doesNotThrow(() => probeSurface(ctx))
  assert.doesNotThrow(() => attachHost(ctx))
})

test('体检会失败：多一个未登记标记 / 直呼 ctx / 漏标记 —— 检查器本身不能是摆设', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-hostcheck-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'lib/host.js'),
    ['// [HOST: inject]', '// [HOST: made-up]', 'export function attachHost() {}'].join('\n'),
  )
  writeFileSync(join(dir, 'lib/leak.js'), 'export function f(ctx) {\n  return ctx.systemPrompt\n}\n')

  const r = checkHost(dir)
  assert.equal(r.ok, false, '这份假源码必须被判失败')
  const joined = r.errors.join('\n')
  assert.match(joined, /未登记的标记：made-up/)
  assert.match(joined, /找不到对应标记/, '其余 16 个口子没标记，要报出来')
  assert.match(joined, /直呼/, 'host.js 之外碰 ctx 要报出来')
  assert.equal(r.stray[0].file, 'lib/leak.js')
  assert.equal(r.stray[0].line, 2, '行号要指向真正的调用行（注释不算）')
})
