// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 注入预算的账（v0.16.0）。
 *
 * 这组只测两件事，但两件都是"文档写了、实现没做到"的地方：
 *
 *   ① **关系状态是独立预算**。总设计 §5.4 写的是「`relation_status.json` 常驻 60 tok，
 *      独立预算」；实现里它是 `coreParts()` 的第五块，一起挤 `budget.core`，
 *      而 `CORE_PRIORITY` 里它优先级**最低**——于是"上下文最挤的那一轮，她最先忘了
 *      我们现在什么状态"，正好是最不该忘的时刻。
 *
 *   ② **注入预算的账要能自己站住**。2026-10-31 拍板（总设计 §5.4 方案 A）：
 *      核心层 500 → 700，每轮 +200 tok，契约 §11 #6 的上限随之从 1500 抬到 **1700**。
 *      现在 700+700+300 正好**顶格**——所以这组测试守的已经不是"差额有没有被藏起来"，
 *      而是"顶格这件事有没有人记得"：任何一层再涨 10 tok 就破约，测试必须红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_BUDGET, INJECT_HARD_CAP, assemble, injectBudgetTotal, layoutStatus } from '../lib/render.js'
import { estTokens } from '../lib/util.js'

/** 造一段刚好 tok 量级的汉字（estTokens：CJK 0.8 tok/字） */
const cjk = (chars) => '记'.repeat(chars)

/**
 * 假 store：只实现 assemble 会碰到的口子。
 * `status: undefined` 表示"老 store"（没有 coreStatus），用来验向后兼容。
 */
const fakeStore = ({ core = '# SOUL\n\n- 我不会给人生建议', status = undefined } = {}) => {
  const s = {
    coreParts: () => (core ? [{ name: 'soul', text: core }] : []),
    index: () => ({ clusters: [], recent: [] }),
    points: () => [],
    session: () => null,
    previousSession: () => null,
    markWorkInjected: () => {},
    state: () => ({ tick: 1 }),
    injectionCount: () => 0,
  }
  if (status !== undefined) s.coreStatus = () => status
  return s
}

const BUDGET = { core: 700, index: 0, body: 0, work: 0, status: 60 }

test('预算的账：700+700+300 = 1700，正好顶格，且这个数是被钉死的', () => {
  // 2026-10-31 拍板：总设计 §5.4 方案 A（核心层 700，每轮 +200 tok ≈ 年 +330 万 tok）。
  // 契约 §4.5 的表与 §11 #6 的上限都跟着改成了 1700。
  assert.equal(DEFAULT_BUDGET.core, 700)
  assert.equal(DEFAULT_BUDGET.index, 700)
  assert.equal(DEFAULT_BUDGET.body, 300)
  assert.equal(INJECT_HARD_CAP, 1700)
  assert.equal(injectBudgetTotal(DEFAULT_BUDGET), INJECT_HARD_CAP, '合计必须正好等于上限')

  assert.equal(DEFAULT_BUDGET.status, 60, '总设计 §5.4：关系状态独立 60 tok（不计入 1700）')

  // 顶格 = 零余量。任何一层涨一点就破约——这条断言就是"别偷偷加预算"的闸门。
  assert.ok(injectBudgetTotal({ ...DEFAULT_BUDGET, body: 310 }) > INJECT_HARD_CAP, '正文涨 10 tok 就破约')

  // 不限的层算不出合计，返回 null——不能当 0，否则"没设上限"会被算成"没预算"
  assert.equal(injectBudgetTotal({ core: 0, index: 700, body: 300 }), null)
})

test('关系状态独立成块：紧跟在核心层之后，不占 core 预算', () => {
  // core 用掉 688 tok（远大于一个 60 tok 的关系状态）。若 status 还在 core 里，
  // 688 + 19 = 707 > 700，核心层就会被截断——这条测试就是钉"它不在 core 里"。
  const core = cjk(860)
  assert.equal(estTokens(core), 688)
  const status = '【我们现在】低气压。从三天前开始。他还没开口。'

  const r = assemble({ store: fakeStore({ core, status }), budget: BUDGET, retrieve: () => [] })

  assert.deepEqual(r.coreDropped, [], '核心层没超预算，不该被裁')
  assert.equal(r.status, status)
  assert.equal(r.statusCut, false)

  const text = r.text
  assert.ok(text.includes(core), '核心层全文都在')
  assert.ok(text.includes(status), '关系状态在')
  assert.ok(text.indexOf(status) > text.indexOf(core), '状态排在核心层之后（§5.4：接在核心层末尾）')
  assert.equal((text.match(/<!-- \/记忆 -->/g) || []).length, 1, '块边界只出现一次')
})

test('核心层被挤爆时，关系状态仍然在（这是它独立预算的全部意义）', () => {
  const core = cjk(750) // 600 tok
  const status = '【我们现在】冷战。从昨天开始。'
  const r = assemble({
    store: fakeStore({ core, status }),
    budget: { ...BUDGET, core: 100 },
    retrieve: () => [],
  })

  assert.ok(r.coreDropped.some((d) => d.includes('截断')), '核心层被截断（留痕，不静默）')
  assert.equal(r.status, status, '状态不跟着陪葬')
  assert.ok(r.text.includes(status))
})

test('老 store 没有 coreStatus：不抛、不出现、不破坏原注入', () => {
  const r = assemble({ store: fakeStore(), budget: BUDGET, retrieve: () => [] })
  assert.equal(r.status, '')
  assert.doesNotMatch(r.text, /【我们现在】/)
  assert.ok(r.text.includes('我不会给人生建议'))
})

test('status 为空（没有 relation_status.json）时不出空块', () => {
  const r = assemble({ store: fakeStore({ status: '   ' }), budget: BUDGET, retrieve: () => [] })
  assert.equal(r.status, '')
  assert.doesNotMatch(r.text, /【我们现在】/)
})

test('关系状态超预算：按自己的预算截断，标记说的是"关系状态"不是"核心层"', () => {
  const long = '【我们现在】低气压。' + '他三天没主动说话了，我也不想先低头。'.repeat(8)
  const r = layoutStatus(long, 60)

  assert.equal(r.cut, true)
  assert.ok(r.tokens <= 60, `截断后 ${r.tokens} tok`)
  assert.match(r.text, /关系状态超出预算，已截断/)
  assert.doesNotMatch(r.text, /核心层超出预算/, '别把别人的话贴在自己的伤口上')
})

test('status 预算配 0 = 不限（关闭预算，不是关闭状态）', () => {
  const long = '长'.repeat(500)
  const r = layoutStatus(long, 0)
  assert.equal(r.cut, false)
  assert.equal(r.text, long)
})
