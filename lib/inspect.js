// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * inspect.js — 借鉴竞品的"可见性"：一条命令看清库的状态与检索结果。
 * 它们有 Web UI/图；我们给 CLI 版，零依赖。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readArchive, readPointFiles } from './toolkit.js'
import { bigrams, rank } from './retrieve.js'

/** dormant 的点：她"记得有这件事"，但细节不该被补 */
export function dormantPoints(dir) {
  return readPointFiles(dir, '30_points').filter((p) => p.status === 'dormant')
}

/** 墓碑清单（最近 n 条，倒序） */
export function forgottenLog(dir, n = 30) {
  const p = join(dir, '50_log', 'eviction.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .slice(-n)
    .reverse()
}

export function statusOf(dir) {
  const points = readPointFiles(dir, '30_points')
  const pending = readPointFiles(dir, '40_pending')
  const active = points.filter((p) => p.status === 'active').length
  const merged = points.filter((p) => p.status === 'merged').length
  const fixtures = points.filter((p) => p.fixture).length
  const archive = readArchive(dir)
  const segDir = join(dir, '40_pending', '_segments')
  const segs = existsSync(segDir) ? readdirSync(segDir) : []
  const backupsDir = join(dirname(dir), 'fish-memory-backups')
  const backups = existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => n.startsWith('fish-memory-')).sort() : []
  const countLines = (f) => {
    const p = join(dir, '50_log', f)
    return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length : 0
  }
  return {
    dir,
    points: { total: points.length, active, merged, fixtures },
    pending: pending.length,
    archive: archive.messages.length,
    segments: { written: segs.filter((n) => n.endsWith('.md')).length, done: segs.filter((n) => n.endsWith('.done')).length },
    backups: { count: backups.length, latest: backups.length ? backups[backups.length - 1] : null },
    logs: { canary: countLines('canary.log'), guard: countLines('guard.log'), retrieval: countLines('retrieval.log') },
  }
}

export function searchMemory(dir, query, { limit = 8, threshold = 0.3 } = {}) {
  const points = readPointFiles(dir, '30_points')
  const ranked = rank(points, bigrams(query), { threshold, limit }).map((x) => ({
    id: x.point.id,
    title: x.point.title,
    score: +x.score.toFixed(2),
    salience: x.point.salience,
    status: x.point.status,
  }))
  const q = String(query || '').trim()
  const archive = readArchive(dir)
  const hits = q
    ? archive.messages.filter((m) => String(m.text).includes(q)).slice(-limit).map((m) => ({
        id: m.id,
        role: m.role,
        ts: m.ts,
        excerpt: String(m.text).slice(0, 60),
      }))
    : []
  return { points: ranked, archive: hits }
}
