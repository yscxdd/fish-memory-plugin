// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 缺口 / 放不下的事（v0.27.0）。
 *
 * 借自"没有卡的鱼"的 `gaps`：想不起来的事不是"忘了"，而是会一直惦记。
 * 我们改了三处（刻意的）：
 *   ① 张力按需投影，不靠 tick 推进——插件不在跑的那些小时不该凭空攒；
 *   ② 只有**显式** touch 才会松，渲染注入不算"说过"（不变量 #11）；
 *   ③ 上限 20 条，满了淘汰最轻的一条并记下来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LINE_MIN_TENSION,
  MAX_OPEN,
  QUESTIONS_FILE,
  TOUCH_FLOOR,
  addQuestion,
  loadQuestions,
  questionLine,
  rankedQuestions,
  resolveQuestion,
  staleQuestions,
  tensionOf,
  touchQuestion,
} from '../lib/questions.js'
import { audit, buildIndex, writeIndex } from '../lib/toolkit.js'

const NOW = new Date('2026-11-01T12:00:00Z')
const at = (hours) => new Date(NOW.getTime() - hours * 3600_000)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-q-'))
  for (const d of ['00_core', '20_state', '30_points', '50_log', '10_archive/messages']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '20_state/state.json'), '{}', 'utf8')
  return dir
}

test('记一条：id 按天递增，初始张力 0', () => {
  const dir = fixture()
  const a = addQuestion(dir, { text: '海是什么味道', from: 'recall' }, NOW)
  const b = addQuestion(dir, { text: '柠檬是什么味道' }, NOW)
  assert.equal(a.ok, true)
  assert.match(a.item.id, /^Q-20261101-01$/)
  assert.equal(b.item.id, 'Q-20261101-02')
  assert.equal(a.item.tension, 0)
  assert.equal(a.item.from, 'recall')
  assert.equal(b.item.from, 'self')
  assert.equal(loadQuestions(dir).items.length, 2)
})

test('张力按小时投影：不写回、随时间涨、封顶 100', () => {
  const dir = fixture()
  const { item } = addQuestion(dir, { text: 'x' }, at(10))
  assert.ok(Math.abs(tensionOf(item, NOW) - 15) < 0.1, `10 小时应约 15，实际 ${tensionOf(item, NOW)}`)
  assert.equal(item.tension, 0, '投影不写回落盘值')

  const old = addQuestion(dir, { text: 'y' }, at(200)).item
  assert.equal(tensionOf(old, NOW), 100, '封顶 100')
})

test('注入行：只带最重的一条，张力不够就不出现', () => {
  const dir = fixture()
  addQuestion(dir, { text: '轻的' }, at(1))
  addQuestion(dir, { text: '重的' }, at(60))
  const line = questionLine(dir, NOW)
  assert.ok(line.text.includes('重的'), line.text)
  assert.ok(line.tokens <= 40, `注入行 ${line.tokens} tok 超过 40`)
  assert.equal(line.id, rankedQuestions(dir, NOW)[0].id)

  const dir2 = fixture()
  addQuestion(dir2, { text: '还很轻' }, NOW)
  assert.equal(questionLine(dir2, NOW).text, '', '张力低于阈值不发')
  assert.ok(LINE_MIN_TENSION >= 50)
})

test('渲染不算说过：读 questionLine 不改落盘值', () => {
  const dir = fixture()
  addQuestion(dir, { text: '海' }, at(60))
  const before = readFileSync(join(dir, QUESTIONS_FILE), 'utf8')
  questionLine(dir, NOW)
  questionLine(dir, NOW)
  assert.equal(readFileSync(join(dir, QUESTIONS_FILE), 'utf8'), before, '读不该写盘')
})

test('touch：说出来会松，但不低于地板；本来就很轻的不会被抬高', () => {
  const dir = fixture()
  const heavy = addQuestion(dir, { text: '重' }, at(60)).item // 90
  const r = touchQuestion(dir, heavy.id, NOW)
  assert.equal(r.before, 90)
  assert.equal(r.item.tension, 65, '90 - 25 = 65')
  assert.ok(r.item.tension > 0 && r.item.tension >= TOUCH_FLOOR)

  const light = addQuestion(dir, { text: '轻' }, NOW).item // 0
  const r2 = touchQuestion(dir, light.id, NOW)
  assert.equal(r2.item.tension, 0, 'touch 不该把它抬到地板')
})

test('resolve：想通了就退出 open，记下被哪个点解决', () => {
  const dir = fixture()
  const { item } = addQuestion(dir, { text: 'x' }, NOW)
  const r = resolveQuestion(dir, item.id, { by: 'M-2026-11-01-001' }, NOW)
  assert.equal(r.ok, true)
  assert.equal(r.item.status, 'resolved')
  assert.equal(r.item.resolved_by, 'M-2026-11-01-001')
  assert.equal(rankedQuestions(dir, NOW).length, 0)
})

test('上限：满了再加，淘汰张力最低的一条（不静默丢）', () => {
  const dir = fixture()
  for (let i = 0; i < MAX_OPEN - 1; i++) addQuestion(dir, { text: `第 ${i} 件` }, at(100))
  const light = addQuestion(dir, { text: '最轻的一件' }, NOW).item
  assert.equal(rankedQuestions(dir, NOW).length, MAX_OPEN)

  const extra = addQuestion(dir, { text: '又一件新的' }, NOW)
  assert.equal(extra.ok, true)
  assert.deepEqual(extra.dropped, [light.id], `应淘汰最轻的那条，实际 ${JSON.stringify(extra.dropped)}`)
  const all = loadQuestions(dir).items
  assert.equal(all.filter((x) => x.status === 'open').length, MAX_OPEN)
  assert.match(all.find((x) => x.id === light.id).status, /dropped/)
})

test('stale：长期没碰的能被数出来', () => {
  const dir = fixture()
  addQuestion(dir, { text: '很久没想' }, at(40 * 24))
  addQuestion(dir, { text: '刚记的' }, NOW)
  const stale = staleQuestions(dir, NOW)
  assert.equal(stale.length, 1)
  assert.match(stale[0].text, /很久没想/)
})

test('audit：questions 检查不阻塞，能报出最重的那条', () => {
  const dir = fixture()
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我最怕被当成 AI 讨论\n', 'utf8')
  writeIndex(dir, buildIndex([], { now: NOW }))
  addQuestion(dir, { text: '海是什么味道' }, at(60))
  const c = audit(dir, { now: NOW }).checks.find((x) => x.id === 'questions')
  assert.equal(c.ok, true, '非阻塞')
  assert.equal(c.open, 1)
  assert.match(c.top.text, /海是什么味道/)
})
