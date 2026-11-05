// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 按类型分尺（N2）+ origin 显形（N3）。v0.55.0。
 *
 * N2 的依据：Meta AI 在一条已部署的冷启动管道上统计 4,715 条候选断言——
 * **价值/信念类只有 77.9% 能被信源支撑，其他类 96.2%**；价值类只占候选 21.5%，
 * 却贡献了最多无支撑断言。**一条全局阈值无解**：放松则幻觉进库，收紧则好断言被误杀。
 *
 * N3 的依据：MemIR 把"非结构化记忆丢掉谁说的"叫 provenance-role collapse；
 * 在 LoCoMo / BEAM-100K 上，用户 vs 助手归因错误是主要错误来源。
 * 我们的 `origin` 早就存了（told/chosen/insight/observed，带权重），但**渲染一个字符都没用**。
 *
 * 钉住：
 *   ① 主张类（preference/boundary）**必须带原话或素材源**；
 *   ② promise 必须带 due 或 quote；conflict 缺 contradicts 只 warn（不拦）；
 *   ③ event / habit / gap / incarnation **不额外要求**（别把尺加到不该加的地方）；
 *   ④ 只标非默认 origin（told 不标），且**索引档不标**（索引行最贵）；
 *   ⑤ 反向：told 的点渲染里不能出现任何标记（防标满）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validatePoint } from '../lib/toolkit.js'
import { renderPoint } from '../lib/render.js'

const ARCHIVE = { byId: new Map([['msg-1', { id: 'msg-1', text: '我其实挺喜欢海的' }]]) }

function base(over = {}) {
  return {
    id: 'M-2026-11-05-001',
    title: '他说喜欢海',
    quote: null,
    quote_by: null,
    date: '2026-11-05',
    salience: 2,
    type: 'event',
    cluster: '日常',
    origin: 'told',
    status: 'active',
    source: ['msg-1'],
    links: [],
    summary: '他说喜欢海',
    ...over,
  }
}

const fieldsOf = (r) => r.errors.map((e) => e.field)

test('N2：preference 没有原话 → 拦（要求补 quote 或改 type）', () => {
  const r = validatePoint(base({ type: 'preference' }), { archive: ARCHIVE })
  assert.ok(fieldsOf(r).includes('quote'), JSON.stringify(r.errors))
  assert.match(r.errors.find((e) => e.field === 'quote').message, /补一句原话|改 type/)
})

test('N2：boundary 没有原话 → 拦；有原话 → 过', () => {
  assert.ok(fieldsOf(validatePoint(base({ type: 'boundary' }), { archive: ARCHIVE })).includes('quote'))
  // 原话必须在来源消息里逐字存在（这是既有的 quote 校验，不是新加的）
  const ok = validatePoint(base({ type: 'boundary', quote: '我其实挺喜欢海的', quote_by: 'user' }), { archive: ARCHIVE })
  assert.ok(!fieldsOf(ok).includes('quote'), JSON.stringify(ok.errors))
})

test('N2：preference 带素材源也算有证据（素材是核过原文的）', () => {
  const r = validatePoint(base({ type: 'preference', source: ['asset:book:b1#L3'] }), { archive: ARCHIVE, books: { b1: { id: 'b1' } } })
  assert.ok(!fieldsOf(r).includes('quote'), JSON.stringify(r.errors))
})

test('N2：promise 没有 due 也没有 quote → 拦', () => {
  const r = validatePoint(base({ type: 'promise' }), { archive: ARCHIVE })
  assert.ok(fieldsOf(r).includes('due'), JSON.stringify(r.errors))
})

test('N2：event / habit 不额外要证据（别把尺加到不该加的地方）', () => {
  for (const type of ['event', 'habit']) {
    const r = validatePoint(base({ type }), { archive: ARCHIVE })
    assert.ok(!fieldsOf(r).includes('quote') && !fieldsOf(r).includes('due'), type)
  }
})

test('N2：conflict 缺 contradicts 只 warn，不拦', () => {
  const r = validatePoint(base({ type: 'conflict' }), { archive: ARCHIVE })
  assert.ok(!fieldsOf(r).includes('contradicts'), '不该是 error')
  assert.ok(r.warnings.some((w) => w.field === 'contradicts'), JSON.stringify(r.warnings))
})

test('N3：origin 显形——[挑] / [想] / [察]，told 不标', () => {
  const mk = (origin) => renderPoint({ date: '2026-11-05', title: '一件事', origin, summary: 'x' }, 'sum')
  assert.match(mk('chosen'), /\[挑\]/)
  assert.match(mk('insight'), /\[想\]/)
  assert.match(mk('observed'), /\[察\]/)
  assert.doesNotMatch(mk('told'), /\[挑\]|\[想\]|\[察\]/, 'told 是默认值，标了全是噪音')
})

test('N3：索引档不标（索引行最贵）', () => {
  const line = renderPoint({ date: '2026-11-05', title: '一件事', origin: 'insight' }, 'idx')
  assert.doesNotMatch(line, /\[想\]/, line)
})

test('N3 反向：正常标题被逐字保留（标记不能挤掉正文）', () => {
  const line = renderPoint({ date: '2026-11-05', title: '海边那件事', origin: 'insight', summary: 'x' }, 'sum')
  assert.match(line, /海边那件事/)
})
