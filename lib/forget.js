// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * forget.js — 遗忘与墓碑（契约 §9 / 总设计 §9.2）。
 *
 * 公式（MEMORY.md §五）：
 *   R(t,S) = (1 + (19/81) · t/S)^(-0.5)
 *   S0 = 1 + 3·salience（arousal > 0.7 时 ×1.8；插件拿不到情绪，先按 0.5 算）
 *   成功复述 S' = S·(1 + 0.3·(1-R))   —— 复述这条由写入方维护，forget 不改 S
 *
 * 只做两步自动转换（契约 §7.2）：
 *   active  → demoted   R<0.6 且 salience≤3 且 age≥90
 *   demoted → dormant   R<0.5 且 salience≤2 且 age≥180 且 rehearsal=0
 * **pinned / boundary / promise 永不参与遗忘。**
 * **任何自动删除都不存在。**
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, atomicWriteText, readJsonSafe } from './util.js'
import { readPointFiles, buildIndex, writeIndex } from './toolkit.js'
import { arousalFor } from './strength.js'

const PROTECTED_TYPES = new Set(['boundary', 'promise'])

export function isProtected(p) {
  return p.pinned === true || PROTECTED_TYPES.has(p.type)
}

/** 可提取度 R(t,S)，t 与 S 都以「天」为单位 */
export function retrievability(S, days) {
  if (!(S > 0) || days < 0) return 0
  return Math.pow(1 + (19 / 81) * (days / S), -0.5)
}

export function initialStability(salience, arousal = null) {
  const base = 1 + 3 * Math.max(1, Math.min(5, salience))
  // 情绪唤醒 >0.7 的记忆更难忘（总设计 §9.2）
  return arousal != null && arousal > 0.7 ? base * 1.8 : base
}

/** 天差（now - iso），失败返回 Infinity（让正则会保守跳过） */
function ageDays(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now.getTime() - t) / 86_400_000)
}

/**
 * 算出这一轮该动谁，不写任何文件。
 * @returns {{plan: object[], state: object}}
 */
export function planForget(dir, { now = new Date() } = {}) {
  const points = readPointFiles(dir, '30_points')
  const statePath = join(dir, '20_state', 'state.json')
  const raw = readJsonSafe(statePath, {})
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const plan = []
  let skippedFixture = 0
  let skippedProtected = 0

  for (const p of points) {
    if (p.fixture) {
      skippedFixture += 1
      continue
    }
    if (isProtected(p)) {
      skippedProtected += 1
      continue
    }
    const st = state[p.id] && typeof state[p.id] === 'object' ? state[p.id] : {}
    const S = Number(st.S) > 0 ? Number(st.S) : initialStability(p.salience, arousalFor(p))
    const r = Number(st.r) || 0
    const last = st.ll || p.date
    const age = ageDays(last, now)
    const R = retrievability(S, age)

    let action = 'keep'
    let reason = ''
    if (p.status === 'active' && R < 0.6 && p.salience <= 3 && age >= 90) {
      action = 'demote'
      reason = 'R<0.6 且 salience≤3 且 age≥90'
    } else if (p.status === 'demoted' && R < 0.5 && p.salience <= 2 && age >= 180 && r === 0) {
      action = 'dormant'
      reason = 'R<0.5 且 salience≤2 且 age≥180 且 rehearsal=0'
    }

    plan.push({
      id: p.id,
      title: p.title,
      status: p.status,
      salience: p.salience,
      age: Math.round(age),
      S: +S.toFixed(2),
      R: +R.toFixed(3),
      rehearsal: r,
      action,
      reason,
      last,
    })
    // 把初始化后的 S 写回状态，下一次不用重算
    if (!state[p.id]) state[p.id] = { S: +S.toFixed(2), r: 0, lc: 0, ll: last, st: p.status, merged_into: null }
  }
  return { plan, state, skipped: { fixture: skippedFixture, protected: skippedProtected } }
}

/** 落地：改 status + 写墓碑 + 重建索引 + 落 state */
export function applyForget(dir, { now = new Date(), plan, state } = {}) {
  const computed = plan && state ? { plan, state } : planForget(dir, { now })
  const p = computed.plan
  const st = computed.state
  const acts = p.filter((x) => x.action !== 'keep')
  if (!acts.length) return { changed: 0 }

  const points = readPointFiles(dir, '30_points')
  for (const a of acts) {
    const point = points.find((x) => x.id === a.id)
    if (!point) continue
    const nextStatus = a.action === 'demote' ? 'demoted' : 'dormant'
    const patched = point.raw.replace(/^status:.*$/m, `status: ${nextStatus}`)
    atomicWriteText(point.file, patched)
    if (st[a.id]) st[a.id].st = nextStatus
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(
      join(dir, '50_log', 'eviction.log'),
      JSON.stringify({
        point: a.id,
        action: a.action,
        at: now.toISOString().slice(0, 10),
        R: a.R,
        S: a.S,
        salience: a.salience,
        rehearsal: a.rehearsal,
        reason: a.reason,
      }) + '\n',
      'utf8',
    )
  }

  atomicWriteJson(join(dir, '20_state', 'state.json'), st)
  writeIndex(dir, buildIndex(readPointFiles(dir, '30_points')))
  return { changed: acts.length }
}
