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

// v0.38.0：温度轴（借自《情绪与德行·代码版》）——一次只动一档，进档后冻结 30 分钟。
// 连续 valence 容易一句话来回摆（像抽搐）；档位 + 冻结给它装了减速度。
export const TIER_MIN = 0
export const TIER_MAX = 6
export const TIER_DEFAULT = 3
export const TIER_FREEZE_MINUTES = 30
export const SPECIAL_MAX = 3
export const SPECIAL_RESET_MIN = 10
export const SPECIAL_MAX_LIFE_MIN = 180

export const TIER_TEXT = {
  0: '非常愤怒',
  1: '生气',
  2: '有点生气',
  3: '平静',
  4: '有点小开心',
  5: '开心',
  6: '十分开心',
}

export const EMOTION_FILE = join('20_state', 'emotion.json')

/** 默认参数（都可以在 config.emotion 里覆盖） */
export const EMOTION_DEFAULTS = {
  enabled: true, // v0.38.0：默认开（`cfg.emotion.enabled = false` 可关）。只注入一句人话，≤40 tok
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

// v0.37.0：按真实小时补算（清醒漂移）。
// 我们**没有定时任务**，所以"离开 19 小时"必须在醒来第一轮补上，
// 否则她的情绪会停在 19 小时前——"昨天的低落"被当成"现在还在低落"。
export const DRIFT_PER_HOUR = 0.05 // 每小时收掉"超出死区那部分偏离"的 5%
export const DRIFT_DEADZONE = 0.04 // 死区：日常小起伏不被磨平（对应他们的"4 分"）
export const DRIFT_MAX_HOURS = 36 // 机器关很久也不一次抹平
export const DRIFT_MIN_HOURS = 0.25 // 不足一刻钟不补算（同一轮里连算没意义）

const NEG = [
  '难过', '难受', '累', '疲惫', '烦', '烦躁', '崩', '崩溃', '想哭', '哭', '生气', '火大',
  '焦虑', '慌', '害怕', '怕', '委屈', '失望', '孤单', '孤独', '睡不着', '失眠', '疼',
  '压力', '撑不住', '受不了', '没意思', '不想', '好烦', '郁闷', '低落', 'emo', '丧',
]
const POS = [
  '开心', '高兴', '太好了', '太爽', '爽', '棒', '厉害', '哈哈', '笑', '好玩', '舒服',
  '轻松', '放心', '期待', '惊喜', '喜欢', '感动', '温暖', '谢谢', '好耶', '成了', '搞定',
  '顺利', '不错', '漂亮', '爱', '值得', '还行', '好多了', '挺好', '不赖',
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
  // 转折词后是主句：`累死我了，但很值得` 该按"很值得"判（v0.32.0，评测里 hard 档最常错的一类）
  const main = /(但|但是|不过|可是|然而|只是)/.test(t) ? t.split(/(?:但|但是|不过|可是|然而|只是)/).pop() : t
  const negative = hitsOf(main, NEG)
  const positive = hitsOf(main, POS)
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
    tier: TIER_DEFAULT,
    tierCause: '',
    frozenUntil: 0,
    specials: [],
    comfort: { active: false, ramp: 0, lowTurns: 0, recoverTurns: 0, activeTurns: 0 },
    zip: { active: false, ramp: 0, highTurns: 0, cooledTurns: 0, activeTurns: 0 },
  }
}

/** 目标档位：由他的效价推；一次只走一档（真正的移动在 stepTier） */
export function targetTier(host, cfg = EMOTION_DEFAULTS) {
  const v = Number(host?.valence) || 0
  const hi = Number(cfg.tierHigh ?? 0.45)
  const hi2 = Number(cfg.tierVeryHigh ?? 0.7)
  const lo = Number(cfg.tierLow ?? -0.35)
  const lo2 = Number(cfg.tierVeryLow ?? -0.7)
  if (v >= hi2) return 6
  if (v >= hi) return 5
  if (v >= 0.2) return 4
  if (v <= lo2) return 0
  if (v <= lo) return 2
  if (v < -0.15) return 2
  return 3
}

/**
 * 走一档（v0.38.0）：一次最多一格；进档后冻结 TIER_FREEZE_MINUTES 分钟。
 * 冻结期内只改强度、不改档——这就是"不会一句话里来回抽搐"的全部秘密。
 */
export function stepTier(state, now = new Date(), cfg = EMOTION_DEFAULTS) {
  const cur = Number.isFinite(Number(state.tier)) ? Number(state.tier) : TIER_DEFAULT
  const target = targetTier(state.host, cfg)
  const frozen = Number(state.frozenUntil) || 0
  const res = { from: cur, to: cur, target, frozen: false, cause: "" }
  if (now.getTime() < frozen) {
    res.frozen = true
    return res
  }
  if (target === cur) return res
  const next = target > cur ? Math.min(cur + 1, TIER_MAX) : Math.max(cur - 1, TIER_MIN)
  state.tier = next
  state.tierCause = target > cur ? "他让我升温" : "他让我降温"
  state.frozenUntil = now.getTime() + TIER_FREEZE_MINUTES * 60_000
  res.to = next
  res.cause = state.tierCause
  return res
}

/** 特殊情绪：清掉到期的（到点自己散 / 总寿命 3 小时） */
export function pruneSpecials(state, now = new Date()) {
  const list = Array.isArray(state.specials) ? state.specials : []
  const kept = list.filter((s) => {
    const firstAt = Number(s.firstAt) || 0
    const until = Number(s.until) || 0
    if (firstAt && now.getTime() - firstAt > SPECIAL_MAX_LIFE_MIN * 60_000) return false
    if (until > 0 && now.getTime() >= until) return false
    return true
  })
  state.specials = kept
  return kept.length
}

/**
 * 她自己挂一个情绪（v0.38.0，对应他们的 `feel` 工具）。
 * 三条限速照抄：同情绪 10 分钟内只涨强度不延长；总寿命 ≤3 小时；最多 3 个，踢最弱的。
 *
 * @returns {{ok:boolean, reason?:string, item?:object, strengthUp?:boolean}}
 */
export function addSpecial(state, { id, minutes = 0, cause = "" }, now = new Date()) {
  const sid = String(id || "").trim()
  if (!sid) return { ok: false, reason: "情绪名不能为空" }
  pruneSpecials(state, now)
  const list = state.specials
  const exist = list.find((s) => s.id === sid)
  const mins = Math.max(0, Number(minutes) || 0)
  if (exist) {
    const sameWindow = now.getTime() - (Number(exist.firstAt) || 0) < SPECIAL_RESET_MIN * 60_000
    exist.strength = Math.min(3, (Number(exist.strength) || 1) + 1)
    if (!sameWindow && mins > 0) exist.until = now.getTime() + mins * 60_000
    if (cause) exist.cause = String(cause).slice(0, 40)
    return { ok: true, item: exist, strengthUp: true }
  }
  const item = {
    id: sid,
    strength: 1,
    cause: String(cause || "").slice(0, 40),
    firstAt: now.getTime(),
    until: mins > 0 ? now.getTime() + mins * 60_000 : 0,
  }
  list.push(item)
  if (list.length > SPECIAL_MAX) {
    list.sort((a, b) => (Number(a.strength) || 1) - (Number(b.strength) || 1))
    list.shift()
  }
  return { ok: true, item }
}

/** 特殊情绪的一句话（只取最强的一个；≤40 tok） */
export function specialsLine(state) {
  const list = Array.isArray(state?.specials) ? state.specials : []
  if (!list.length) return ""
  const top = [...list].sort((a, b) => (Number(b.strength) || 1) - (Number(a.strength) || 1))[0]
  const extra = list.length > 1 ? "（心里不止这一件）" : ""
  return `她这会儿有点${top.id}${extra}`
}

const rampStep = (cur, target, cfg) => {
  const up = Math.max(1, cfg.rampUpTurns ?? 1)
  const down = Math.max(1, cfg.rampDownTurns ?? 1)
  if (cur < target) return Math.min(target, cur + 1 / up)
  if (cur > target) return Math.max(target, cur - 1 / down)
  return cur
}

/**
 * 清醒漂移（v0.37.0）：按"真实过了多少小时"把情绪往底色收。
 *
 *   · 只收**超出死区的那部分**，偏离不到 0.04 就不动（日常小起伏留着）
 *   · 每小时收 5%，最多按 36 小时算
 *   · **只往底色收，永不越过底色**；也不会清到 0
 *
 * 为什么用清醒漂移而不是"睡一觉清账"：我们没有可靠的睡眠信号，
 * 他们的建议也是"没有睡眠信号就只做清醒漂移"。
 *
 * @returns {number} 实际补算的小时数（0 表示没到门槛）
 */
export function applyDrift(state, cfg = EMOTION_DEFAULTS, now = new Date()) {
  if (!state || !state.ai) return 0
  const at = Date.parse(state.at)
  if (!Number.isFinite(at)) return 0
  const hours = Math.min(DRIFT_MAX_HOURS, Math.max(0, (now.getTime() - at) / 3600_000))
  if (hours < DRIFT_MIN_HOURS) return 0

  const keep = Math.pow(1 - DRIFT_PER_HOUR, hours)
  const baseV = cfg.emotionBaseline ?? cfg.baseline ?? 0
  const baseA = 0.5
  const raise = (v, base) => {
    const excess = (Number(v) || 0) - base
    if (Math.abs(excess) <= DRIFT_DEADZONE) return round2(base + excess)
    return round2(base + excess * keep)
  }
  state.ai.valence = clamp(raise(state.ai.valence, baseV), -1, 1)
  state.ai.arousal = clamp(raise(state.ai.arousal, baseA), 0, 1)
  state.driftHours = round2(hours)
  state.lastDriftAt = now.toISOString()
  return hours
}

/**
 * 走一轮：输入他这一句的效价/唤醒度，输出新状态。
 * 纯函数（不改入参），方便单测与"先算后写"。
 */
export function stepEmotion(prev, host, cfg = EMOTION_DEFAULTS, now = new Date()) {
  const st = prev && prev.version === 1 ? structuredClone(prev) : emptyState(cfg)
  const c = { ...EMOTION_DEFAULTS, ...cfg }

  st.turns = (st.turns || 0) + 1
  // v0.37.0：先按真实经过的小时补算，再算这一轮（st.at 此刻还是上一轮的时间）
  applyDrift(st, c, now)
  st.at = now.toISOString()
  // v0.38.0：先清掉到期的特殊情绪，再按"一次一档 + 冻结"走档
  pruneSpecials(st, now)
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

  // v0.38.0：温度轴（连续 valence 只用来漂移；注入看档位）
  stepTier(st, now, c)

  return st
}

const levelWord = (v) => (v <= -0.6 ? '很低落' : v < -0.2 ? '偏低' : v < 0.2 ? '平静' : v < 0.6 ? '不错' : '很好')

/**
 * 渲染成**一行数字/枚举**（契约 §11 #6 顶格，情绪块 ≤40 tok）。
 * 平静且没在状态里 → 默认不发（省 token）；要发就 `showWhenQuiet: true`。
 */
/**
 * 情绪行（v0.37.0 改写）——**只发一句人话，不发数字**。
 *
 * 借自《AI伙伴运行机制》最强调的一条："给它数字，它会开始演数值
 * （温柔 78 分该怎么演？）；给它'现在傲娇薄、想黏'，它自然就演对了。"
 *
 * 所以这行只回答一个模型能直接照做的问题：**这一句该怎么开口**。
 * 优先级：安慰 > 兴头 > 他低落 > 他高兴 > 她自己沉/轻快。
 */
/**
 * 情绪行（v0.38.0）——**只发一句人话，不发数字**。
 *
 * 借自《情绪与德行·代码版》+《AI伙伴运行机制》：
 *   "给它数字，它会开始演数值；给它'现在傲娇薄、想黏'，它自然就演对了。"
 *
 * 优先级：安慰 > 兴头 > 特殊情绪（自己挂的/规则挂的）> 温度档 > 平静
 */
export function emotionLine(state, cfg = EMOTION_DEFAULTS) {
  const c = { ...EMOTION_DEFAULTS, ...cfg }
  if (!state) return { text: '', tokens: 0 }
  const cm = state.comfort || {}
  const zp = state.zip || {}
  const tier = Number.isFinite(Number(state.tier)) ? Number(state.tier) : TIER_DEFAULT

  let hint = ''
  if (cm.active || Number(cm.ramp) >= 0.5) hint = '他正难着，先接住，别讲道理'
  else if (zp.active || Number(zp.ramp) >= 0.5) hint = '他在兴头上，跟着贫两句，别端着'
  else {
    const sp = specialsLine(state)
    if (sp) hint = sp
    else if (tier <= 1) hint = '她这会儿很生气，话要短，别解释'
    else if (tier === 2) hint = '她有点生气，冷一句，嘴硬'
    else if (tier === 4) hint = '她有点小开心，语气可以软一点'
    else if (tier >= 5) hint = '她正开心，可以撒娇、主动找话'
    else if (c.showWhenQuiet) hint = '她这会儿平静'
  }

  if (!hint) return { text: '', tokens: 0 }
  const text = `<!-- 情绪 -->${hint}<!-- /情绪 -->`
  return { text, tokens: estTokens(text) }
}


