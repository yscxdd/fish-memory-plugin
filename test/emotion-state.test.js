// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪**状态机**（v0.21.0）——和 `emotion.test.js`（那个测的是记忆点里的
 * `emotion.self/user` 字段）不是一回事：这个测的是"她此刻的状态在几轮之间怎么变"。
 *
 * 借鉴《性格与记忆情绪系统 v2》的三条纪律：迟滞带、缓入缓出、上限 + 让位。
 * 断言重点不是"情绪准不准"（本地词典本来就不准），而是：
 *   ① 不能一句话就翻脸；② 不能突然跳变；③ 不能永远安慰；
 *   ④ 两个状态机不能同时拨；⑤ 注入出去的是数字，且 ≤40 tok。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMOTION_DEFAULTS,
  emptyState,
  emotionLine,
  lexiconValence,
  loadEmotion,
  saveEmotion,
  stepEmotion,
} from '../lib/emotion.js'

const CFG = { ...EMOTION_DEFAULTS, enabled: true }
const NEG = -0.8
const POS = 0.8
const CALM = -0.1

const run = (steps, cfg = CFG) => {
  let st = null
  const out = []
  for (const v of steps) {
    st = stepEmotion(st, { valence: v, arousal: 0.6 }, cfg)
    out.push({ comfort: st.comfort.active, zip: st.zip.active, ramp: st.comfort.ramp })
  }
  return { st, out }
}

test('词典：负面/正面/否定翻转', () => {
  assert.ok(lexiconValence('今天好累，什么都做不好').valence < 0)
  assert.ok(lexiconValence('太好了，成了！').valence > 0)
  assert.ok(lexiconValence('我不太开心').valence < 0, '「不太开心」要判负')
  assert.ok(lexiconValence('没关系，不生气').valence >= 0, '「不生气」不该判负')
  assert.equal(lexiconValence('').valence, 0)
})

test('迟滞带：一句话不翻脸，连续两轮才进安慰', () => {
  const one = run([NEG])
  assert.equal(one.out[0].comfort, false, '第一轮不许进安慰')

  const two = run([NEG, NEG])
  assert.equal(two.out[1].comfort, true, '连续两轮才进')

  const exit = run([NEG, NEG, CALM, CALM, CALM])
  assert.equal(exit.out[3].comfort, false, '第一轮缓和还退不掉（迟滞）')
})

test('缓入缓出：ramp 用 2 轮进入、3 轮退出，不跳变', () => {
  const { out } = run([NEG, NEG, NEG, NEG, CALM, CALM, CALM, CALM, CALM])
  assert.ok(out[1].ramp > 0 && out[1].ramp < 1, `进入第一轮 ramp 应为 0.5，实际 ${out[1].ramp}`)
  assert.equal(out[2].ramp, 1, '第二轮到位')
  assert.ok(out[8].ramp < out[7].ramp || out[8].ramp === 0, '退出要分几轮降下来')
})

test('上限：最多 40 轮，之后必须退出（防永久安慰模式）', () => {
  const steps = Array.from({ length: 45 }, () => NEG)
  const { st } = run(steps)
  assert.equal(st.comfort.active, false, '40 轮上限到了要自己退')
})

test('让位：安慰一响，兴头立刻退场（两个状态机不许同时拨）', () => {
  const { st } = run([POS, POS, POS, POS])
  assert.equal(st.zip.active, true, '应当先进兴头')

  let s = st
  for (let i = 0; i < 4; i++) s = stepEmotion(s, { valence: NEG, arousal: 0.6 }, CFG)
  assert.equal(s.comfort.active, true, '安慰应当接管')
  assert.equal(s.zip.active, false, '安慰一响，兴头让位')
})

test('注入行：只发数字/枚举，≤40 tok；平静且不显眼时不发', () => {
  const { st } = run([NEG, NEG])
  const line = emotionLine(st, CFG)
  assert.ok(line.text.includes('安慰中'), line.text)
  assert.ok(line.tokens <= 40, `情绪块 ${line.tokens} tok 超过 40`)

  const quiet = emptyState(CFG)
  assert.equal(emotionLine(quiet, CFG).text, '', '平静时默认不发（省 token）')
  assert.ok(emotionLine(quiet, { ...CFG, showWhenQuiet: true }).text.includes('常态'))
})

test('状态持久化：写出去读回来一致；文件坏了当没有（不影响对话）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-emo-'))
  mkdirSync(join(dir, '20_state'), { recursive: true })
  assert.equal(loadEmotion(dir), null, '没有文件时返回 null')

  const st = run([NEG, NEG]).st
  saveEmotion(dir, st)
  const back = loadEmotion(dir)
  assert.equal(back.comfort.active, true)
  assert.equal(back.ai.valence, st.ai.valence)

  writeFileSync(join(dir, '20_state/emotion.json'), '{坏掉的 json', 'utf8')
  assert.equal(loadEmotion(dir), null, '坏文件不许炸，当没有情绪')
})

test('不变量 #11：情绪步进只写 20_state/emotion.json，不碰 00_core', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-emo2-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  const soul = '# SOUL\n\n- 我最怕被当成 AI 讨论\n'
  writeFileSync(join(dir, '00_core/soul.md'), soul, 'utf8')
  const st = run([NEG, NEG, POS]).st
  saveEmotion(dir, st)
  assert.equal(readFileSync(join(dir, '00_core/soul.md'), 'utf8'), soul, '核心层一个字节都不能变')
  assert.ok(loadEmotion(dir), '情绪状态在 20_state 里')
})
