// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * logfile.js — 运维日志的统一写入口（v0.78.1，审计 P2-7 的收尾）。
 *
 * 为什么要收口：v0.74 只给 `ability.log` 挂了轮转，v0.78 又补了 `retrieval.log`——
 * 但 `archive-race.log` / `erasure.log` / `pressure.log` 还是"只增不减"。
 * 而这些恰好是**出事时最会涨**的几个：race 日志一次撞车就上千行。
 *
 * 这个模块只做两件事：追加一行、顺手看一眼要不要轮转。
 * 轮转失败绝不影响主流程（日志写不上比崩了强）。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认上限 2MB、留 2 份：运维日志不是记忆，不需要留那么久 */
export const DEFAULT_LOG_LIMIT = { maxBytes: 2_000_000, keep: 2 }

/**
 * 追加一行日志（对象会被 JSON.stringify），并按需轮转。
 *
 * @param {string} dir 库根
 * @param {string} rel 相对路径，如 '50_log/erasure.log'
 * @param {object|string} row
 * @param {{maxBytes?:number, keep?:number}} [opts]
 * @returns {boolean} 是否写成功
 */
export function appendLog(dir, rel, row, opts = {}) {
  const file = join(dir, rel)
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${typeof row === 'string' ? row : JSON.stringify(row)}\n`, 'utf8')
  } catch {
    return false
  }
  rotate(file, opts)
  return true
}

/** 轮转（内部用；也可单独调） */
export function rotate(file, { maxBytes = DEFAULT_LOG_LIMIT.maxBytes, keep = DEFAULT_LOG_LIMIT.keep } = {}) {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < maxBytes) return false
    // 保留 `.1 … .keep`：超出的先删，再从旧到新挪一位，最后把原文件变成 .1
    // （第一版从 keep 往下挪，结果 .3 永远删不掉——测试抓到了。）
    for (let i = keep; i >= 1; i--) {
      const from = `${file}.${i}`
      if (!existsSync(from)) continue
      if (i === keep) {
        try {
          rmSync(from, { force: true })
        } catch {
          /* 删不掉就留着 */
        }
      } else {
        renameSync(from, `${file}.${i + 1}`)
      }
    }
    // 比 keep 更老的一律清掉（历史遗留的 .5 .6 之类）
    for (let i = keep + 1; existsSync(`${file}.${i}`); i++) {
      try {
        rmSync(`${file}.${i}`, { force: true })
      } catch {
        break
      }
    }
    renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
  }
}

/** 这些是一旦出事就会暴涨的日志：给它们都挂上轮转 */
export const HOT_LOGS = [
  '50_log/archive-race.log',
  '50_log/erasure.log',
  '50_log/pressure.log',
  '50_log/tamper.log',
  '50_log/invalidation.log',
  '50_log/archive-fail.log',
  '50_log/lock.log',
]

/** 一条命令把库里所有热日志看过一遍（给 CLI 用） */
export function rotateAll(dir, opts = {}) {
  const rotated = []
  for (const rel of HOT_LOGS) {
    if (rotate(join(dir, rel), opts)) rotated.push(rel)
  }
  return rotated
}
