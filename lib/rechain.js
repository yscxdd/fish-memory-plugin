// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * rechain.js — 修断掉的档案链（v0.78.0，审计 P1-3）。
 *
 * ## 为什么要有
 *
 * 两个窗口同时写档案时，链可能断（`prev 对不上`）。断了之后：
 *   · `memory verify` 永远红，红久了就没人看；
 *   · 备份会把断链原样存下来，恢复后还是断的；
 *   · 而 `erase.js` 里的 `rechain()` 只在"真删除"内部用，**对外的修复命令一直不存在**。
 *
 * ## 它做什么、不做什么
 *
 * **做**：按文件里现有的**顺序**，重算每一行的 `prev` / `hash`，保留 id / seq / ts / text 原样。
 *
 * **不做**：不排序、不合并、不删行。**顺序就是现场**——一个修复工具如果顺手"整理"一下，
 * 你手里的档案和你以为的档案就不再是同一份了。
 *
 * 每次改动写 `50_log/rechain.log`（文件 / 行数 / 前后指纹 / 谁在什么时候跑的）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { hashOf, withDayLock } from './archive.js'
import { atomicWriteText, sha8 } from './util.js'

const MSG_DIR = join('10_archive', 'messages')

/**
 * 重算一个文件的链。
 *
 * @param {string} file 绝对路径
 * @param {{dry?:boolean, now?:Date, dir?:string, log?:Function}} [opts]
 * @returns {{file:string, lines:number, before:string, after:string, changed:boolean}}
 */
export function rechainFile(file, { dry = false, now = new Date(), dir = null } = {}) {
  // R1（审计 v0781，P0）：整文件"读 → 重算 → rename 覆盖"这三步以前**不持锁**。
  // 后果不是"链没修好"，是**吃掉正在写的消息**：读进来的快照会覆盖掉中间落进来的行，
  // 而那些行的游标已经前移，不会重放 → 永久丢失。
  // 现在：跟写入方用同一把按天锁，锁内重读；写前再复核一次大小，变过就放弃。
  const locked = dir
    ? withDayLock(dir, file, () => rechainFileLocked(file, { dry, now }), { waitMs: 5000 })
    : rechainFileLocked(file, { dry, now })
  return locked
}

/** 锁内版本：重读 → 重算 → 复核 → 写 */
function rechainFileLocked(file, { dry = false, now = new Date() } = {}) {
  const raw = readFileSync(file, 'utf8')
  const before = sha8(raw)
  const rows = raw.split(/\r?\n/).filter((l) => l.trim())
  let prev = 'genesis'
  const out = []
  let changed = false
  for (const line of rows) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      // 坏行原样留着（它是证据，不是垃圾）
      out.push(line)
      continue
    }
    const oldPrev = rec.prev
    const oldHash = rec.hash
    rec.prev = prev
    rec.hash = hashOf(rec)
    if (rec.prev !== oldPrev || rec.hash !== oldHash) changed = true
    prev = rec.hash
    out.push(JSON.stringify(rec))
  }
  const text = `${out.join('\n')}\n`
  const after = sha8(text)
  if (!dry && changed) {
    // 写前复核：从读到写之间如果文件长大了，说明**有人正在写**。
    // 这时候覆盖就是吃消息——宁愿不修，报一句"稍后再跑"。
    const nowSize = statSync(file).size
    if (nowSize !== Buffer.byteLength(raw, 'utf8')) {
      return { file, lines: rows.length, before, after: before, changed: false, skipped: '有人正在写这个文件（大小变了），这次不修' }
    }
    atomicWriteText(file, text)
  }
  return { file, lines: rows.length, before, after, changed }
}

/**
 * 重算某一天（或全部）的档案链。
 *
 * @param {string} dir 库
 * @param {{day?:string|null, dry?:boolean, now?:Date}} [opts]
 */
export function rechain(dir, { day = null, dry = false, now = new Date() } = {}) {
  const msgDir = join(dir, MSG_DIR)
  if (!existsSync(msgDir)) return { files: [], total: 0, changed: 0 }
  const names = readdirSync(msgDir)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => (day ? f.startsWith(`${day}`) : true))
    .sort()
  const results = names.map((name) => rechainFile(join(msgDir, name), { dry, now, dir }))
  const changed = results.filter((r) => r.changed).length
  if (!dry && changed) {
    try {
      const log = join(dir, '50_log', 'rechain.log')
      const row = {
        at: now.toISOString(),
        day: day || '*',
        files: results.map((r) => ({ file: r.file.split(/[\\/]/).pop(), lines: r.lines, before: r.before, after: r.after, changed: r.changed })),
        changed,
      }
      const prevText = existsSync(log) ? readFileSync(log, 'utf8') : ''
      atomicWriteText(log, `${prevText}${JSON.stringify(row)}\n`)
    } catch {
      /* 日志写不上不影响修复本身 */
    }
  }
  return { files: results, total: results.length, changed }
}
