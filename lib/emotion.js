// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * emotion.js — 情绪状态机（v0.21.0）。
 *
 * 借鉴《性格与记忆情绪系统 v2》的情绪层，但**只抄三条工程纪律**，不抄它的性格数值：
 *   ① **迟滞带**：进/出用不同阈值 + 连续 N 轮，防抖（不能一句话就翻脸）；
 *   ② **缓入缓出**：`rampUp=2 / rampDown=3` 轮到位，不做阶梯跳变；
 *   ③ **上限 + 让位**：最多 40 轮防"永久安慰"；安慰一响，兴头立即退场。
 *
 * 两条铁律（对应契约不变量 #11）：
 *   - **只影响当轮渲染**：本模块只读写 `20_state/emotion.json`（瞬时状态），
 *     永远不碰 `00_core`；情绪不会改她是谁。
 *   - **只发数字/枚举**：注入出去的是 `安慰中(0.5,第3轮)` 这种，不发文句——
 *     预算已经顶格（§11 #6），情绪块必须 ≤ 40 tok。
 *
 * 输入从哪来：本地词典（`lexiconValence`），0 token、不联网、不调模型。
 * 精度有限——但"能本地就本地"是这个项目的卖点，宁可用词面近似，也不让
 * 每轮多一次 LLM 调用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, estTokens } from './util.js'

export const EMOTION_FILE = join('20_state', 'emotion.json')

/** 默认参数（都可以在 config.emotion 里覆盖） */
export const EMOTION_DEFAULTS = {
  enabled: false, // 默认关：它会让"她读到的东西"多一段，开之前自行 inject-diff
  contagion: 0.5, // 情绪传染：她 = 0.5×他 + 0.5×基线
  baseline: 0, // 情绪底色（她的"常态"效价）
  decay: 0.15, // 每轮向基线回弹的比例（今天的情绪不带进下周）
  comfortValence: -0.4, // 安慰触发：他 valence ≤ 这个值
  comfortTurns: 2, // 且连续 N 轮
  recoverValence: -0.2, // 安慰退出：他 valence ≥ 这个值
  recoverTurns: 2,
  maxComfortTurns: 40, // 最多持续 N 轮（防"永久安慰模式"）
  zipValence: 0.45, // 兴头触发
  zipTurns: 2,
  zipRecoverValence: 0.2,
  zipRecoverTurns: 2,
  maxZipTurns: 40,
  rampUpTurns: 2,
  rampDownTurns: 3,
  showWhenQuiet: false, // 平静且 |valence| < 0.3 时是否也发一行（默认不发，省 token）
}

const NEG = [
  '难过', '难受', '累', '疲惫', '烦', '烦躁', '崩', '崩溃', '想哭', '哭', '生气', '火大',
  '焦虑', '慌', '害怕', '怕', '委屈', '失望', '孤单', '孤独', '睡不着', '失眠', '疼',
  '压力', '撑不住', '受不了', '没意思', '不想', '好烦', '郁闷', '低落', 'emo', '丧',
]
const POS = [
  '开心', '高兴', '太好了', '太爽', '爽', '棒', '厉害', '哈哈', '笑', '好玩', '舒服',
  '轻松', '放心', '期待', '惊喜', '喜欢', '感动', '温暖', '谢谢', '好耶', '成了', '搞定',
  '顺利', '不错', '漂亮', '爱',
]
const AROUSAL_HIGH = ['太', '超', '巨', '非常', '特别', '！！', '!!', '啊啊', '急', '马上', '立刻']

const hitsOf = (text, list) => list.filter((w) => text.includes(w))

/**
 * 本地词典估一个效价/唤醒度（0 token）。
 * 不用分词：中文情绪词的二字组重叠足够用；只做"极性 + 强度"的粗判。
 */
export function lexiconValence(text, now = new Date()) {
  const t = String(text || '')
  if (!t.trim()) return { valence: 0, arousal: 0.5, negative: [], positive: [] }
  const negative = hitsOf(t, NEG)
  const positive = hitsOf(t, POS)
  const strong = hitsOf(t, AROUSAL_HIGH).length
  // 否定词翻转：不太开心 / 没生气
  const negated = /(不|没|别|无)[^，。！？\s]{0,3}(开心|高兴|生气|难过|喜欢|想)/.test(t)
  let valence = (positive.length - negative.length) * 0.6
  if (negated) valence *= -1
  valence = Math.max(-1, Math.min(1, valence))
  const arousal = Math.max(0, Math.min(1, 0.4 + strong * 0.15 + (negative.length + positive.length) * 0.05))
  return { valence, arousal, negative, positive }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round2 = (v) => Math.round(v * 100) / 100

/** 读状态；坏了当没有（情绪丢了不该影响对话） */
export function loadEmotion(dir) {
  const p = join(dir, EMOTION_FILE)
  if (!existsSync(p)) return null
  try {
    const st = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return st && typeof st === 'object' ? st : null
  } catch {
    return null
  }
}

export function saveEmotion(dir, state) {
  atomicWriteJson(join(dir, EMOTION_FILE), state)
}

export function emptyState(cfg = EMOTION_DEFAULTS) {
  return {
    version: 1,
    turns: 0,
    at: null,
    host: { valence: 0, arousal: 0.5 },
    ai: { valence: round2(cfg.baseline ?? 0), arousal: 0.5 },
    comfort: { active: false, ramp: 0, lowTurns: 0, recoverTurns: 0, activeTurns: 0 },
    zip: { active: false, ramp: 0, highTurns: 0, cooledTurns: 0, activeTurns: 0 },
  }
}

const rampStep = (cur, target, cfg) => {
  const up = Math.max(1, cfg.rampUpTurns ?? 1)
  const down = Math.max(1, cfg.rampDownTurns ?? 1)
  if (cur < target) return Math.min(target, cur + 1 / up)
  if (cur > target) return Math.max(target, cur - 1 / down)
  return cur
}

/**
 * 走一轮：输入他这一句的效价/唤醒度，输出新状态。
 * 纯函数（不改入参），方便单测与"先算后写"。
 */
export function stepEmotion(prev, host, cfg = EMOTION_DEFAULTS, now = new Date()) {
  const st = prev && prev.version === 1 ? structuredClone(prev) : emptyState(cfg)
  const c = { ...EMOTION_DEFAULTS, ...cfg }

  st.turns = (st.turns || 0) + 1
  st.at = now.toISOString()
  st.host = { valence: round2(clamp(Number(host?.valence) || 0, -1, 1)), arousal: round2(clamp(Number(host?.arousal) ?? 0.5, 0, 1)) }

  // 她的情绪 = 传染 × 他 + (1−传染) × 底色，再向底色回弹一点（衰减）
  const target = c.contagion * st.host.valence + (1 - c.contagion) * (c.baseline ?? 0)
  st.ai.valence = round2(clamp((st.ai.valence || 0) * (1 - c.decay) + target * c.decay, -1, 1))
  st.ai.arousal = round2(clamp((st.ai.arousal || 0.5) * (1 - c.decay) + st.host.arousal * c.decay, 0, 1))

  // 安慰：迟滞带（进不进看 comfortValence，出不看 recoverValence）
  const cm = st.comfort
  cm.lowTurns = st.host.valence <= c.comfortValence ? cm.lowTurns + 1 : 0
  // 上限触发后上锁：必须先真正缓和一次，才允许再进。
  // （只把 active 置 false 是不够的——他继续低落时 lowTurns 还在涨，下一轮立刻又进，
  //   等于没有上限。这个 bug 是"40 轮"那条测试抓出来的。）
  if (cm.locked && st.host.valence >= c.recoverValence) cm.locked = false
  if (!cm.active && !cm.locked && cm.lowTurns >= c.comfortTurns) {
    cm.active = true
    cm.ramp = 0
    cm.activeTurns = 0
    cm.recoverTurns = 0
  }
  if (cm.active) {
    cm.activeTurns += 1
    cm.recoverTurns = st.host.valence >= c.recoverValence ? cm.recoverTurns + 1 : 0
    if (cm.recoverTurns >= c.recoverTurns) cm.active = false
    if (cm.activeTurns >= c.maxComfortTurns) {
      cm.active = false
      cm.locked = true
      cm.lowTurns = 0
    }
  }
  cm.ramp = round2(rampStep(cm.ramp, cm.active ? 1 : 0, c))

  // 兴头：与安慰对称；**安慰一响，兴头让位**（两个状态机不许同时拨）
  const zp = st.zip
  zp.highTurns = st.host.valence >= c.zipValence ? zp.highTurns + 1 : 0
  if (!zp.active && zp.highTurns >= c.zipTurns && !cm.active) {
    zp.active = true
    zp.ramp = 0
    zp.activeTurns = 0
    zp.cooledTurns = 0
  }
  if (cm.active && zp.active) {
    zp.active = false // 让位
  }
  if (zp.active) {
    zp.activeTurns += 1
    zp.cooledTurns = st.host.valence <= c.zipRecoverValence ? zp.cooledTurns + 1 : 0
    if (zp.cooledTurns >= c.zipRecoverTurns || zp.activeTurns >= c.maxZipTurns) zp.active = false
  }
  zp.ramp = round2(rampStep(zp.ramp, zp.active ? 1 : 0, c))

  return st
}

const levelWord = (v) => (v <= -0.6 ? '很低落' : v < -0.2 ? '偏低' : v < 0.2 ? '平静' : v < 0.6 ? '不错' : '很好')

/**
 * 渲染成**一行数字/枚举**（契约 §11 #6 顶格，情绪块 ≤40 tok）。
 * 平静且没在状态里 → 默认不发（省 token）；要发就 `showWhenQuiet: true`。
 */
export function emotionLine(state, cfg = EMOTION_DEFAULTS) {
  const c = { ...EMOTION_DEFAULTS, ...cfg }
  if (!state) return { text: '', tokens: 0 }
  const cm = state.comfort || {}
  const zp = state.zip || {}
  const active = cm.active || zp.active
  const vivid = Math.abs(Number(state.ai?.valence) || 0) >= 0.3
  if (!active && !vivid && !c.showWhenQuiet) return { text: '', tokens: 0 }

  const bits = []
  if (cm.active) bits.push(`安慰中(${cm.ramp},第${cm.activeTurns ?? 0}轮)`)
  else if (zp.active) bits.push(`兴头中(${zp.ramp},第${zp.activeTurns ?? 0}轮)`)
  else bits.push('常态')
  bits.push(`她${levelWord(Number(state.ai?.valence) || 0)}${state.ai?.valence ?? 0}`)
  bits.push(`他${levelWord(Number(state.host?.valence) || 0)}${state.host?.valence ?? 0}`)

  const text = `<!-- 情绪 -->${bits.join(' · ')}<!-- /情绪 -->`
  return { text, tokens: estTokens(text) }
}
