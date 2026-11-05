// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 交接包的总长与运行期硬上限（v0.57.0，H8 / H10）。
 *
 * H10：逐条 `clip` 挡不住"4 条各 60 字 + 5 条线程 + 两栏"，更挡不住**手改 handoff.json**
 * 塞进来的一段长文（OWASP ASI06 把这类叫 size anomaly）。实测正常包约 259 tok、最坏约 400，
 * 1200 是"怎么都不该到"的线。
 *
 * H8：`INJECT_HARD_CAP` 以前只在**启动时**查配置——可真正的总量由"配置 + 每轮实际装进来的东西"
 * 决定，交接包 / 情绪行 / 该办了都不在配置里。超了要喊一声，但**不拦**（拦了她会突然失忆）。
 *
 * 钉住：
 *   ① 正常包不受影响（不截断、不出现"截断"标记）；
 *   ② 超长时优先砍"最近的对话原文"，**保住「我还惦记着 / 别再提」**；
 *   ③ 截断后块边界仍然只有一对（不能因为截断把块弄坏）；
 *   ④ 手改 json 塞超长文本，读回来也是截断版。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HANDOFF_MAX_TOK,
  HANDOFF_TRUNCATED,
  buildHandoff,
  capHandoffText,
  takeHandoff,
} from '../lib/handoff.js'
import { loadQuestions, saveQuestions } from '../lib/questions.js'
import { estTokens } from '../lib/util.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-cap-'))
  for (const d of ['10_archive/messages', '20_state', '30_points']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const countOpen = (s) => (s.match(/<!--/g) || []).length

test('正常包不截断：没有截断标记，块边界一对', () => {
  const dir = fixture()
  const r = buildHandoff(dir, { id: 's1', tail: [{ role: 'user', text: '今天下雨了' }], open_threads: [] })
  assert.ok(!r.text.includes(HANDOFF_TRUNCATED), '正常包不该出现截断标记')
  assert.equal(countOpen(r.text), 2)
  assert.ok(estTokens(r.text) < HANDOFF_MAX_TOK)
})

test('极长尾巴被逐条 clip 挡住：build 阶段就超不过上限', () => {
  const dir = fixture()
  // 每条 600 字 × 8 条——如果没 clip，这里妥妥超 1200 tok
  const longTail = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '很长的对话'.repeat(120) }))
  const r = buildHandoff(dir, { id: 's1', tail: longTail, open_threads: [] })
  assert.ok(!r.text.includes(HANDOFF_TRUNCATED), '逐条 clip 已经挡住了，不该走到总长截断')
  assert.ok(estTokens(r.text) < HANDOFF_MAX_TOK, `实际 ${estTokens(r.text)}`)
  assert.equal(countOpen(r.text), 2)
})

test('真超长时（手改/历史包）：砍对话原文，保住「我还惦记着」', () => {
  // 直接喂一段超长文本：模拟"手改 json"或"旧版留下的胖包"
  const fat = [
    '<!-- 接上次 -->',
    '上次停在这里（2026-11-05 10:00）：',
    ...Array.from({ length: 40 }, () => '你：' + '很长的对话'.repeat(20)),
    '',
    '我还惦记着：',
    '- 他那天为什么突然沉默',
    '',
    '别再提：',
    '- 那句「算了」',
    '',
    '<!-- /接上次 -->',
  ].join('\n')
  const out = capHandoffText(fat, HANDOFF_MAX_TOK)
  assert.ok(estTokens(out) <= HANDOFF_MAX_TOK, `截断后仍超：${estTokens(out)}`)
  assert.ok(out.includes('我还惦记着'), '关系状态要保住')
  assert.ok(out.includes(HANDOFF_TRUNCATED), '必须留截断标记')
  assert.equal(countOpen(out), 2, '块边界不能坏')
})

test('capHandoffText：本来就不超的文本原样返回', () => {
  const text = '<!-- 接上次 -->\n你：短\n<!-- /接上次 -->'
  assert.equal(capHandoffText(text, 1200), text)
})

test('capHandoffText：纯长文也能切到上限以内，且补回关闭标记', () => {
  const text = `<!-- 接上次 -->\n${'长'.repeat(5000)}\n<!-- /接上次 -->`
  const out = capHandoffText(text, 200)
  assert.ok(estTokens(out) <= 200, `实际 ${estTokens(out)}`)
  assert.ok(out.includes('<!-- /接上次 -->'), '关闭标记必须补回去')
})

test('手改 json 塞超长文本：读回来也是截断版', () => {
  const dir = fixture()
  const huge = `<!-- 接上次 -->\n${'一段很长的话'.repeat(800)}\n<!-- /接上次 -->`
  writeFileSync(join(dir, '20_state/handoff.json'), JSON.stringify({ at: new Date().toISOString(), from: 's1', text: huge }), 'utf8')
  const got = takeHandoff(dir, 's9')
  assert.ok(estTokens(got) <= HANDOFF_MAX_TOK, `读回来仍超：${estTokens(got)}`)
})
