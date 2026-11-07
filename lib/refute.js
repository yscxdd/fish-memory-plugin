// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * refute.js — "这个结论错了"（v0.69.0，T5）。
 *
 * 为什么需要：现在只有删除（`erase`，太重）和降级（`demoted/dormant`，读者不知道为什么），
 * 没有"**这条被推翻了**"的语义。
 *
 * 决定（A 方案）：**被推翻的点仍然注入，但带标记**——
 *
 *   ```
 *   2026-11-05 [已推翻] 他喜欢独处
 *   （这条已被推翻：他其实怕一个人；见 M-2026-11-07-003）
 *   ```
 *
 * 理由：**"她错了"也是她的一部分**。藏结论不藏事实——
 * 完全不注入会让"下次她还犯同一个错"，而且抹掉的是历史。
 *
 * 三条纪律：
 *   ① **必须给理由**（无 reason 直接拒），理由进 front matter 和墓碑账本；
 *   ② 墓碑复用 `50_log/erasure.log` 的格式（action: refute），**不含原文**；
 *   ③ `--by` 指到推翻它的新点，新点自动写 `contradicts: [<旧 id>]`——
 *      这样"为什么错了"在检索时也能被摊开（renderConflictNote 已经在做）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readPointFiles } from './toolkit.js'
import { atomicWriteText, sha8 } from './util.js'

export const ERASURE_LOG = join('50_log', 'erasure.log')
export const REFUTE_STATUS = 'superseded'

/** 在 front matter 里加/改一行（不改正文，不重排其他字段） */
function setFrontMatter(raw, fields) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error('这条点没有 front matter，不敢改')
  const [, head, body] = m
  const lines = head.split(/\r?\n/)
  for (const [k, v] of Object.entries(fields)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}:`))
    const line = `${k}: ${v}`
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}

/**
 * 推翻一条点。
 *
 * @param {string} dir 库
 * @param {string} id 点 id
 * @param {{reason:string, by?:string, now?:Date}} opts
 */
export function refutePoint(dir, id, { reason, by = null, now = new Date() } = {}) {
  const why = String(reason || '').trim()
  if (!why) return { ok: false, reason: '必须给理由（--reason "..."）：没有理由的"错了"和删除没区别' }

  const target = readPointFiles(dir, '30_points').find((p) => p.id === id)
  if (!target) return { ok: false, reason: `没有这一条：${id}` }
  if (target.status === REFUTE_STATUS) return { ok: false, reason: `这条已经被推翻过了：${id}` }
  if (by && by === id) return { ok: false, reason: '不能用自己推翻自己' }

  const abs = target.file ? (target.file.includes(dir) ? target.file : join(dir, '30_points', target.file)) : null
  if (!abs || !existsSync(abs)) return { ok: false, reason: `找不到这条点的文件：${id}` }

  const raw = readFileSync(abs, 'utf8')
  const before = sha8(raw)
  const next = setFrontMatter(raw, {
    status: REFUTE_STATUS,
    refuted_at: now.toISOString(),
    refuted_reason: JSON.stringify(why),
    refuted_by: by || 'null',
  })
  atomicWriteText(abs, next)

  // 墓碑账本：id + 时间 + 原因 + 前后指纹，**不含原文**
  const log = join(dir, ERASURE_LOG)
  const row = {
    at: now.toISOString(),
    action: 'refute',
    id,
    reason: why,
    by: by || null,
    before,
    after: sha8(next),
  }
  try {
    const prev = existsSync(log) ? readFileSync(log, 'utf8') : ''
    atomicWriteText(log, `${prev}${JSON.stringify(row)}\n`)
  } catch {
    /* 账本写不上不影响推翻本身，但要知道 */
  }

  // --by：让新点自己声明"我推翻了谁"（这样 renderConflictNote 能摊开）
  let linked = false
  if (by) {
    try {
      const newer = readPointFiles(dir, '30_points').find((p) => p.id === by)
      if (newer?.file) {
        // point.file 是**绝对路径**（readPointFiles 给的就是绝对），别拿 join 拼
        const p2 = String(newer.file).includes(dir) ? String(newer.file) : join(dir, '30_points', newer.file)
        if (existsSync(p2)) {
          const rawNew = readFileSync(p2, 'utf8')
          const list = Array.isArray(newer.contradicts) ? [...newer.contradicts] : []
          if (!list.includes(id)) list.push(id)
          atomicWriteText(p2, setFrontMatter(rawNew, { contradicts: `[${list.map((x) => `"${x}"`).join(', ')}]` }))
          linked = true
        }
      }
    } catch {
      /* 连不上不影响推翻 */
    }
  }

  return { ok: true, id, by: by || null, linked, reason: why }
}

/** 被推翻但没写理由的（check/audit 用） */
export function refutedWithoutReason(dir) {
  return readPointFiles(dir, '30_points').filter((p) => p.status === REFUTE_STATUS && !String(p.refuted_reason || '').trim())
}
