// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 注意力加权（v0.41.0，② 组）——借自 digital-life-core 的 `memory-affinity`。
 *
 * 他们的做法：按情绪（皮质醇）把记忆分成 `crisis | daily | neutral`，
 * 危机加权 3、日常 0.1，再乘到检索分上。
 *
 * 我们的问题：**情绪层和检索是两条平行线**——她压力大时，检索不会偏向"危机"那类事。
 *
 * 三条规矩：
 *   ① 分类靠**标签/簇**，不靠语义（我们零依赖）；
 *   ② 加权只在"有压力"时抬危机、压日常；平静时全部 1（不偏袒）；
 *   ③ 只乘分数，不过滤——压到 0.1 的点仍然能被检索到。
 */

export const CRISIS_WEIGHT = 3
export const DAILY_WEIGHT = 0.1
export const STRESS_TIER_MAX = 2 // tier ≤2（生气及以下）算有压力
export const STRESS_VALENCE = -0.5 // 他的效价 ≤ 这个也算
export const CALM_MULTIPLIER = 1

const CRISIS_RE = /(危机|紧急|急事|吵架|吵|生病|住院|手术|受伤|出事了|崩溃|危险|手术|急诊|抢救|去世|葬礼|分手)/
const DAILY_RE = /(日常|闲聊|吃饭|天气|睡觉|上班|下班|地铁|午饭|晚饭|打游戏|刷视频)/

/** 这条点是危机 / 日常 / 中性 */
export function classifyAttention(point) {
  const hay = [point?.cluster || '', (point?.tags || []).join(' '), point?.title || ''].join(' ')
  if (CRISIS_RE.test(hay)) return 'crisis'
  if (DAILY_RE.test(hay)) return 'daily'
  return 'neutral'
}

/** 此刻算不算"有压力"（她的档位或他的效价） */
export function isStressed({ tier = null, valence = null } = {}) {
  // 注意：Number(null) === 0，直接判 isFinite 会把"没给"当成 0（档位 0 = 非常愤怒）
  if (tier != null && tier !== '' && Number.isFinite(Number(tier)) && Number(tier) <= STRESS_TIER_MAX) return true
  if (valence != null && valence !== '' && Number.isFinite(Number(valence)) && Number(valence) <= STRESS_VALENCE) return true
  return false
}

/**
 * 检索权重乘数。
 * @param {'crisis'|'daily'|'neutral'} kind
 * @param {{stress?:boolean}} opts
 */
export function attentionMultiplier(kind, { stress = false } = {}) {
  if (!stress) return CALM_MULTIPLIER
  if (kind === 'crisis') return CRISIS_WEIGHT
  if (kind === 'daily') return DAILY_WEIGHT
  return 1
}

/** 从情绪状态里取"压力"信号（读不到就当没压力） */
export function stressFromEmotion(state) {
  if (!state) return false
  return isStressed({ tier: state.tier, valence: state.host?.valence })
}

/** 体检用：三类各多少 */
export function attentionCounts(points) {
  const out = { crisis: 0, daily: 0, neutral: 0 }
  for (const p of points) out[classifyAttention(p)] += 1
  return out
}
