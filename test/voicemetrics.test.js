// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 她说话的样子 · 八维（v0.60.0）。
 *
 * 这个度量的价值全在**分母**上：
 *   · 量"她的消息"会把开发报告算进去（实测：档案里 99 条全是长文/代码/表格）；
 *   · 量"她的话"才问得对话——所以先分流，并且**把排除的条数说出来**。
 *
 * 钉住：
 *   ① 没样本要明说"没有样本"，不许算成 0 分好看；
 *   ② 全是工作产出 → 也要明说"没有可量的说话"；
 *   ③ 八维各自的计算口径（含"语气词按句计，不按字数"这条防刷）；
 *   ④ 反向：正常的一句话不能被算成违规。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectMessage, isCompanionSpeech, voiceMetrics } from '../lib/voicemetrics.js'

const row = (r, key) => r.rows.find((x) => x.key === key)

test('没样本：空档案要明说"没有数据"，不是 0 分', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-vm-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const r = voiceMetrics(dir)
  assert.equal(r.empty, true)
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有/)
})

test('全是工作产出：明说"没有可量的说话"，并报出排除条数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-vm-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  writeFileSync(
    join(dir, '10_archive/messages/s1.jsonl'),
    JSON.stringify({ id: 'm1', seq: 1, session: 's1', role: 'assistant', ts: '2026-11-05T10:00:00Z', text: '```js\nconst a = 1\n```\n## 结论\n很长的一段技术报告。'.repeat(20) }) + '\n',
    'utf8',
  )
  const r = voiceMetrics(dir)
  assert.equal(r.empty, true)
  assert.equal(r.excluded, 1)
  assert.match(r.reason, /工作产出/)
})

test('分流：代码块 / 表格 / 大标题 / 超长 都不算"说话"', () => {
  assert.equal(isCompanionSpeech('先吃饭。'), true)
  assert.equal(isCompanionSpeech('```js\nx\n```'), false)
  assert.equal(isCompanionSpeech('| a | b |\n|---|---|\n| 1 | 2 |'), false)
  assert.equal(isCompanionSpeech('## 小标题\n内容'), false)
  assert.equal(isCompanionSpeech('长'.repeat(300)), false)
})

test('八维：合规格的样本全过', () => {
  const sample = [
    { text: '我看了一眼时间，说该睡了。' },
    { text: '嗯，我在。' },
    { text: '我伸手把杯子推过去。' },
  ]
  const r = voiceMetrics(null, { sample })
  assert.equal(r.empty, false)
  assert.equal(r.total, 3)
  assert.equal(r.excluded, 0)
  assert.equal(r.ok, true, JSON.stringify(r.rows.map((x) => `${x.ok ? '✓' : '✗'} ${x.name} ${x.value}`)))
})

test('八维：≥3 句、无自称、禁用词、总结句 都要报红', () => {
  const sample = [
    { text: '首先一件事。其次一件。最后还有一件。' }, // ≥3 句
    { text: '好的，明白。' }, // 无自称
    { text: '作为一个AI，我必须说' }, // 禁用词
    { text: '总的来说，这样比较好。' }, // 总结句
  ]
  const r = voiceMetrics(null, { sample })
  assert.equal(row(r, 'sentences').ok, false)
  assert.equal(row(r, 'selfRef').ok, false)
  assert.equal(row(r, 'banned').ok, false)
  assert.equal(row(r, 'summary').ok, false)
})

test('语气词按句计，不按字数（防"嗯嗯嗯嗯"刷密度）', () => {
  const one = inspectMessage('嗯嗯嗯嗯嗯嗯。')
  assert.equal(one.particles, 1, '一句话里出现多次也只算 1')
})

test('反向：一句正常的话各项都不该被算成违规', () => {
  const m = inspectMessage('我看了下外面，雨停了。')
  assert.equal(m.banned, 0)
  assert.equal(m.summary, 0)
  assert.equal(m.selfRef, 1)
  assert.equal(m.actions, 1)
})
