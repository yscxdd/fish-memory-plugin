// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * strength.js — 六维强度（FSRS 思路的简化版）。
 * S 稳定性 / R 可提取性 / D 难度 / N 新近性 / F 频率 / C 语义重要性。
 * 权重只由可观测信号组成，没有一项来自模型自评。
 */

export function initialS(salience, arousal = null) {
  const base = 1 + 3 * Math.max(1, Math.min(5, salience))
  return arousal != null && arousal > 0.7 ? base * 1.8 : base
}

export function retrievability(S, days) {
  if (!(S > 0) || days < 0) return 0
  return Math.pow(1 + (19 / 81) * (days / S), -0.5)
}

/** 难度：显著度越高越"容易保持"（FSRS 的 difficulty 反向） */
export function difficultyOf(salience) {
  return Math.max(1, Math.min(10, 11 - 2 * Math.max(1, Math.min(5, salience))))
}

export function recency(days) {
  return 1 / (1 + Math.max(0, days) / 30)
}

export function frequency(rehearsal) {
  const r = Number(rehearsal)
  return Math.log(1 + (Number.isFinite(r) && r > 0 ? r : 0)) / Math.log(11)
}

/** 关联密度：links + 是否属于事件簇 */
export function centrality(point) {
  const links = (point.links || []).length
  return Math.min(1, (links + (point.event ? 1 : 0)) / 5)
}

export function weightOf({ R, N, F, C, salience }) {
  return 0.35 * R + 0.15 * N + 0.15 * F + 0.2 * C + 0.15 * Math.max(0, Math.min(1, (salience || 1) / 5))
}

export function dimsOf(point, st = {}, now = Date.now()) {
  const S = Number(st.S) > 0 ? Number(st.S) : initialS(point.salience, point.arousal)
  const last = st.ll || point.date || new Date(now).toISOString()
  const raw = (now - Date.parse(last)) / 86_400_000
  const days = Number.isFinite(raw) ? Math.max(0, raw) : 0
  return {
    S,
    R: retrievability(S, days),
    D: Number(st.D) > 0 ? Number(st.D) : difficultyOf(point.salience),
    N: recency(days),
    F: frequency(st.r),
    C: centrality(point),
    salience: point.salience,
    days,
  }
}

export function weight(point, st = {}, now = Date.now()) {
  return weightOf(dimsOf(point, st, now))
}

/** R 掉到目标值时需要的天数（FSRS 的 interval） */
export function nextReview(S, targetR = 0.9) {
  return S * (81 / 19) * (1 / (targetR * targetR) - 1)
}

/** 复习后更新：S↑、r+1；提到则 D−，连续没提才 D+ */
export function applyReview(st = {}, R = 0.5, { mentioned = false } = {}) {
  const S = Number(st.S) > 0 ? Number(st.S) : 7
  const D = Number(st.D) > 0 ? Number(st.D) : 5
  return {
    ...st,
    S: mentioned ? +(S * (1 + 0.3 * (1 - R))).toFixed(2) : S,
    D: mentioned ? Math.max(1, +(D - 0.5).toFixed(2)) : Math.min(10, +(D + 0.3).toFixed(2)),
    r: (Number(st.r) || 0) + 1,
    ll: new Date().toISOString(),
  }
}
