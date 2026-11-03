// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 篡改告警（v0.41.0，① 组）——借自 digital-life-core 的 `l0-file-guard` 的思路。
 *
 * **我们和它的处境不同**：它有 pre-tool hook，能当场拦下写核心文件的命令；
 * 我们（DSH 插件）只拿到 `tools.register`，**拦不住**她跑 shell 直接改文件。
 *
 * 所以只能做诚实的另一半：**发现**。
 *   · 每轮（≥1 秒一次）对 `00_core/*.md` 做轻量指纹（size + mtime + sha8）
 *   · 变了就写 `50_log/tamper.log`，并在 `audit` 里报出来
 *   · 我们自己的合法写入（soul apply / voice accept）之后调 `refreshFingerprint()` 刷新基线
 *
 * 不阻断、不改任何内容——先把"有人绕过我改了"变成一件**看得见**的事。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe, sha8 } from './util.js'

export const TAMPER_STATE = join('20_state', 'core_fingerprint.json')
export const TAMPER_LOG = join('50_log', 'tamper.log')
export const TRACKED_CORE = ['soul.md', 'user.md', 'relation.md', 'rules.md', 'voice.md', 'voice_origin.md']
export const MIN_CHECK_MS = 1000

/** 扫一遍核心层：每个文件取 size + mtime + sha8 */
export function scanCore(dir) {
  const out = {}
  for (const name of TRACKED_CORE) {
    const p = join(dir, '00_core', name)
    if (!existsSync(p)) continue
    try {
      const st = statSync(p)
      const text = readFileSync(p, 'utf8')
      out[name] = { size: st.size, mtime: Math.round(st.mtimeMs), sha: sha8(text) }
    } catch {
      /* 读不到就跳过（下一轮再看） */
    }
  }
  return out
}

export function loadFingerprint(dir) {
  const raw = readJsonSafe(join(dir, TAMPER_STATE), null)
  if (!raw || typeof raw.files !== 'object' || !raw.files) return null
  return raw
}

function saveFingerprint(dir, files) {
  atomicWriteJson(join(dir, TAMPER_STATE), { version: 1, at: new Date().toISOString(), files })
}

/** 强制刷新基线（我们自己的合法写入之后调） */
export function refreshFingerprint(dir) {
  saveFingerprint(dir, scanCore(dir))
  return { refreshed: true }
}

/**
 * 检查：和上次基线比，哪些核心文件变了。
 * @returns {{changed:string[], added:string[], removed:string[], checkedAt:string}}
 */
export function checkTamper(dir, { now = new Date(), write = true } = {}) {
  const prev = loadFingerprint(dir)
  const cur = scanCore(dir)
  const changed = []
  const added = []
  const removed = []

  if (prev?.files) {
    for (const [name, f] of Object.entries(cur)) {
      const old = prev.files[name]
      if (!old) {
        added.push(name)
        continue
      }
      if (old.sha !== f.sha) changed.push(name)
    }
    for (const name of Object.keys(prev.files)) if (!cur[name]) removed.push(name)
  }

  if (write) saveFingerprint(dir, cur)

  const dirty = changed.length + added.length + removed.length
  if (dirty) {
    try {
      mkdirSync(join(dir, '50_log'), { recursive: true })
      appendFileSync(
        join(dir, TAMPER_LOG),
        JSON.stringify({ at: now.toISOString(), changed, added, removed }) + '\n',
        'utf8',
      )
    } catch {
      /* 日志失败不影响对话 */
    }
  }
  return { changed, added, removed, checkedAt: now.toISOString() }
}

/** 上次告警距今多少小时（没有就是 null） */
export function lastTamperAt(dir) {
  if (!existsSync(join(dir, TAMPER_LOG))) return null
  try {
    const lines = readFileSync(join(dir, TAMPER_LOG), 'utf8').trim().split('\n').filter(Boolean)
    if (!lines.length) return null
    const row = JSON.parse(lines[lines.length - 1])
    return typeof row.at === 'string' ? row.at : null
  } catch {
    return null
  }
}

/** 读最近 N 条告警（给 audit / CLI） */
export function recentTamper(dir, n = 5) {
  if (!existsSync(join(dir, TAMPER_LOG))) return []
  try {
    return readFileSync(join(dir, TAMPER_LOG), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** 目录里有没有核心文件（防止在空库上瞎告警） */
export function coreExists(dir) {
  const p = join(dir, '00_core')
  if (!existsSync(p)) return false
  try {
    return readdirSync(p).some((f) => TRACKED_CORE.includes(f))
  } catch {
    return false
  }
}
