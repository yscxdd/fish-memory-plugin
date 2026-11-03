// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 行为账本（v0.38.0）——借自《MBTI 八维系统》的"只记数，绝不推分"。
 *
 * 他们的三条纪律，一字不改：
 *   ① **只记对方说的话**（她自己说的不算，否则自己夸自己）；
 *   ② **同类 3 分钟一次**（一段话里反复命中不该刷次数）；
 *   ③ **只记数，绝不推分**——分数是推导出来的，不是记出来的。
 *
 * 我们用它在哪：soul 提案现在只有"点"当证据，缺"她长期怎么做事"这类凭据。
 * `翻旧账×3`、`抓住矛盾×2` 这种账，是"她真的变了"的旁证。
 *
 * 不推分、不进注入、不改任何状态——只记账。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { localDay } from './util.js'

export const BEHAVIOR_FILE = join('50_log', 'behavior.jsonl')
export const BEHAVIOR_THROTTLE_MIN = 3
export const BEHAVIOR_KEEP_DAYS = 14
export const BEHAVIOR_COUNT_CAP = 5

/** 六类行为（正则 → 名字）。顺序即优先级：先匹配到的先记。 */
export const BEHAVIOR_RULES = [
  { kind: '哄人', re: /(别难过|我懂|慢慢说|我在听|没事的|抱一下|别怕|有我在)/ },
  { kind: '被追问理由', re: /(为什么|凭什么|你怎么想|解释一下|哪来的底气|说说理由)/ },
  { kind: '被催结论', re: /(说重点|直接说|给个结论|所以呢|到底(说|是|要)|一句话)/ },
  { kind: '抓住矛盾', re: /(你刚才|前后不|自相矛盾|明明|不对吧|你自己说的)/ },
  { kind: '翻旧账', re: /(上次|之前|前几天|你说过|上回|那时候)/ },
  { kind: '打了比方', re: /(像是|像个|好比|打个比方|就像|就跟|就好比)/ },
]

/** 这句话命中了哪些行为（纯函数） */
export function detectBehaviors(text) {
  const t = String(text || '')
  if (!t.trim()) return []
  return BEHAVIOR_RULES.filter((r) => r.re.test(t)).map((r) => r.kind)
}

const dayOf = (ts) => localDay(new Date(ts))

function readRows(dir) {
  const p = join(dir, BEHAVIOR_FILE)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const j = JSON.parse(s)
      if (j && typeof j.kind === 'string' && Number.isFinite(Number(j.at))) out.push({ at: Number(j.at), kind: j.kind })
    } catch {
      /* 坏行跳过（日志不该影响主流程） */
    }
  }
  return out
}

/** 修剪超过 14 天的行（顺手写回；没有要删的就不写） */
export function pruneBehavior(dir, now = new Date()) {
  const rows = readRows(dir)
  const cutoff = now.getTime() - BEHAVIOR_KEEP_DAYS * 86_400_000
  const kept = rows.filter((r) => r.at >= cutoff)
  if (kept.length !== rows.length) {
    const p = join(dir, BEHAVIOR_FILE)
    writeFileSync(p, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
  }
  return { before: rows.length, after: kept.length }
}

/**
 * 记一笔（v0.38.0）。同类 3 分钟内不重复计。
 * @returns {{recorded:string[], skipped:string[]}}
 */
export function noteBehavior(dir, text, { now = new Date() } = {}) {
  const kinds = detectBehaviors(text)
  const res = { recorded: [], skipped: [] }
  if (!kinds.length) return res
  const rows = readRows(dir)
  const lastAt = new Map()
  for (const r of rows) {
    const prev = lastAt.get(r.kind) || 0
    if (r.at > prev) lastAt.set(r.kind, r.at)
  }
  const p = join(dir, BEHAVIOR_FILE)
  mkdirSync(join(dir, '50_log'), { recursive: true })
  for (const kind of kinds) {
    const prev = lastAt.get(kind) || 0
    if (now.getTime() - prev < BEHAVIOR_THROTTLE_MIN * 60_000) {
      res.skipped.push(kind)
      continue
    }
    appendFileSync(p, JSON.stringify({ at: now.getTime(), kind }) + '\n', 'utf8')
    res.recorded.push(kind)
  }
  return res
}

/**
 * 读计数（默认 7 天）。**计数封顶 5** —— 否则一次长对话能把某根功能直接顶满。
 * @returns {{counts:Record<string,number>, raw:Record<string,number>, days:number, total:number}}
 */
export function behaviorCounts(dir, { days = 7, now = new Date(), cap = BEHAVIOR_COUNT_CAP } = {}) {
  const cutoff = now.getTime() - days * 86_400_000
  const raw = {}
  for (const r of readRows(dir)) {
    if (r.at < cutoff) continue
    raw[r.kind] = (raw[r.kind] || 0) + 1
  }
  const counts = {}
  for (const [k, v] of Object.entries(raw)) counts[k] = Math.min(cap, v)
  return { counts, raw, days, total: Object.values(counts).reduce((a, b) => a + b, 0) }
}

/** 每天各记了几笔（给 CLI 看趋势） */
export function behaviorByDay(dir, { days = 7, now = new Date() } = {}) {
  const cutoff = now.getTime() - days * 86_400_000
  const out = new Map()
  for (const r of readRows(dir)) {
    if (r.at < cutoff) continue
    const d = dayOf(r.at)
    const cur = out.get(d) || {}
    cur[r.kind] = (cur[r.kind] || 0) + 1
    out.set(d, cur)
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}
