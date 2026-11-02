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

import { appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWriteJson, atomicWriteText, readJsonSafe } from './util.js'
import { readPointFiles, buildIndex, writeIndex } from './toolkit.js'
import { arousalFor } from './strength.js'

const PROTECTED_TYPES = new Set(['boundary', 'promise'])

// ── v0.29：遗忘层（独立目录）+ 复活 ───────────────────────────────
export const DORMANT_DIR = '31_dormant'
export const DORMANT_R = 0.72 // 第一轮：R 掉到这就进层（salience≤2）
export const DORMANT_DAYS = 30 // 且至少这么老
export const DORMANT_R_HARD = 0.57 // salience=3 走慢的那条
export const DORMANT_DAYS_HARD = 90
export const RESURRECT_WEIGHT = 0.75 // 遗忘层在检索里的分数权重
export const RESURRECT_BOOST = 1.6 // 复活时 S 的倍率（回忆强化）
export const RESURRECT_PERMANENT_AFTER = 3 // 复活 3 次 → pin: soft，永不再进层
export const RESURRECT_GRACE_DAYS = 15
// v0.29.1：抄自"遗忘补丁"的两条
export const MAX_ACTIVE = 200 // 「本子」容量：active 超过这么多就按最低 R 下沉
export const SUPERSEDED_MIN_AGE_DAYS = 7 // 已取代的点：满 7 天就让位（不听 R）

// v0.30：第二轮（正常参数）→ 删除
export const PURGE_R = 0.2 // 遗忘层里 R 掉到这，就该真删
export const PURGE_DAYS = 180 // 或层内待够这么久（兜底）
export const PURGE_BATCH = 10 // 一次最多删几条（防跑飞）
export const FRAGMENT_MAX = 12 // 墓碑里残片的最大字数（"断在最不该断的地方"）
export const PURGED_DIR = '32_purged'

export function isProtected(p) {
  // hard pin / 底线类：永不遗忘
  // soft pin：也**不被遗忘**（她不会丢掉它），只是拥挤的那一轮可以压缩显示
  return p.pinned === true || p.pin === 'hard' || p.pin === 'soft' || PROTECTED_TYPES.has(p.type)
}

/**
 * 最近是否被注入过（v0.29）：最近 30 天进过注入包的点，不该被判"该忘"。
 * 数据来自 20_state/inj10.json（插件每轮记的 tick → ids）。
 */
export function wasInjectedRecently(dir, id, now = new Date(), { days = 30 } = {}) {
  const raw = readJsonSafe(join(dir, '20_state', 'inj10.json'), null)
  const inj = raw && typeof raw === 'object' && raw.inj && typeof raw.inj === 'object' ? raw.inj : null
  if (!inj) return false
  const cutoff = Math.floor(now.getTime() / 86_400_000) - days
  for (const [tick, ids] of Object.entries(inj)) {
    if (Number(tick) < cutoff) continue
    if (Array.isArray(ids) && ids.includes(id)) return true
  }
  return false
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
    const superseded = Boolean(p.invalid_at) && ageDays(p.invalid_at, now) >= SUPERSEDED_MIN_AGE_DAYS
    // v0.34.0：情境到期（expires_at 到点）→ 直接让位，不用人记得回来改
    const expiredNow = Boolean(p.expires_at) && Date.parse(p.expires_at) <= now.getTime()
    const revivals = Number(p.resurrections) || 0
    const grace = revivals * RESURRECT_GRACE_DAYS
    const recent = wasInjectedRecently(dir, p.id, now)
    const permanent = revivals >= RESURRECT_PERMANENT_AFTER
    if (expiredNow && !permanent && p.status === 'active') {
      action = 'dormant'
      reason = `情境过期（expires_at ${String(p.expires_at).slice(0, 10)}）`
    } else if (superseded && !permanent && p.status === 'active') {
      // v0.29.1：结论变了就该让位——不等 R 掉到阈值（抄"遗忘补丁"的 (已取代) 规则）
      action = 'dormant'
      reason = `已取代（invalid_at 满 ${SUPERSEDED_MIN_AGE_DAYS} 天）`
    } else if (p.status === 'active' && !permanent && !recent) {
      if (p.salience <= 2 && age >= DORMANT_DAYS + grace && R < DORMANT_R) {
        action = 'dormant'
        reason = `第一轮：R<${DORMANT_R} 且 salience≤2 且 age≥${DORMANT_DAYS + grace}`
      } else if (p.salience === 3 && age >= DORMANT_DAYS_HARD + grace && R < DORMANT_R_HARD) {
        action = 'dormant'
        reason = `第一轮（慢）：R<${DORMANT_R_HARD} 且 salience=3 且 age≥${DORMANT_DAYS_HARD + grace}`
      }
    } else if (p.status === 'demoted' && !permanent && !recent) {
      if (age >= DORMANT_DAYS + grace && R < DORMANT_R) {
        action = 'dormant'
        reason = '第一轮（已降级）：R 低且够老'
      }
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
      expires_at: p.expires_at || null,
    })
    // 把初始化后的 S 写回状态，下一次不用重算
    if (!state[p.id]) state[p.id] = { S: +S.toFixed(2), r: 0, lc: 0, ll: last, st: p.status, merged_into: null }
  }

  // 第二轮（v0.30）：遗忘层里的点，R 再掉（或层内待满）就该真删。
  // 只删"从没被复活过"的——被想起过的东西不删。
  const layer = readPointFiles(dir, '31_dormant')
  let purgeCount = 0
  for (const lp of layer) {
    if (purgeCount >= PURGE_BATCH) break
    if ((Number(lp.resurrections) || 0) > 0) continue
    const lst = state[lp.id] && typeof state[lp.id] === 'object' ? state[lp.id] : {}
    const LS = Number(lst.S) > 0 ? Number(lst.S) : initialStability(lp.salience, arousalFor(lp))
    const age = ageDays(lst.ll || lp.date, now)
    const LR = retrievability(LS, age)
    const inLayerSince = (/^dormant_at:\s*(.+)$/m.exec(lp.raw) || [])[1]
    const inLayerDays = inLayerSince ? ageDays(inLayerSince, now) : 0
    if (LR < PURGE_R || inLayerDays >= PURGE_DAYS) {
      plan.push({
        id: lp.id,
        title: lp.title,
        status: 'dormant',
        salience: lp.salience,
        age: Math.round(age),
        S: +LS.toFixed(2),
        R: +LR.toFixed(3),
        rehearsal: 0,
        action: 'purge',
        reason: LR < PURGE_R ? `第二轮：R<${PURGE_R}` : `第二轮：层内满 ${PURGE_DAYS} 天`,
        last: lst.ll || lp.date,
        fragment: fragmentOf(lp),
      })
      purgeCount += 1
    }
  }

  // 容量上限（v0.29.1，抄"遗忘补丁"的 maxLines）：active 超过 MAX_ACTIVE 就按最低 R 下沉。
  // 为什么需要：我们只有"索引层 700 tok"这个隐式上限——超了是降级显示，不是淘汰；
  // 于是 500 条点也能跑，只是索引被压成一行行标题、检索越来越糊。
  let capEvicted = 0
  const activeLeft = () => plan.filter((x) => x.status === 'active' && x.action !== 'dormant')
  if (activeLeft().length > MAX_ACTIVE) {
    const victims = activeLeft()
      .filter((x) => !(state[x.id] && state[x.id].protectedByPin))
      .sort((a, b) => a.R - b.R || b.age - a.age)
    for (const v of victims) {
      if (activeLeft().length <= MAX_ACTIVE) break
      v.action = 'dormant'
      v.reason = `超上限（active>${MAX_ACTIVE}）`
      capEvicted += 1
    }
  }

  return { plan, state, skipped: { fixture: skippedFixture, protected: skippedProtected }, capEvicted }
}

/** 墓碑里留的残片：标题/摘要的前 N 个字（"断在最不该断的地方"） */
export function fragmentOf(point) {
  const text = String(point.summary || point.title || point.quote || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= FRAGMENT_MAX ? text : text.slice(0, FRAGMENT_MAX) + '…'
}

/** 落地：改 status + 写墓碑 + 重建索引 + 落 state */
export function applyForget(dir, { now = new Date(), plan, state } = {}) {
  const computed = plan && state ? { plan, state } : planForget(dir, { now })
  const p = computed.plan
  const st = computed.state
  const acts = p.filter((x) => x.action !== 'keep')
  if (!acts.length) return { changed: 0 }

  // 第二轮（purge，v0.30）：从遗忘层真删。点没了，但档案（10_archive）一个字不动——
  // 这是"敢删"的前提：她忘了，原始对话还查得到。
  const purges = acts.filter((a) => a.action === 'purge')
  if (purges.length) {
    const layerPts = readPointFiles(dir, '31_dormant')
    mkdirSync(join(dir, PURGED_DIR), { recursive: true })
    const indexPath = join(dir, PURGED_DIR, 'index.md')
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, '# 已删除的记忆（索引）\n\n> 一行一条：日期 | 标题 | 残片。点文件没了，档案还在。\n\n', 'utf8')
    }
    mkdirSync(join(dir, '50_log'), { recursive: true })
    for (const a of purges) {
      const lp = layerPts.find((x) => x.id === a.id)
      if (!lp) continue
      try {
        unlinkSync(lp.file)
      } catch {
        continue // 删不掉就不记墓碑，下次再来
      }
      appendFileSync(
        join(dir, '50_log', 'eviction.log'),
        JSON.stringify({
          point: a.id,
          action: 'purge',
          at: now.toISOString().slice(0, 10),
          R: a.R,
          S: a.S,
          age: a.age,
          salience: a.salience,
          resurrections: 0,
          fragment: a.fragment || '',
          reason: a.reason,
        }) + '\n',
        'utf8',
      )
      appendFileSync(indexPath, now.toISOString().slice(0, 10) + ' | ' + (a.title || a.id) + ' | ' + (a.fragment || '') + '\n', 'utf8')
      if (st[a.id]) st[a.id].st = 'purged'
    }
  }

  const points = readPointFiles(dir, '30_points')
  for (const a of acts) {
    if (a.action === 'purge') continue
    const point = points.find((x) => x.id === a.id)
    if (!point) continue
    let nextStatus = 'demoted'
    let patched = point.raw.replace(/^status:.*$/m, 'status: demoted')
    let dest = point.file
    if (a.action === 'dormant') {
      nextStatus = 'dormant'
      patched = point.raw.replace(/^status:.*$/m, 'status: dormant')
      if (!/^dormant_at:.*$/m.test(patched)) {
        patched = patched.replace(/\n---\n/, `\ndormant_at: ${now.toISOString()}\ndormant_reason: ${a.reason}\n---\n`)
      }
      mkdirSync(join(dir, '31_dormant'), { recursive: true })
      dest = join(dir, '31_dormant', basename(point.file))
    }
    atomicWriteText(dest, patched)
    if (dest !== point.file) {
      try {
        unlinkSync(point.file)
      } catch {
        /* 源文件已不在就算了：目标已经写好 */
      }
    }
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

/**
 * 复活（v0.29）：被重新检索到 → 从 31_dormant/ 拉回 30_points/。
 *
 *   S ×1.6（"回忆强化"）· resurrections+1 · 30 天冷却 · 复活 3 次后自动 pin: soft
 *
 * 只动点文件与 state，不动档案（原文本来就在 10_archive）。
 */
export function revivePoint(dir, id, { now = new Date(), score = null } = {}) {
  const inLayer = readPointFiles(dir, '31_dormant')
  const point = inLayer.find((x) => x.id === id)
  if (!point) return { ok: false, reason: `遗忘层里没有 ${id}` }

  const revivals = (Number(point.resurrections) || 0) + 1
  let patched = point.raw
    .replace(/^status:.*$/m, 'status: active')
    .replace(/^dormant_at:.*\n/m, '')
    .replace(/^dormant_reason:.*\n/m, '')
  if (/^resurrections:.*$/m.test(patched)) patched = patched.replace(/^resurrections:.*$/m, `resurrections: ${revivals}`)
  else patched = patched.replace(/\n---\n/, `\nresurrections: ${revivals}\n---\n`)
  if (revivals >= RESURRECT_PERMANENT_AFTER && !/^pin:.*$/m.test(patched)) {
    patched = patched.replace(/\n---\n/, '\npin: soft\n---\n')
  }

  mkdirSync(join(dir, '30_points'), { recursive: true })
  const dest = join(dir, '30_points', basename(point.file))
  const tmp = dest + '.tmp'
  writeFileSync(tmp, patched, 'utf8')
  try {
    renameSync(tmp, dest)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* 已经改名成功 */
    }
  }
  try {
    unlinkSync(point.file)
  } catch {
    /* 源文件已不在 */
  }

  // 回忆强化：S ×1.6
  const statePath = join(dir, '20_state', 'state.json')
  const state = readJsonSafe(statePath, {})
  const st = state && typeof state === 'object' && !Array.isArray(state) ? state : {}
  const cur = st[id] && typeof st[id] === 'object' ? st[id] : {}
  const S = Number(cur.S) > 0 ? Number(cur.S) : initialStability(point.salience, arousalFor(point))
  st[id] = { ...cur, S: +(S * RESURRECT_BOOST).toFixed(2), ll: now.toISOString().slice(0, 10), st: 'active' }
  atomicWriteJson(statePath, st)

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'revival.log'),
    JSON.stringify({ at: now.toISOString(), point: id, revivals, S_before: +S.toFixed(2), S_after: st[id].S, score }) + '\n',
    'utf8',
  )
  writeIndex(dir, buildIndex(readPointFiles(dir, '30_points')))
  return { ok: true, id, revivals, S: st[id].S, permanent: revivals >= RESURRECT_PERMANENT_AFTER }
}

/** 一次性迁移：把 30_points 里 status=dormant 的旧点移进 31_dormant/ */
export function migrateLegacyDormant(dir, { now = new Date() } = {}) {
  const legacy = readPointFiles(dir, '30_points').filter((p) => p.status === 'dormant')
  if (!legacy.length) return { moved: 0 }
  mkdirSync(join(dir, '31_dormant'), { recursive: true })
  let moved = 0
  for (const point of legacy) {
    let patched = point.raw
    if (!/^dormant_at:.*$/m.test(patched)) {
      patched = patched.replace(/\n---\n/, `\ndormant_at: ${now.toISOString()}\ndormant_reason: 迁移自旧状态\n---\n`)
    }
    const dest = join(dir, '31_dormant', basename(point.file))
    atomicWriteText(dest, patched)
    try {
      unlinkSync(point.file)
      moved += 1
    } catch {
      /* 源文件删不掉就留着，下次再迁 */
    }
  }
  if (moved) {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, '50_log', 'eviction.log'), JSON.stringify({ at: now.toISOString().slice(0, 10), action: 'migrated', count: moved }) + '\n', 'utf8')
    writeIndex(dir, buildIndex(readPointFiles(dir, '30_points')))
  }
  return { moved }
}
/** 在遗忘层里按关键词找（只读，不改任何文件）——对应"遗忘补丁"的 `--recall` */
export function findDormant(dir, keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const needle = kw.toLowerCase()
  return readPointFiles(dir, '31_dormant')
    .filter((p) => {
      const hay = [p.id, p.title, p.summary, p.raw].filter(Boolean).join('\n').toLowerCase()
      return hay.includes(needle)
    })
    .map((p) => ({
      id: p.id,
      title: p.title,
      date: p.date,
      dormant_at: (/^dormant_at:\s*(.+)$/m.exec(p.raw) || [])[1] || null,
      resurrections: Number(p.resurrections) || 0,
    }))
}