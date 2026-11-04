// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * merge-check（v0.51.0）——**只读**地告诉你两个库差在哪。
 *
 * 为什么不做双向同步（写在这儿，免得以后有人"顺手"加上）：
 *   · 档案是 append-only + prev/hash 链，按天分文件。两台机器各写一天，
 *     同一个头会分叉出两条链——合起来 `verify` 直接报坏链；
 *   · 点文件是"同名即同一件事"，两边各改一次就是静默覆盖，没有冲突记录；
 *   · 我们连跨进程写锁都没有（research 文档 P1-2），两台同时写必坏。
 *
 * 所以这条命令只做三件事：**数差异、指冲突、说哪边新**。一个字节都不写。
 *
 * 输出分四段：档案 / 记忆点 / 核心层 / 状态。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readArchive, readPointFiles } from './toolkit.js'
import { sha8 } from './util.js'
import { scanCore } from './tamper.js'

function archiveFiles(dir) {
  const base = join(dir, '10_archive', 'messages')
  if (!existsSync(base)) return []
  return readdirSync(base).filter((f) => f.endsWith('.jsonl')).sort()
}

/** 消息级差异：id 集合 + 内容是否一致 */
function compareArchive(a, b) {
  const A = readArchive(a).messages
  const B = readArchive(b).messages
  const mapA = new Map(A.map((m) => [m.id, m]))
  const mapB = new Map(B.map((m) => [m.id, m]))

  const onlyA = []
  const onlyB = []
  const differ = []
  for (const [id, m] of mapA) {
    const other = mapB.get(id)
    if (!other) onlyA.push(id)
    else if (sha8(String(m.text || '')) !== sha8(String(other.text || ''))) differ.push(id)
  }
  for (const id of mapB.keys()) if (!mapA.has(id)) onlyB.push(id)

  // 天文件级：同名文件哈希不同 = 两条链在这个文件上分叉了
  const filesA = archiveFiles(a)
  const filesB = archiveFiles(b)
  const forks = []
  for (const f of filesA) {
    if (!filesB.includes(f)) continue
    const ha = sha8(String(readFileSyncSafe(join(a, '10_archive', 'messages', f))))
    const hb = sha8(String(readFileSyncSafe(join(b, '10_archive', 'messages', f))))
    if (ha !== hb) forks.push(f)
  }

  const lastA = A.length ? A[A.length - 1].ts : null
  const lastB = B.length ? B[B.length - 1].ts : null

  return {
    a: { messages: A.length, lastTs: lastA },
    b: { messages: B.length, lastTs: lastB },
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    differ: differ.length,
    filesOnlyA: filesA.filter((f) => !filesB.includes(f)),
    filesOnlyB: filesB.filter((f) => !filesA.includes(f)),
    forks,
    sampleOnlyA: onlyA.slice(0, 3),
    sampleOnlyB: onlyB.slice(0, 3),
  }
}

// 小工具：读不出来就当空串（只读诊断，不为一个坏文件中断）
function readFileSyncSafe(p) {
  try {
    return readFileSync(p)
  } catch {
    return ''
  }
}

/** 记忆点差异：id 集合 + 同 id 内容是否一致 */
function comparePoints(a, b) {
  const A = readPointFiles(a, '30_points')
  const B = readPointFiles(b, '30_points')
  const key = (p) => [p.title || '', p.summary || '', p.date || '', p.status || ''].join('\u0000')
  const mapA = new Map(A.map((p) => [p.id, p]))
  const mapB = new Map(B.map((p) => [p.id, p]))

  const onlyA = []
  const onlyB = []
  const differ = []
  for (const [id, p] of mapA) {
    const other = mapB.get(id)
    if (!other) onlyA.push(id)
    else if (key(p) !== key(other)) differ.push(id)
  }
  for (const id of mapB.keys()) if (!mapA.has(id)) onlyB.push(id)

  return {
    a: A.length,
    b: B.length,
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    differ: differ.length,
    sampleOnlyA: onlyA.slice(0, 3),
    sampleOnlyB: onlyB.slice(0, 3),
    sampleDiffer: differ.slice(0, 3),
  }
}

/** 核心层：同名的受保护文件哈希不同 = 两边各自改过 */
function compareCore(a, b) {
  const ca = scanCore(a)
  const cb = scanCore(b)
  const names = new Set([...Object.keys(ca), ...Object.keys(cb)])
  const differ = []
  const onlyA = []
  const onlyB = []
  for (const n of names) {
    if (ca[n] && !cb[n]) onlyA.push(n)
    else if (!ca[n] && cb[n]) onlyB.push(n)
    else if (ca[n].sha !== cb[n].sha) differ.push(n)
  }
  return { differ, onlyA, onlyB }
}

/** 状态文件的新旧（只报 mtime，不算内容差） */
function compareState(a, b) {
  const names = ['emotion.json', 'questions.json', 'habits.json', 'presence.json', 'file-index.json']
  const rows = []
  for (const n of names) {
    rows.push({ file: n, a: mtimeOf(join(a, '20_state', n)), b: mtimeOf(join(b, '20_state', n)) })
  }
  return rows
}

function mtimeOf(p) {
  try {
    return statSync(p).mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * @param {string} a 本机库
 * @param {string} b 另一台（或备份包解出来的）库
 * @param {{now?:Date}} [opts]
 */
export function mergeCheck(a, b, { now = new Date() } = {}) {
  for (const [label, p] of [['A', a], ['B', b]]) {
    if (!existsSync(p)) throw new Error(`${label} 路径不存在：${p}`)
  }
  const archive = compareArchive(a, b)
  const points = comparePoints(a, b)
  const core = compareCore(a, b)
  const state = compareState(a, b)

  // 结论：哪边新、有没有结构性冲突
  const newer = (() => {
    const ta = Date.parse(archive.a.lastTs || '')
    const tb = Date.parse(archive.b.lastTs || '')
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null
    if (!Number.isFinite(ta)) return 'B'
    if (!Number.isFinite(tb)) return 'A'
    if (ta === tb) return 'same'
    return ta > tb ? 'A' : 'B'
  })()

  const dangers = []
  if (archive.forks.length) {
    dangers.push(
      `有 ${archive.forks.length} 个天文件两边都改过（${archive.forks.join('、')}）——档案链已经分叉，直接合并会让 verify 报坏链`,
    )
  }
  if (points.differ) dangers.push(`有 ${points.differ} 个记忆点两边都改过（同名不同内容）——合并会静默覆盖一边`)
  if (core.differ.length) dangers.push(`核心层两边都改过：${core.differ.join('、')}——soul/user/voice 不能自动挑一个`)

  return {
    at: now.toISOString(),
    a,
    b,
    archive,
    points,
    core,
    state,
    newer,
    dangers,
    safe: dangers.length === 0,
    advice:
      dangers.length === 0
        ? '没有结构性冲突。真要合并，也请人工确认"以哪边为准"再做，本插件不做自动合并。'
        : '有结构性冲突，别合并。正确做法：选一台当主库，另一台的差异人工摘录（点可以逐条抄，档案不要手工拼接）。',
  }
}
