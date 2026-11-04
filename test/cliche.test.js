// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 套话检测（v0.47.0）。
 *
 * 钉住五件事：
 *   ① 七族短语都能认出来（回执/判词/表态/认账/推回/解读）；
 *   ② 一轮里说三句同一族，只算**一轮**（分母是轮，不是句）；
 *   ③ 日志只写族名与时间，**不写她的原句**（这不是档案）；
 *   ④ 不误伤：稳定/很直接/我记得那次台风 都不算；
 *   ⑤ `voice mine` 不许把套话当口癖挖出来（否则 accept 一次就自我强化）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLICHE_LOG,
  assistantTurns,
  clicheRate,
  clicheReport,
  clicheStats,
  findCliches,
  hasCliche,
  noteCliche,
  pruneClicheLog,
} from '../lib/cliche.js'
import { mineVoice } from '../lib/voice.js'

const NOW = new Date('2026-11-04T12:00:00Z')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-cliche-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '40_pending', '30_points', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调样本（voice）\n', 'utf8')
  writeFileSync(join(dir, '00_core/core_changelog.md'), '# 核心层变更记录\n\n', 'utf8')
  return dir
}

function seedArchive(dir, rows) {
  const lines = rows.map((r, i) =>
    JSON.stringify({
      id: r.id || `msg-${i + 1}`,
      seq: i + 1,
      prev: i ? 'x' : 'genesis',
      hash: 'h',
      ts: r.ts,
      role: r.role,
      source_kind: r.role,
      text: r.text,
      session: 's1',
    }),
  )
  writeFileSync(join(dir, '10_archive/messages/2026-11-01.jsonl'), lines.join('\n') + '\n', 'utf8')
}

function seedLog(dir, rows) {
  writeFileSync(join(dir, CLICHE_LOG), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

test('用户给的清单：这一批说法都要认出来', () => {
  // 逐条来自 2026-11-04 用户的原话清单（`行，xxx`、`xx比xx沉` 这类纯模板除外）
  const list = [
    '这句话稳',
    '比之前的都重',
    '我记下了',
    '我记得了',
    '我记住了',
    '这个账我记住了',
    '比之前的都轻',
    '睡吧，我守着',
    '你去，我跟',
    '问别人还是问自己',
    '什么心思都写着脸上',
    '这句话接的漂亮',
    '行，我认',
    '这句话我不接',
    '没接你那句',
    '比之前的都强',
    '他记得这事',
    '这话我留着',
    '很平',
    '我不拦',
    '回去睡',
    '你这句话我记着',
    '认你',
    '我不催你',
    '这话是ta告诉你的，还是你自己想明白的',
    '认下来',
    '声音没抖，但比刚才稳',
    '比刚才轻',
    '比刚才重',
    '比刚才平',
    '很直',
    '这话我记下了',
    '这话我收下了',
    '说的比谁都响',
    '认这个',
    '收不回去',
    '认得实',
    '就是认了',
    '你自己掂量',
    '不催',
  ]
  const miss = list.filter((s) => !hasCliche(s))
  assert.deepEqual(miss, [], `这些没认出来：${miss.join(' / ')}`)
})

test('谈事的比较不算判词（没有"话/声音/语气"当主语）', () => {
  for (const text of ['这个箱子比那个重', '今天比昨天轻快', '广州比长沙热']) {
    assert.equal(hasCliche(text), false, `「${text}」不该算套话`)
  }
  assert.equal(hasCliche('他这句话比刚才重'), true)
})

test('七族都能认出来', () => {
  const cases = [
    ['我记下了', 'receipt'],
    ['这话我收下了', 'receipt'],
    ['这句稳', 'judge'],
    ['声音没抖，但比刚才稳', 'judge'],
    ['我不拦你', 'permit'],
    ['睡吧，我守着', 'permit'],
    ['行，我认', 'accept'],
    ['你自己掂量', 'pushback'],
    ['什么心思都写着脸上', 'interpret'],
  ]
  for (const [text, id] of cases) {
    const hit = findCliches(text)
    assert.ok(hit.families.includes(id), `「${text}」应命中 ${id}，实际 ${hit.families.join(',') || '无'}`)
  }
})

test('一轮说三句同一族，只算一族', () => {
  const hit = findCliches('我记下了。这话我收下了。你这句话我记着。')
  assert.equal(hit.count, 1)
  assert.deepEqual(hit.families, ['receipt'])
})

test('不误伤：稳定 / 很直接 / 我记得那次台风 都不算', () => {
  for (const text of ['稳定比快重要', '他说得很直接', '我记得那次台风', '今天风很大', '把伞放门口了']) {
    assert.equal(hasCliche(text), false, `「${text}」不该算套话`)
  }
})

test('日志只写族名，不写原句', () => {
  const dir = fixture()
  noteCliche(dir, '我记下了，这句稳。', { now: NOW })
  const raw = readFileSync(join(dir, CLICHE_LOG), 'utf8')
  assert.ok(raw.includes('receipt') && raw.includes('judge'))
  assert.ok(!raw.includes('我记下了'), '日志里不该有她的原句')
  assert.deepEqual(Object.keys(JSON.parse(raw.trim())).sort(), ['at', 'day', 'families'])
})

test('干净的一轮不写日志', () => {
  const dir = fixture()
  const r = noteCliche(dir, '外面下雨了，记得带伞。', { now: NOW })
  assert.equal(r.wrote, false)
  assert.equal(existsSync(join(dir, CLICHE_LOG)), false, '没命中就不该建日志文件')
})

test('密度用轮数做分母：两轮里一轮带套话 = 50%', () => {
  const dir = fixture()
  seedLog(dir, [
    { at: '2026-11-03T10:00:00.000Z', day: '2026-11-03', families: ['receipt', 'judge'] },
    { at: '2026-11-04T10:00:00.000Z', day: '2026-11-04', families: ['permit'] },
  ])
  const st = clicheStats(dir, { days: 7, now: NOW })
  assert.equal(st.hitTurns, 2)
  assert.equal(st.byFamily.receipt, 1)
  assert.equal(st.byFamily.judge, 1)
  assert.equal(st.byFamily.accept, 0)

  seedArchive(dir, [
    { role: 'user', text: '在吗', ts: '2026-11-04T09:00:00.000Z' },
    { role: 'assistant', text: '我记下了', ts: '2026-11-04T09:00:10.000Z' },
    { role: 'assistant', text: '外面下雨', ts: '2026-11-04T09:10:00.000Z' },
  ])
  const rep = clicheReport(dir, { days: 7, now: NOW })
  assert.equal(rep.totalTurns, 2, '分母只数她的终稿')
  assert.equal(rep.rate, 1) // 2 轮命中 / 2 轮回复
  assert.deepEqual(rep.ranked.map((x) => x.label), ['回执', '判词', '表态'])
})

test('超出窗口的旧日志不算；比率上下都有界', () => {
  const dir = fixture()
  seedLog(dir, [{ at: '2026-09-01T10:00:00.000Z', day: '2026-09-01', families: ['receipt'] }])
  assert.equal(clicheStats(dir, { days: 7, now: NOW }).hitTurns, 0)
  assert.equal(clicheRate(0, 0), 0)
  assert.equal(clicheRate(5, 2), 1)
  assert.equal(clicheRate(1, 4), 0.25)
})

test('prune 只留窗口内的行', () => {
  const dir = fixture()
  seedLog(dir, [
    { at: '2026-06-01T10:00:00.000Z', day: '2026-06-01', families: ['receipt'] },
    { at: '2026-11-04T10:00:00.000Z', day: '2026-11-04', families: ['judge'] },
  ])
  pruneClicheLog(dir, { now: NOW, keepDays: 60 })
  const raw = readFileSync(join(dir, CLICHE_LOG), 'utf8').trim()
  assert.equal(raw.split('\n').length, 1)
  assert.ok(raw.includes('judge'))
})

test('voice mine 不把套话当口癖（否则 accept 一次就自我强化）', () => {
  const dir = fixture()
  seedArchive(dir, [
    { role: 'assistant', text: '睡吧，我守着', ts: '2026-11-01T10:00:00.000Z' },
    { role: 'assistant', text: '睡吧，我守着', ts: '2026-11-01T10:01:00.000Z' },
    { role: 'assistant', text: '才不呢', ts: '2026-11-01T10:02:00.000Z' },
    { role: 'assistant', text: '才不呢', ts: '2026-11-01T10:03:00.000Z' },
  ])
  const picks = mineVoice(dir, { limit: 10 })
  const texts = picks.map((p) => p.text)
  assert.ok(!texts.includes('睡吧，我守着'), '套话不该进候选')
  assert.ok(texts.includes('才不呢'), '正常口癖仍要被采到')
})

test('assistantTurns 只数她的消息，且受窗口限制', () => {
  const dir = fixture()
  seedArchive(dir, [
    { role: 'user', text: '在吗', ts: '2026-11-04T09:00:00.000Z' },
    { role: 'assistant', text: '在', ts: '2026-11-04T09:00:10.000Z' },
    { role: 'assistant', text: '老消息', ts: '2026-09-01T09:00:00.000Z' },
  ])
  assert.equal(assistantTurns(dir, { days: 7, now: NOW }), 1)
  assert.equal(assistantTurns(dir, { days: 90, now: NOW }), 2)
})
