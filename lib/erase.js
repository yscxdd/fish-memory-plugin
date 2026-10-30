// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * erase.js — 真删除（G1，v0.11.0）。
 *
 * 这是全库**唯一**允许改写档案的地方，所以它有自己的一套规矩：
 *
 *   ① 只按**整条消息**删，不做片段替换（删一行，不改半行 → 链还能重算干净）。
 *   ② 删完**重算该文件的 prev/hash 链**，并把新指纹写回 `20_state/archive-manifest.json`；
 *      否则下次启动完整性检查会把这次授权删除当成"被篡改"报出来。
 *   ③ 每次删除都在 `50_log/erasure.log` 留一条墓碑：**id + 时间 + 原因 + 原 hash 前 8 位**，
 *      **不含任何原文片段**——墓碑能对账，但恢复不出内容。
 *   ④ 备份（`fish-memory-backups/`）里同名文件同步删掉那一行，并重算 MANIFEST 里该文件的 sha256；
 *      否则"删了"只删了活库，明文副本还能活 7 天。
 *   ⑤ 被删除消息被记忆点引用时：**默认拒绝**，要 `--cascade` 才连点一起删；
 *      绝不静默删掉别的记忆。
 *
 * 破坏的不变量（要写进契约）：§6 ①"档案只追加、永不改删" → 改成"只追加，**授权删除除外**"。
 * 每条删除都在 erasure.log 里留下前后指纹，所以"改过"是可核算的，不是黑箱。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { hashOf } from './archive.js'
import { writeManifest } from './integrity.js'

export const ERASURE_LOG = join('50_log', 'erasure.log')

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, i) => {
      try {
        return { line, rec: JSON.parse(line), n: i }
      } catch {
        return { line, rec: null, n: i }
      }
    })
}

function listJsonl(dir) {
  const base = join(dir, '10_archive', 'messages')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => join(base, f))
}

/** 读档案，按 id（记录 id 或平台 msgid）索引 */
export function indexMessages(dir) {
  const byId = new Map()
  for (const file of listJsonl(dir)) {
    for (const item of readJsonl(file)) {
      if (!item.rec) continue
      const ref = { file, id: item.rec.id, plat: item.rec.msgid_plat, rec: item.rec }
      if (item.rec.id) byId.set(item.rec.id, ref)
      if (item.rec.msgid_plat) byId.set(item.rec.msgid_plat, ref)
    }
  }
  return byId
}

/** 哪些记忆点在引用这些消息（source / links / merged_into / contradicts） */
export function findRefs(dir, messageIds) {
  const ids = new Set(messageIds)
  const out = []
  for (const sub of ['30_points', '40_pending']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
      const raw = readFileSync(join(d, f), 'utf8')
      const pointId = (raw.match(/^id:\s*(.+)$/m) || [])[1]?.trim() || f
      const hits = [...ids].filter((id) => raw.includes(id))
      if (hits.length) out.push({ id: pointId, file: join(d, f), via: hits })
    }
  }
  return out
}

/**
 * 列出这次要删的东西（**不落盘**）。
 *
 * @param {string} dir
 * @param {{messageIds?:string[], pointIds?:string[]}} target
 * @returns {{
 *   messages:{id:string, file:string, hash8:string, role:string, ts:string}[],
 *   points:{id:string, file:string}[],
 *   refs:{id:string, file:string, via:string[]}[],
 *   unknown:string[],
 *   backups:string[]
 * }}
 */
export function planErase(dir, { messageIds = [], pointIds = [] } = {}) {
  const index = indexMessages(dir)
  const messages = []
  const unknown = []
  for (const id of messageIds) {
    const hit = index.get(id)
    if (!hit) {
      unknown.push(id)
      continue
    }
    messages.push({
      id: hit.rec.id,
      plat: hit.rec.msgid_plat,
      file: hit.file,
      // 墓碑里记的是**原记录 hash 的前 8 位**（v0.15.1 修：以前又 sha256 了一次，
      // 对账时跟档案里的 hash 对不上）
      hash8: String(hit.rec.hash || '').slice(0, 8) || null,
      role: hit.rec.role || '?',
      ts: hit.rec.ts || '',
    })
  }

  // 点：按 id 找文件（--point 用）
  const points = []
  for (const id of pointIds) {
    let found = null
    for (const sub of ['30_points', '40_pending']) {
      const d = join(dir, sub)
      if (!existsSync(d)) continue
      for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
        const raw = readFileSync(join(d, f), 'utf8')
        const pid = (raw.match(/^id:\s*(.+)$/m) || [])[1]?.trim()
        if (pid === id) {
          found = { id, file: join(d, f) }
          break
        }
      }
      if (found) break
    }
    if (found) points.push(found)
    else unknown.push(id)
  }

  const refs = findRefs(
    dir,
    messages.flatMap((m) => [m.id, m.plat].filter(Boolean)),
  ).filter((r) => !points.some((p) => p.id === r.id))

  // 备份里可能也有这些行：先列出来，好让人知道"这一下会改几处"
  const backups = []
  const backupRoot = join(dirname(dir), 'fish-memory-backups')
  if (existsSync(backupRoot)) {
    for (const day of readdirSync(backupRoot)) {
      if (!/^fish-memory-\d{4}-\d{2}-\d{2}$/.test(day)) continue
      for (const m of messages) {
        const f = join(backupRoot, day, '10_archive', 'messages', basename(m.file))
        if (!existsSync(f)) continue
        if (readJsonl(f).some((x) => x.rec && (x.rec.id === m.id || x.rec.msgid_plat === m.plat))) {
          backups.push(f)
        }
      }
    }
  }

  return { messages, points, refs, unknown, backups }
}

/** 重算一个文件里所有记录的 prev/hash（受控改写的核心） */
function rechain(records) {
  let prev = 'genesis'
  for (const rec of records) {
    rec.prev = prev
    rec.hash = hashOf(rec)
    prev = rec.hash
  }
  return records
}

/**
 * 执行删除。**先备份改写，再动活库**——顺序反了的话，备份写失败会让活库和备份不一致。
 *
 * @param {string} dir
 * @param {ReturnType<typeof planErase>} plan
 * @param {{reason?:string, now?:string}} [opts]
 */
export function applyErase(dir, plan, { reason = '', now = new Date().toISOString() } = {}) {
  if (plan.unknown?.length) throw new Error(`找不到这些 id：${plan.unknown.join(', ')}`)
  const tomb = []
  const warnings = []

  // ① 备份同步改写（同一行删掉 + 重算 MANIFEST 里该文件的 sha256）
  for (const backupFile of plan.backups || []) {
    try {
      const rows = readJsonl(backupFile).filter((x) => x.rec)
      const dropIds = new Set(plan.messages.flatMap((m) => [m.id, m.plat].filter(Boolean)))
      const kept = rows.map((x) => x.rec).filter((r) => !(dropIds.has(r.id) || dropIds.has(r.msgid_plat)))
      if (kept.length === rows.length) continue
      writeFileSync(backupFile, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
      // MANIFEST 里该文件的 sha256 要跟着变，否则 unpack 会报"哈希不符"
      const manifestPath = join(backupFile, '..', '..', '..', 'MANIFEST.json')
      const rel = relative(join(backupFile, '..', '..', '..'), backupFile).split(sep).join('/')
      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
          const entry = (m.files || []).find((f) => f.path === rel)
          if (entry) {
            entry.sha256 = createHash('sha256').update(readFileSync(backupFile)).digest('hex')
            entry.size = readFileSync(backupFile).length
            writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8')
          }
        } catch (e) {
          warnings.push(`备份清单没更新：${manifestPath}（${e?.message || e}）`)
        }
      }
    } catch (e) {
      warnings.push(`备份改写失败：${backupFile}（${e?.message || e}）`)
    }
  }

  // ② 活库：按文件分组，删行 + 重算链
  const byFile = new Map()
  for (const m of plan.messages) {
    const dropIds = new Set([m.id, m.plat].filter(Boolean))
    if (!byFile.has(m.file)) byFile.set(m.file, dropIds)
    else for (const id of dropIds) byFile.get(m.file).add(id)
  }
  for (const [file, dropIds] of byFile) {
    const before = readJsonl(file).filter((x) => x.rec).map((x) => x.rec)
    const kept = before.filter((r) => !(dropIds.has(r.id) || dropIds.has(r.msgid_plat)))
    const removed = before.length - kept.length
    rechain(kept)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
    tomb.push({
      at: now,
      kind: 'archive',
      file: basename(file),
      removed,
      before: { count: before.length, tail: before.at(-1)?.hash?.slice(0, 8) || null },
      after: { count: kept.length, tail: kept.at(-1)?.hash?.slice(0, 8) || null },
      reason,
    })
  }

  // ③ 记忆点：cascade 或 --point 指定的文件
  for (const p of plan.points) {
    try {
      unlinkSync(p.file)
      tomb.push({ at: now, kind: 'point', id: p.id, file: basename(dirname(p.file)) + '/' + basename(p.file), reason })
    } catch (e) {
      warnings.push(`点删不掉：${p.id}（${e?.message || e}）`)
    }
  }

  // ④ 每条消息一条墓碑：**不含原文**，只有 id / 时间 / 原因 / 原 hash 前 8 位
  for (const m of plan.messages) {
    tomb.push({ at: now, kind: 'message', id: m.id, plat: m.plat, ts: m.ts, hash8: m.hash8, reason })
  }

  // ⑤ 指纹清单重写（否则下次启动会把这次授权删除当成篡改）
  try {
    const files = {}
    for (const file of listJsonl(dir)) {
      const rows = readJsonl(file).filter((x) => x.rec).map((x) => x.rec)
      files[basename(file)] = {
        count: rows.length,
        firstHash: rows[0]?.hash || null,
        lastHash: rows.at(-1)?.hash || null,
        bytes: readFileSync(file).length,
      }
    }
    writeManifest(dir, files, now)
  } catch (e) {
    warnings.push(`完整性清单没更新：${e?.message || e}`)
  }

  // ⑥ 落墓碑
  try {
    const log = join(dir, ERASURE_LOG)
    mkdirSync(dirname(log), { recursive: true })
    const lines = tomb.map((t) => JSON.stringify(t)).join('\n') + '\n'
    writeFileSync(log, existsSync(log) ? readFileSync(log, 'utf8') + lines : lines, 'utf8')
  } catch (e) {
    warnings.push(`墓碑写不进去：${e?.message || e}`)
  }

  return { removed: plan.messages.length, points: plan.points.length, backups: plan.backups.length, tomb, warnings }
}

/**
 * 读墓碑（最近的在前）。
 *
 * 三种都留：`message` / `point` 是删了什么，`archive` 是**哪份文件被改写过**、
 * 改前改后各多少行。以前这里把 archive 滤掉了，于是"某天档案被删过几行"
 * 在 `memory erased` 里根本看不见（v0.15.1 修）。
 */
export function readErasureLog(dir, limit = 50) {
  const log = join(dir, ERASURE_LOG)
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { at: null, kind: 'unparsable', raw: l.slice(0, 120) }
      }
    })
    .filter((e) => e.kind === 'message' || e.kind === 'point' || e.kind === 'archive')
    .slice(-limit)
    .reverse()
}
