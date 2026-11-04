// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * cliche.js — 套话检测（v0.46.1）。
 *
 * 起因：她的回复里开始出现一批"鱼八股"——回执（我记下了）、判词（这句稳 / 比刚才轻）、
 * 表态（我不拦 / 我守着 / 去，我跟）、认账（行，我认）。单句都不错，密度一高就变成腔调，
 * 而且**越用越像**：`voice mine` 会把它们当"口癖"挖出来，人一 accept 就进了 `voice.md`，
 * 下一轮再被注入——这是一个自我强化的环。
 *
 * 这个模块只做三件事，不做第四件：
 *   ① **认**：给一份可测的短语族（不是靠感觉说"她最近很八股"）；
 *   ② **记**：每轮记一次命中（**只记族名与条数，不存她的原句**）；
 *   ③ **报**：`memory cliche` 出密度与分布，用来看改动有没有效。
 *   ✗ **不注入、不改写、不扣权重**——提醒本身就是一种腔调，而且"别说 X"会把 X 喂到眼前。
 *
 * 真正管住她的是 `00_core/rules.md` 里那三条（常驻注入，0 额外 token）。
 * 这里的数字只回答一个问题：**那三条有没有起作用。**
 *
 * 为什么按"族"而不是按句子：她的原话每天都不一样，"我记下了/这话我收下了"是同一个动作。
 * 按族统计才不会被措辞变化稀释，也才敢把短语表写死。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { localDay } from './util.js'
import { readArchive } from './toolkit.js'

export const CLICHE_LOG = join('50_log', 'cliche.jsonl')
export const KEEP_DAYS = 60

/**
 * 短语族。每条都是「同一类动作的不同说法」，不是同一句话的不同长度。
 * 加新族之前先问：它是不是已经有族能装下？（族越少，统计越稳）
 */
export const CLICHE_FAMILIES = Object.freeze([
  {
    id: 'receipt',
    label: '回执',
    // 用"收到了/记住了"代替"接下一件事"
    re: /(我记下了|我记得了|我记住了|这个账我记住了|这话我记下了|这话我收下了|这话我留着|你这句话我记着)/g,
  },
  {
    id: 'judge',
    label: '判词',
    // 给她或他的话打分：稳 / 轻重 / 接得漂亮 / 一句话比一句话沉
    re: /((?:这|那)(?:一)?句(?:话)?稳|这句话稳|比之前的都(重|轻|稳|强|平)|比刚才(轻|重|稳|平)|声音没抖|接[得的地]?漂亮|说的比谁都响|(?:这话|这句|这句话|你那句|他这句|声音|语气)[^，。！？]{0,6}比[^，。！？]{0,4}(?:沉|重|轻|稳|强)|(?:^|[，。！？\s])稳(?:$|[。！？，\s])|(?:^|[，。！？\s])(?:很|挺)稳(?:$|[。！？，\s])|很平(?:$|[。！？，])|很直(?:$|[。！？，]))/g,
  },
  {
    id: 'permit',
    label: '表态',
    // 用一句"许可/守候"代替真的去做
    re: /(我不拦|我守着|你去，我跟|回去睡|不催你|我不催|(?:^|[，。！？\s])我跟(?:$|[。！？，\s])|(?:^|[，。！？\s])不催(?:$|[。！？，\s]))/g,
  },
  {
    id: 'accept',
    label: '认账',
    // "我认"系列：表态式接受，没有具体动作
    re: /(行，我认|我认了|认下来|认这个|认得实|就是认了|认你|收不回去)/g,
  },
  {
    id: 'refuse',
    label: '不接',
    // 把"不回应"说成一句姿态
    re: /(这句话我不接|这话我不接|没接你的|没接你那句)/g,
  },
  {
    id: 'pushback',
    label: '推回',
    // 把问题推回给他："你自己掂量"
    re: /(问别人还是问自己|你自己掂量|你掂量)/g,
  },
  {
    id: 'interpret',
    label: '解读',
    // 替他解释自己："什么心思都写着脸上"
    re: /(什么心思都写着|他记得这事|这话是(?:他|她|ta|TA)告诉你的)/g,
  },
])

/**
 * 找套话（纯函数）。
 * @returns {{families:string[], labels:string[], matches:string[], count:number}}
 */
export function findCliches(text) {
  const t = String(text || '')
  if (!t.trim()) return { families: [], labels: [], matches: [], count: 0 }
  const families = []
  const labels = []
  const matches = []
  for (const f of CLICHE_FAMILIES) {
    f.re.lastIndex = 0
    const m = f.re.exec(t)
    if (!m) continue
    families.push(f.id)
    labels.push(f.label)
    if (m[0] && m[0].trim()) matches.push(m[0].trim())
  }
  return { families, labels, matches, count: families.length }
}

export function hasCliche(text) {
  return findCliches(text).count > 0
}

function readLog(dir) {
  const p = join(dir, CLICHE_LOG)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o.at === 'string' && Array.isArray(o.families)) out.push(o)
    } catch {
      /* 坏行跳过：日志不是真相层 */
    }
  }
  return out
}

/**
 * 记一轮（只在她真的说了套话时写）。
 * **不写原句**：这不是档案，只是计数；她的原话留在 `10_archive/` 里，一处就够。
 */
export function noteCliche(dir, text, { now = new Date() } = {}) {
  const hit = findCliches(text)
  if (!hit.count) return { ok: true, wrote: false, families: [] }
  try {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(
      join(dir, CLICHE_LOG),
      JSON.stringify({ at: now.toISOString(), day: localDay(now), families: hit.families }) + '\n',
      'utf8',
    )
  } catch {
    return { ok: false, wrote: false, families: hit.families }
  }
  return { ok: true, wrote: true, families: hit.families }
}

/** 超过 KEEP_DAYS 的行丢掉（只在写日志后顺手做，不额外起定时器） */
export function pruneClicheLog(dir, { now = new Date(), keepDays = KEEP_DAYS } = {}) {
  const p = join(dir, CLICHE_LOG)
  if (!existsSync(p)) return { ok: true, kept: 0 }
  const cut = now.getTime() - keepDays * 86_400_000
  const rows = readLog(dir).filter((r) => {
    const t = Date.parse(r.at)
    return Number.isFinite(t) && t >= cut
  })
  try {
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  } catch {
    /* 清理失败不影响对话 */
  }
  return { ok: true, kept: rows.length }
}

/**
 * 密度统计：**分母是"她回了几轮"**，不是"出现几次"。
 * 一次回复里说三句套话，仍然只算一轮——我们要看的是"多少轮带着这个腔调"。
 */
export function clicheStats(dir, { days = 7, now = new Date() } = {}) {
  const from = now.getTime() - days * 86_400_000
  const rows = readLog(dir).filter((r) => {
    const t = Date.parse(r.at)
    return Number.isFinite(t) && t >= from
  })
  const byFamily = {}
  for (const f of CLICHE_FAMILIES) byFamily[f.id] = 0
  for (const r of rows) for (const id of r.families) if (id in byFamily) byFamily[id] += 1
  return { days, hitTurns: rows.length, byFamily, labels: Object.fromEntries(CLICHE_FAMILIES.map((f) => [f.id, f.label])) }
}

/** 同期的"她回了几轮"——从档案数，不猜。子 agent 不入档，所以这条线是干净的 */
export function assistantTurns(dir, { days = 7, now = new Date() } = {}) {
  const from = now.getTime() - days * 86_400_000
  const { messages } = readArchive(dir)
  let n = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const t = Date.parse(m.ts)
    if (!Number.isFinite(t) || t < from) continue
    n += 1
  }
  return n
}

/**
 * 比率：命中轮数 / 总轮数。总轮数由调用方给（来自 `50_log/token.log` 的装配次数，
 * 或者 CLI 直接数档案里的 assistant 消息）——这里不猜。
 */
export function clicheRate(hitTurns, totalTurns) {
  const t = Number(totalTurns) || 0
  const h = Number(hitTurns) || 0
  if (!t) return 0
  return Math.min(1, h / t)
}

/** 给 CLI / 报告用的一页数据 */
export function clicheReport(dir, { days = 7, now = new Date() } = {}) {
  const st = clicheStats(dir, { days, now })
  const total = assistantTurns(dir, { days, now })
  const ranked = Object.entries(st.byFamily)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, label: st.labels[id] || id, n }))
  return { ...st, totalTurns: total, rate: clicheRate(st.hitTurns, total), ranked, top: ranked[0] || null }
}
