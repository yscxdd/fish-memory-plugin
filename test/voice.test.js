// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 口癖采集（v0.33.0）——只提案，不改 voice.md。
 *
 * 钉住五件事：
 *   ① 只采 `role: assistant`（他自己说过的话是回声，不是她的口癖）；
 *   ② 逐字，一个字都不改；
 *   ③ 已经在 voice.md 里的不再提；
 *   ④ 拒过的不再提（`20_state/voice_rejected.json`）；
 *   ⑤ `accept` 之后才写 `voice.md`，并在 `core_changelog.md` 记一行带版本号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acceptVoice,
  existingVoiceLines,
  isVoicey,
  listRejected,
  mineVoice,
  parseVoiceProposal,
  rejectVoice,
  splitSentences,
  writeVoiceProposal,
} from '../lib/voice.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-voice-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '40_pending', '30_points', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调样本（voice）\n', 'utf8')
  writeFileSync(join(dir, '00_core/core_changelog.md'), '# 核心层变更记录\n\n', 'utf8')
  return dir
}

function seedMessages(dir, rows) {
  const file = join(dir, '10_archive/messages/2026-11-01.jsonl')
  const lines = rows.map((r, i) =>
    JSON.stringify({
      id: r.id || `msg-${i + 1}`,
      seq: i + 1,
      prev: i ? 'x' : 'genesis',
      hash: 'h',
      ts: `2026-11-01T10:0${i}:00.000Z`,
      role: r.role,
      source_kind: r.role,
      text: r.text,
      session: 's1',
      msgid_plat: r.id || `p-${i}`,
    }),
  )
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

test('切句与"像不像口音"', () => {
  assert.deepEqual(splitSentences('才不呢。你猜呀！'), ['才不呢', '你猜呀'])
  assert.equal(isVoicey('才不呢'), true)
  assert.equal(isVoicey('好的'), false, '太短')
  assert.equal(isVoicey('这句话没有任何语气词在里面呀'.repeat(3)), false, '太长')
  assert.equal(isVoicey('https://example.com/呀'), false, '链接')
  assert.equal(isVoicey('12345'), false, '纯数字')
})

test('只采她的话：他自己说过的同款句子不算', () => {
  const dir = fixture()
  seedMessages(dir, [
    { role: 'assistant', text: '才不呢' },
    { role: 'assistant', text: '才不呢' },
    { role: 'user', text: '才不呢' },
    { role: 'assistant', text: '那你猜呀' },
    { role: 'assistant', text: '那你猜呀' },
  ])
  const c = mineVoice(dir)
  assert.deepEqual(c.map((x) => x.text).sort(), ['那你猜呀'])
})

test('重复 ≥2 次才提；一次的不提', () => {
  const dir = fixture()
  seedMessages(dir, [
    { role: 'assistant', text: '我偏不嘛' },
    { role: 'assistant', text: '我偏不嘛' },
    { role: 'assistant', text: '就这一句呀' },
  ])
  const c = mineVoice(dir)
  assert.deepEqual(c.map((x) => x.text), ['我偏不嘛'])
  assert.equal(c[0].count, 2)
})

test('已经在 voice.md 里的句子不再提', () => {
  const dir = fixture()
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调样本\n\n### 第 1 段 · 2026-10-30 · 旧\n她：「才不呢」\n', 'utf8')
  seedMessages(dir, [
    { role: 'assistant', text: '才不呢' },
    { role: 'assistant', text: '才不呢' },
  ])
  assert.equal(existingVoiceLines(dir).has('才不呢'), true)
  assert.equal(mineVoice(dir).length, 0)
})

test('提案文件：可解析回候选，且带证据', () => {
  const dir = fixture()
  seedMessages(dir, [
    { role: 'assistant', id: 'm-a', text: '我偏不嘛' },
    { role: 'assistant', id: 'm-b', text: '我偏不嘛' },
  ])
  const c = mineVoice(dir)
  const r = writeVoiceProposal(dir, c, { now: NOW })
  assert.equal(r.ok, true)
  const text = readFileSync(r.path, 'utf8')
  const back = parseVoiceProposal(text)
  assert.equal(back.length, 1)
  assert.equal(back[0].text, '我偏不嘛')
  assert.deepEqual(back[0].evidence, ['m-a', 'm-b'])
})

test('accept：写进 voice.md 新的一段 + changelog 记一行带版本', () => {
  const dir = fixture()
  const r = acceptVoice(dir, ['我偏不嘛', '那你猜呀'], { now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.from, 1)
  assert.equal(r.to, 2)

  const voice = readFileSync(join(dir, '00_core/voice.md'), 'utf8')
  assert.match(voice, /### 第 1 段 · 2026-11-03 · 采自对话/)
  assert.match(voice, /她：「我偏不嘛」/)
  assert.match(voice, /### 第 2 段 · 2026-11-03 · 采自对话/)

  const cl = readFileSync(join(dir, '00_core/core_changelog.md'), 'utf8')
  assert.match(cl, /2026-11-03 \| voice\.md \| v001 \| 口癖采集 2 句/)

  // 再接受一句 → 版本 v002，段号接 3
  const r2 = acceptVoice(dir, ['才不呢'], { now: NOW })
  assert.equal(r2.version, 2)
  assert.equal(r2.from, 3)
  assert.match(readFileSync(join(dir, '00_core/voice.md'), 'utf8'), /### 第 3 段/)
})

test('reject：拒过的不再提，且清单可查', () => {
  const dir = fixture()
  seedMessages(dir, [
    { role: 'assistant', text: '我偏不嘛' },
    { role: 'assistant', text: '我偏不嘛' },
  ])
  assert.equal(mineVoice(dir).length, 1)
  rejectVoice(dir, ['我偏不嘛'])
  assert.deepEqual(listRejected(dir), ['我偏不嘛'])
  assert.equal(mineVoice(dir).length, 0, '拒过的不该再出现')
})

test('没有候选时不写提案（不制造空文件）', () => {
  const dir = fixture()
  const r = writeVoiceProposal(dir, [], { now: NOW })
  assert.equal(r.ok, false)
  assert.equal(existsSync(join(dir, '40_pending/voice-proposal-2026-11-03.md')), false)
})
