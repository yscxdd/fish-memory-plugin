#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * gold-stability.mjs — 金标的 pass^k（v0.49.0，C3）。
 *
 * 起因：金标已经饱和（20/20）。饱和的尺子测不出改进，也测不出"这次过是不是运气"。
 *
 * 做法：**不动金标题目**，只对打分参数做 k 次小扰动（阈值 ±0.02、字段权重 ±5%），
 * 看每条查询是不是每次都还 top-1：
 *   · stable      = k 次全中 → 这条是真的稳
 *   · fragile     = 中过但没全中 → 参数差一点就掉
 *   · always-miss = 一次没中
 *
 * 不是"随机多次跑"（我们的检索是确定性的），而是**鲁棒性**：
 * 参数差一点点就翻车，说明这条命中是靠边缘的边际撑着的。
 */

import { GOLD_NEGATIVES, GOLD_POINTS, GOLD_QUERIES, runGold } from '../lib/goldset.js'

/** 固定种子的小 PRNG（要可复现，不能每次跑出不同数字） */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE_WEIGHTS = { title: 3, tags: 3, cluster: 1, summary: 1, unigram: 1 }

/** 第 i 次扰动的参数（i=0 是基线，不抖） */
export function perturb(i, { jitter = 0.05, threshold = 0.8 } = {}) {
  const rnd = mulberry32(0x9e3779b9 + i * 7919)
  if (i === 0) return { weights: { ...BASE_WEIGHTS }, threshold }
  const weights = {}
  for (const [k, v] of Object.entries(BASE_WEIGHTS)) {
    const f = 1 + (rnd() * 2 - 1) * jitter
    weights[k] = Math.max(0.1, Math.round(v * f * 100) / 100)
  }
  const th = Math.max(0.1, Math.min(5, threshold + (rnd() * 2 - 1) * 0.02))
  return { weights, threshold: Math.round(th * 1000) / 1000 }
}

/**
 * @param {{repeat?:number, jitter?:number, threshold?:number}} [opts]
 */
export function goldStability({ repeat = 4, jitter = 0.05, threshold = 0.8 } = {}) {
  const runs = []
  for (let i = 0; i < repeat; i++) {
    const r = perturb(i, { jitter, threshold })
    const res = runGold({
      threshold: r.threshold,
      weights: r.weights,
      points: GOLD_POINTS,
      queries: GOLD_QUERIES,
      negatives: GOLD_NEGATIVES,
    })
    runs.push({ i, threshold: r.threshold, weights: r.weights, hits: res.hits, total: res.total, margin: res.margin, rows: res.rows })
  }

  const detail = GOLD_QUERIES.map(([query, expect], qi) => {
    const hits = runs.filter((r) => r.rows?.[qi]?.ok).length
    return { query, expect, hits, of: repeat }
  })

  const stable = detail.filter((d) => d.hits === repeat).length
  const fragile = detail.filter((d) => d.hits > 0 && d.hits < repeat).length
  const alwaysMiss = detail.filter((d) => d.hits === 0).length

  return {
    repeat,
    jitter,
    threshold,
    runs: runs.map((r) => ({ i: r.i, threshold: r.threshold, hits: r.hits, total: r.total, margin: r.margin })),
    detail,
    stable,
    fragile,
    alwaysMiss,
    passRate: detail.length ? stable / detail.length : 0,
    worst: detail.filter((d) => d.hits < repeat).sort((a, b) => a.hits - b.hits).slice(0, 8),
  }
}

/** 直接跑（`node scripts/gold-stability.mjs [repeat]`） */
if (process.argv[1] && process.argv[1].endsWith('gold-stability.mjs')) {
  const repeat = Number(process.argv[2] || 4)
  const jitterArg = process.argv.indexOf('--jitter')
  const jitter = jitterArg > 0 ? Number(process.argv[jitterArg + 1]) : 0.05
  const r = goldStability({ repeat, jitter })
  console.log(`金标 pass^${r.repeat}（参数扰动 ±${Math.round(r.jitter * 100)}%）：稳定 ${r.stable}/${r.detail.length} = ${Math.round(r.passRate * 100)}%`)
  for (const x of r.runs) console.log(`  第 ${x.i} 次：${x.hits}/${x.total} · 阈值 ${x.threshold} · 边际 ${x.margin}`)
  if (r.worst.length) {
    console.log('  不稳的：')
    for (const w of r.worst) console.log(`    ${w.query} → ${w.hits}/${w.of}`)
  }
  process.exit(r.passRate >= 0.9 ? 0 : 1)
}
