// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 稳定前缀的字节稳定（v0.61.0，C）。
 *
 * 为什么单独测这个：缓存命中率实测 **99.5%**（ΣcacheRead 1,195,990,784 / Σinput 5,441,906，2720 轮），
 * 这几乎是白拿的钱——但它**没有一条测试守着**。
 * 谁往核心层里塞一个 `new Date()`、"现在是下午"、或者随机挑一条口癖，
 * 命中率就会掉，而**没有任何东西会红**。
 *
 * dsn-mnemo 把这条写成设计保证（"稳定前缀字节稳定，动态记忆只走 context()"）。
 * 我们不必抄它的实现，但该有同样的保证——用测试钉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assemble } from '../lib/render.js'
import { fingerprintDir } from '../lib/util.js'

/** assemble 需要的最小 fake store（只有核心层，没有点） */
function makeStore(coreParts) {
  return {
    coreParts: () => coreParts,
    coreStatus: () => '',
    index: () => '',
    points: () => [],
    state: () => ({ tick: 1 }),
    memoryWeight: () => 1,
    fullPoint: (p) => p,
    session: () => null,
    previousSession: () => null,
    markWorkInjected: () => {},
  }
}

const CORE = [
  { name: 'soul', text: '她不会说"作为一个AI"。' },
  { name: 'voice', text: '每句不超过两句。' },
]

const build = (store, now) => assemble({ store, query: '在吗', now })

test('① 同一组输入：两次装配逐字节相同', () => {
  const store = makeStore(CORE)
  const a = build(store, new Date(2026, 10, 5, 9, 0, 0))
  const b = build(store, new Date(2026, 10, 5, 9, 0, 0))
  assert.equal(a.text, b.text, '同样输入必须同样输出，否则前缀缓存全废')
})

test('② 换个钟点，输出仍然一样（核心层不能被时间污染）', () => {
  const store = makeStore(CORE)
  const morning = build(store, new Date(2026, 10, 5, 7, 30, 0))
  const night = build(store, new Date(2026, 10, 5, 23, 45, 0))
  assert.equal(morning.text, night.text, '核心层不该随时刻变')
})

test('③ 只有核心层时，里面不许出现"会随时间变"的字样', () => {
  const store = makeStore(CORE)
  const r = build(store, new Date(2026, 10, 5, 21, 30, 0))
  for (const bad of [/\d{4}-\d{2}-\d{2}/, /星期[一二三四五六日]/, /\d{1,2}:\d{2}/]) {
    assert.doesNotMatch(r.text, bad, `不该出现时间字样：${bad}`)
  }
})

test('④ 核心层内容变了，输出才该变（不是"永远相同"，是"输入相同则相同"）', () => {
  const a = build(makeStore(CORE), new Date(2026, 10, 5, 9, 0, 0))
  const b = build(makeStore([...CORE, { name: 'rules', text: '新加一条底线。' }]), new Date(2026, 10, 5, 9, 0, 0))
  assert.notEqual(a.text, b.text, '改了核心层就该变——否则说明核心层根本没进 prompt')
})

test('⑤ 同一批文件两次指纹相同（崩溃/热重载不该让前缀抖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-fp-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  writeFileSync(join(dir, '00_core', 'soul.md'), '她不会说"作为一个AI"。', 'utf8')
  writeFileSync(join(dir, '00_core', 'voice.md'), '每句不超过两句。', 'utf8')
  assert.equal(fingerprintDir(dir), fingerprintDir(dir))
})
