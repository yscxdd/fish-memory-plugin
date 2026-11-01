// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * stats.js — 用真实日志算账（v0.24.0）。
 *
 * 为什么要有：阈值 0.8、预算 1700、salience 权重、情绪迟滞带……这些数字全是**拍的**。
 * 没有统计就只能靠"感觉这轮有点长"来调。而 `token.log` / `retrieval.log` 已经把
 * 每轮的数字都记下来了（只记数字，不记内容），差的只是**把它们加起来**。
 *
 * 三个口径分开看，别混：
 *   - **注入**：我们花掉的 token（均值/中位/峰值 + 分层占比）
 *   - **门控/命中**：`gate=skip` 多少轮（query 没进来 or 纯语气）、`rendered>0` 多少轮（真命中）
 *   - **耗时**：`retrieval.log` 的 `ms`（检索慢了要看得见）
 *
 * 只读日志，不写任何东西；`--json` 给脚本用。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { estTokens } from './util.js'
import { latestSelf } from './self.js'
import { readPointFiles } from './toolkit.js'

const LAYERS = ['header', 'core', 'status', 'index', 'body', 'work', 'emotion', 'due', 'ability', 'footer']

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object') out.push(o)
    } catch {
      /* 坏行跳过：日志不是数据源 */
    }
  }
  return out
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)

/**
 * @param {string} dir 记忆库
 * @param {{days?:number, now?:Date}} opts
 */
export function computeStats(dir, { days = 7, now = new Date() } = {}) {
  const cutoff = now.getTime() - days * 86_400_000
  const within = (o) => {
    const t = Date.parse(o.at)
    return Number.isFinite(t) && t >= cutoff
  }

  const tokens = readJsonl(join(dir, '50_log', 'token.log')).filter(within)
  const retrievals = readJsonl(join(dir, '50_log', 'retrieval.log')).filter(within)

  const totals = tokens.map((r) => Number(r.total) || 0).filter((n) => n > 0)
  const layers = {}
  for (const k of LAYERS) {
    const xs = tokens.map((r) => Number(r[k]) || 0).filter((n) => n > 0)
    if (xs.length) layers[k] = Math.round(mean(xs))
  }

  const skipped = tokens.filter((r) => r.gate === 'skip').length
  const modes = {}
  for (const r of tokens) modes[r.mode || 'unknown'] = (modes[r.mode || 'unknown'] || 0) + 1

  const gated = retrievals.filter((r) => r.gated).length
  const hits = retrievals.filter((r) => Array.isArray(r.rendered) && r.rendered.length > 0)
  const renderedCounts = hits.map((r) => r.rendered.length)
  const droppedTotal = retrievals.reduce((a, r) => a + (Array.isArray(r.dropped) ? r.dropped.length : 0), 0)
  const coreDroppedTotal = retrievals.reduce((a, r) => a + (Array.isArray(r.coreDropped) ? r.coreDropped.length : 0), 0)
  const msTotal = retrievals.map((r) => Number(r.ms?.total)).filter((n) => Number.isFinite(n))

  return {
    days,
    from: new Date(cutoff).toISOString(),
    to: now.toISOString(),
    turns: tokens.length,
    injection: {
      mean: Math.round(mean(totals)),
      median: median(totals),
      max: totals.length ? Math.max(...totals) : 0,
      layers,
    },
    gate: { skipped, skippedPct: pct(skipped, tokens.length) },
    retrieval: {
      rows: retrievals.length,
      gated,
      gatedPct: pct(gated, retrievals.length),
      hits: hits.length,
      hitPct: pct(hits.length, retrievals.length),
      avgRendered: Math.round(mean(renderedCounts) * 10) / 10,
      dropped: droppedTotal,
      coreDropped: coreDroppedTotal,
      msMean: msTotal.length ? Math.round(mean(msTotal)) : null,
    },
    modes,
  }
}

/**
 * 把"每轮注入 token"换算成钱。
 * @param {{mean:number}} injection
 * @param {{yuanPerMTok?:number, turnsPerDay?:number}} opts 默认 ¥4/M（DeepSeek flash 峰值、未命中）
 */
export function estimateCost(injection, { yuanPerMTok = 4, turnsPerDay = 100 } = {}) {
  const perTurn = ((Number(injection?.mean) || 0) / 1_000_000) * yuanPerMTok
  return {
    yuanPerMTok,
    perTurn,
    perDay: perTurn * turnsPerDay,
    perMonth: perTurn * turnsPerDay * 30,
    turnsPerDay,
  }
}

/**
 * 一个素材"记了几条"（v0.24.0，给 `stats` 用）。
 * 注意：这是从点里数出来的，不是从清单数——没被任何点引用的素材会显示 0。
 */
export function assetUsage(points, books = {}) {
  const out = new Map()
  for (const id of Object.keys(books)) out.set(id, { id, title: books[id].title, kind: books[id].kind, points: 0 })
  for (const p of points) {
    for (const s of p.source || []) {
      const m = /^(?:asset|book):(?:([a-z]+):)?([A-Za-z0-9._-]+)/.exec(String(s))
      if (!m) continue
      const id = m[2]
      const row = out.get(id) || { id, title: id, kind: m[1] || 'book', points: 0 }
      row.points += 1
      out.set(id, row)
    }
  }
  return [...out.values()].sort((a, b) => b.points - a.points)
}

/** 给 `stats` 的输出补上"每轮注入大概几个字节"，方便肉眼对照 estTokens */
export const tokensPerByte = (text) => estTokens(text)
/**
 * 成熟度分级（v0.28.1）——借《数字生命》的 L1–L4，但按**我们库里的真东西**定义：
 *
 *   L0 未开始   没有记忆点，也没有自述
 *   L1 萌芽     有点，但还没有自述（她只剩"经历"，还不会讲自己）
 *   L2 成长     有自述（会讲自己了），但还没走过一次人格修订
 *   L3 成熟     有自述 + 至少一次 soul 修订
 *
 * 「停滞」是叠加标记，不是级别：30 天没有新点 / 60 天没有新自述。
 * 只读，不写任何文件。
 */
export function maturity(dir, { now = new Date() } = {}) {
  const points = readPointFiles(dir, '30_points').filter((p) => p.status === 'active')
  const selfText = latestSelf(dir)
  const changelogPath = join(dir, '00_core', 'core_changelog.md')
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
  const revisions = (changelog.match(/soul\.md\s*\|\s*v\d+/g) || []).length

  const days = (ts) => {
    const t = Date.parse(ts)
    return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86_400_000) : null
  }
  const newest = points
    .map((p) => p.date || '')
    .filter(Boolean)
    .sort()
    .pop()
  const lastPointDays = newest ? days(`${newest}T00:00:00Z`) : null
  const selfFiles = existsSync(join(dir, '15_self')) ? readdirSync(join(dir, '15_self')).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort() : []
  const lastSelfDays = selfFiles.length ? days(`${selfFiles[selfFiles.length - 1]}-01T00:00:00Z`) : null

  let stage = 'L0'
  let label = '未开始'
  if (points.length && !selfText) {
    stage = 'L1'
    label = '萌芽'
  } else if (selfText && !revisions) {
    stage = 'L2'
    label = '成长'
  } else if (selfText && revisions) {
    stage = 'L3'
    label = '成熟'
  }

  const stalled = (lastPointDays != null && lastPointDays > 30) || (lastSelfDays != null && lastSelfDays > 60)
  const reasons = []
  if (!points.length) reasons.push('还没有记忆点')
  if (!selfText) reasons.push('还没有自述')
  if (!revisions) reasons.push('还没走过一次人格修订')
  if (stalled) reasons.push('30 天没有新点 / 60 天没有新自述')

  return { stage, label, points: points.length, self: selfFiles.length, revisions, lastPointDays, lastSelfDays, stalled, reasons }
}