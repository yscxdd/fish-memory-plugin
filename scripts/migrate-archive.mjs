// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * migrate-archive.mjs — 把一个记忆目录的档案并进另一个（一次性修复用）。
 *
 * 场景：插件把 cwd 当成了记忆库根，在 profile 下另建了一套。
 * 档案是真数据，不能丢；合并时重算 prev/hash，接在目标文件尾部。
 *
 * 用法：
 *   node scripts/migrate-archive.mjs <fromDir> <toDir>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashOf, verifyChain } from '../lib/archive.js'
import { atomicWriteJson, readJsonSafe } from '../lib/util.js'

const [from, to] = process.argv.slice(2)
if (!from || !to) {
  console.error('用法: node scripts/migrate-archive.mjs <fromDir> <toDir>')
  process.exit(1)
}
if (!existsSync(from)) {
  console.error(`源目录不存在：${from}`)
  process.exit(1)
}

const fromMsgs = join(from, '10_archive', 'messages')
const toMsgs = join(to, '10_archive', 'messages')
mkdirSync(toMsgs, { recursive: true })

const existing = new Set()
for (const f of existsSync(toMsgs) ? readdirSync(toMsgs).filter((x) => x.endsWith('.jsonl')) : []) {
  for (const line of readFileSync(join(toMsgs, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const r = JSON.parse(line)
      if (Number.isFinite(r.seq)) existing.add(`${r.session}:${r.seq}`)
    } catch {
      /* 坏行忽略 */
    }
  }
}

const files = existsSync(fromMsgs) ? readdirSync(fromMsgs).filter((x) => x.endsWith('.jsonl')).sort() : []
let moved = 0
let skipped = 0

for (const f of files) {
  const target = join(toMsgs, f)
  const lines = readFileSync(join(fromMsgs, f), 'utf8').split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (Number.isFinite(rec.seq) && existing.has(`${rec.session}:${rec.seq}`)) {
      skipped++
      continue
    }
    // 目标文件当前链尾
    let prev = 'genesis'
    if (existsSync(target)) {
      const tail = readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean)
      if (tail.length) {
        const last = JSON.parse(tail[tail.length - 1])
        prev = last.hash || hashOf(last)
      }
    }
    rec.prev = prev
    rec.hash = hashOf(rec)
    appendFileSync(target, JSON.stringify(rec) + '\n', 'utf8')
    if (Number.isFinite(rec.seq)) existing.add(`${rec.session}:${rec.seq}`)
    moved++
  }
}

// 游标
const cursorFrom = readJsonSafe(join(from, '20_state', 'cursors.json'), { sessions: {} })
const cursorTo = readJsonSafe(join(to, '20_state', 'cursors.json'), { version: 1, sessions: {} })
cursorTo.version = 1
cursorTo.sessions = cursorTo.sessions || {}
for (const [s, seq] of Object.entries(cursorFrom.sessions || {})) {
  cursorTo.sessions[s] = Math.max(Number(cursorTo.sessions[s]) || -1, Number(seq) || -1)
}
atomicWriteJson(join(to, '20_state', 'cursors.json'), cursorTo)

// inj10：取较大的 tick，inj 数组取并集
const injFrom = readJsonSafe(join(from, '20_state', 'inj10.json'), null)
const injTo = readJsonSafe(join(to, '20_state', 'inj10.json'), null)
if (injFrom) {
  const merged = injTo && typeof injTo === 'object' ? injTo : { version: 1, tick: 0, points: {} }
  merged.version = 1
  merged.tick = Math.max(Number(merged.tick) || 0, Number(injFrom.tick) || 0)
  merged.points = merged.points || {}
  for (const [id, s] of Object.entries(injFrom.points || {})) {
    const cur = merged.points[id] || { inj: [] }
    cur.inj = [...new Set([...(Array.isArray(cur.inj) ? cur.inj : []), ...(Array.isArray(s.inj) ? s.inj : [])])].sort(
      (a, b) => a - b,
    )
    if (s.ll) cur.ll = s.ll
    merged.points[id] = cur
  }
  atomicWriteJson(join(to, '20_state', 'inj10.json'), merged)
}

// 会话文件：目标没有才拷
const fromSessions = join(from, '20_state', 'sessions')
if (existsSync(fromSessions)) {
  mkdirSync(join(to, '20_state', 'sessions'), { recursive: true })
  for (const f of readdirSync(fromSessions).filter((x) => x.endsWith('.json'))) {
    const dest = join(to, '20_state', 'sessions', f)
    if (existsSync(dest)) continue
    writeFileSync(dest, readFileSync(join(fromSessions, f)))
  }
}

// 校验目标最后 100 条
const targetFiles = readdirSync(toMsgs).filter((x) => x.endsWith('.jsonl')).sort()
const lastFile = targetFiles[targetFiles.length - 1]
const records = readFileSync(join(toMsgs, lastFile), 'utf8').split(/\r?\n/).filter(Boolean).slice(-100).map((l) => JSON.parse(l))
console.log(`迁移 ${moved} 条，跳过重复 ${skipped} 条；目标 ${lastFile} 末尾校验：`, verifyChain(records))
