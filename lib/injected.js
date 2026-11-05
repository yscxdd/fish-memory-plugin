// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * injected.js — 跨轮去重（v0.61.0）。
 *
 * 为什么补这个：人在意的第一个毛病不是"忘"，是**"怎么又提这件事"**。
 * 我们原来只有"同一轮内的相似去重"（`dedupeSimilar`，0.78），
 * 同一个点上一轮讲过、这一轮又原样端出来，完全没人挡。
 *
 * 做法（借 dsn-mnemo 的 `cooldownTurns` 思路，独立实现）：
 *   · 记 `(session, pointId) → 最近一次被注入的轮次`；
 *   · 窗口默认 10 轮；窗口内不再注入（分数照算，只是不占名额）；
 *   · **只在内存里**——重启就忘，可接受（比落盘更不容易变成"永久拉黑"）；
 *   · 窗口设 0 = 关闭。
 *
 * 一条硬规则：**被挡掉的条数要记日志**。否则"她今天怎么这么冷淡"会查不出原因。
 */

export const DEFAULT_RECENT_TURNS = 10
const MAX_SESSIONS = 200

/** @type {Map<string, Map<string, number>>} */
const shown = new Map()

const key = (session, id) => `${session}\u0000${id}`

/**
 * 过滤掉窗口内已经讲过的点。
 * @param {string} session
 * @param {number} turn 当前轮次（递增整数）
 * @param {Array<{id:string}>} points
 * @param {number} window 轮次窗口；0 = 关闭
 * @returns {{kept:Array, skipped:number}}
 */
export function filterRecentlyShown(session, turn, points, window = DEFAULT_RECENT_TURNS) {
  if (!window || window <= 0 || !points?.length) return { kept: points || [], skipped: 0 }
  const m = shown.get(session)
  if (!m) return { kept: points, skipped: 0 }
  const kept = []
  let skipped = 0
  for (const p of points) {
    const last = m.get(key(session, p.id))
    if (last != null && turn - last < window) {
      skipped += 1
      continue
    }
    kept.push(p)
  }
  return { kept, skipped }
}

/** 记下这一轮实际注入了哪些点 */
export function noteShown(session, turn, points) {
  if (!session || !points?.length) return
  let m = shown.get(session)
  if (!m) {
    m = new Map()
    shown.set(session, m)
    if (shown.size > MAX_SESSIONS) {
      const oldest = shown.keys().next().value
      if (oldest !== undefined) shown.delete(oldest)
    }
  }
  for (const p of points) m.set(key(session, p.id), turn)
}

/** 测试用：清空（不在生产路径调用） */
export function resetShown() {
  shown.clear()
}

/** 测试用：看当前窗口状态 */
export function shownFor(session) {
  const m = shown.get(session)
  return m ? new Map(m) : new Map()
}
