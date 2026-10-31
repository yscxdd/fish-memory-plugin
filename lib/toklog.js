// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * toklog.js — 每轮一行 token 账（《本地模型与 Token 预算设计》§10.2）。
 *
 * 为什么值得写：那句"没有记账的优化等于没优化"——你只会"感觉变快了"，
 * 然后某天发现质量掉了却找不到是哪一刀砍的。
 *
 * 格式照 §10.2，但**只记这里真能测到的**：
 *   {at, turn, mode, gate, header, core, status, work, ghosts, key, index, ability, body, related, total,
 *    rendered, dropped, pressure}
 *
 * 设计里那几列 `history / out / local_prefill / local_ms` 是**宿主与小模型**的账，
 * 插件拿不到（`TokenMeasurement` 只有整包总数）——所以留空不编，要看得去宿主那边查。
 *
 * 只追加、不读改写；一行一个 JSON，坏了就跳过（审计会看到行数对不上，但它不该把对话打挂）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TOKEN_LOG = join('50_log', 'token.log')

/** 记一行。失败不抛（日志不该影响对话）。 */
export function appendTokenLog(dir, entry, now = new Date()) {
  const row = { at: entry.at || now.toISOString(), ...entry }
  try {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, TOKEN_LOG), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读最近 `days` 天（默认 7）。坏行跳过，返回 `{ rows, bad }`。 */
export function readTokenLog(dir, { days = 7, now = new Date() } = {}) {
  const path = join(dir, TOKEN_LOG)
  if (!existsSync(path)) return { rows: [], bad: 0 }
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const rows = []
  let bad = 0
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    if (!row || typeof row.at !== 'string') {
      bad += 1
      continue
    }
    if (row.at >= since) rows.push(row)
  }
  return { rows, bad }
}

const BLOCKS = ['header', 'core', 'status', 'work', 'ghosts', 'key', 'index', 'ability', 'body', 'related']

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0)
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

/**
 * 汇总：**看趋势用的，不是看单轮用的**。
 * 返回总量、均值、峰值、p50、分块均值与占比、按天分组——够回答"哪一层在涨"。
 */
export function summarizeTokenLog(dir, { days = 7, now = new Date() } = {}) {
  const { rows, bad } = readTokenLog(dir, { days, now })
  const totals = rows.map((r) => Number(r.total) || 0).sort((a, b) => a - b)
  const sum = rows.reduce((n, r) => n + (Number(r.total) || 0), 0)
  const blocks = {}
  for (const k of BLOCKS) {
    const vals = rows.map((r) => Number(r[k]) || 0)
    const mean = avg(vals)
    blocks[k] = { avg: mean, max: vals.length ? Math.max(...vals) : 0, share: pct(mean, avg(totals)) }
  }

  const byDay = new Map()
  for (const r of rows) {
    const day = String(r.at).slice(0, 10)
    const d = byDay.get(day) || { day, turns: 0, total: 0 }
    d.turns += 1
    d.total += Number(r.total) || 0
    byDay.set(day, d)
  }

  return {
    days,
    turns: rows.length,
    bad_lines: bad,
    total_tokens: sum,
    avg: avg(totals),
    p50: totals.length ? totals[Math.floor(totals.length / 2)] : 0,
    max: totals.length ? totals[totals.length - 1] : 0,
    gated: rows.filter((r) => r.gate === 'skip').length,
    modes: rows.reduce((m, r) => ({ ...m, [r.mode || 'daily']: (m[r.mode || 'daily'] || 0) + 1 }), {}),
    blocks,
    by_day: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, avg: avg([d.total / d.turns]) })),
  }
}
