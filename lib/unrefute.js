// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * unrefute.js — 推翻错了要能退（v0.77.0，M4）。
 *
 * 「没有撤销权的决定权，第一次错就是永久的。」
 * 我们没有把决定权交给代码（人决，立场不变），但**人自己的撤销工具也是缺的**——
 * `refute` 从 v0.69 就有，`unrefute` 一直不存在。
 *
 * 三条纪律（和 refute 对称）：
 *   ① 必须给理由；理由进墓碑账本（`action: 'unrefute'`）；
 *   ② 状态复原成 `active`，**摘掉 refuted_* 三个字段**——留着会让 `memory fields`
 *      和渲染都以为它还被推翻着；
 *   ③ 如果当初 `--by` 指过新点，把新点上的 `contradicts` 也摘掉（那是我写进去的，
 *      撤销时要一起撤回，否则新点会永远宣称"我推翻了它"）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteText, sha8 } from './util.js'
import { readPointFiles } from './toolkit.js'

export const ERASURE_LOG = join('50_log', 'erasure.log')
export const REFUTE_STATUS = 'superseded'

/** 在 front matter 里改一行 / 删一行 */
function patchFrontMatter(raw, { set = {}, remove = [] } = {}) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error('这条点没有 front matter，不敢改')
  let lines = m[1].split(/\r?\n/)
  for (const key of remove) lines = lines.filter((l) => !new RegExp(`^${key}:`).test(l))
  for (const [key, value] of Object.entries(set)) {
    const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
    const line = `${key}: ${value}`
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
  }
  return `---\n${lines.join('\n')}\n---\n${m[2]}`
}

/**
 * 撤销一次推翻。
 *
 * @param {string} dir
 * @param {string} id
 * @param {{reason:string, now?:Date}} opts
 */
export function unrefutePoint(dir, id, { reason, now = new Date() } = {}) {
  const why = String(reason || '').trim()
  if (!why) return { ok: false, reason: '必须给理由（--reason "..."）：撤销也是决定，也要留痕' }

  const target = readPointFiles(dir, '30_points').find((p) => p.id === id)
  if (!target) return { ok: false, reason: `没有这一条：${id}` }
  if (target.status !== REFUTE_STATUS) {
    return { ok: false, reason: `这条不是被推翻的状态（status: ${target.status}），没什么可撤销的` }
  }

  const abs = String(target.file || '').includes(dir) ? String(target.file) : join(dir, '30_points', String(target.file))
  if (!existsSync(abs)) return { ok: false, reason: `找不到这条点的文件：${id}` }

  const raw = readFileSync(abs, 'utf8')
  const before = sha8(raw)
  const next = patchFrontMatter(raw, {
    set: { status: 'active' },
    remove: ['refuted_at', 'refuted_reason', 'refuted_by'],
  })
  atomicWriteText(abs, next)

  // 账本：撤销也是一条记录（只追加）
  const row = {
    at: now.toISOString(),
    action: 'unrefute',
    id,
    reason: why,
    was_refuted_by: target.refuted_by || null,
    before,
    after: sha8(next),
  }
  try {
    const { appendFileSync, mkdirSync } = await_fs()
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, ERASURE_LOG), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    /* 账本写不上不影响撤销本身 */
  }

  // 反向链接：把新点上的 contradicts 摘掉
  let unlinked = false
  if (target.refuted_by) {
    try {
      const newer = readPointFiles(dir, '30_points').find((p) => p.id === target.refuted_by)
      if (newer?.file) {
        const nAbs = String(newer.file).includes(dir) ? String(newer.file) : join(dir, '30_points', String(newer.file))
        const nRaw = readFileSync(nAbs, 'utf8')
        const list = (Array.isArray(newer.contradicts) ? newer.contradicts : []).filter((x) => x !== id)
        atomicWriteText(nAbs, patchFrontMatter(nRaw, { set: { contradicts: `[${list.map((x) => `"${x}"`).join(', ')}]` } }))
        unlinked = true
      }
    } catch {
      /* 摘不掉就留着，至少点本身已经恢复 */
    }
  }

  return { ok: true, id, reason: why, unlinked, wasRefutedBy: target.refuted_by || null }
}

// 静态 import 一份 fs（ESM 里不走动态 require）
import { appendFileSync, mkdirSync } from 'node:fs'
function await_fs() {
  return { appendFileSync, mkdirSync }
}
