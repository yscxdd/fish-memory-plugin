#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * bench.mjs — 合成压测：不同记忆点数量下的检索耗时。
 * 只写临时目录，不碰真实记忆库。
 *
 * 用法：node scripts/bench.mjs --n 1000,10000,50000 --queries 20
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { rankHybrid } from '../lib/retrieve.js'

const args = process.argv.slice(2)
const arg = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const sizes = String(arg('--n', '1000,10000')).split(',').map(Number)
const Q = Number(arg('--queries', 20))

// 词表按真实场景放大：300 个词，10k 点时每个词约 30 条（而不是 18 个词各 500 条）
const WORDS = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x4e00 + i * 3) + String.fromCharCode(0x4e00 + i * 3 + 1))
const pick = (i) => [WORDS[i % WORDS.length], WORDS[(i * 7 + 3) % WORDS.length]]

function makeLib(n) {
  const dir = mkdtempSync(join(tmpdir(), `fishmem-bench-${n}-`))
  mkdirSync(join(dir, '30_points'), { recursive: true })
  for (let i = 0; i < n; i++) {
    const [a, b] = pick(i)
    const id = `M-2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}-${String(i % 1000).padStart(3, '0')}`
    const body = `---\nid: ${id}\ntitle: ${a}${b}那件事\nquote: null\ndate: 2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}\nsalience: ${1 + (i % 5)}\ntype: event\ncluster: ${a}\nevent: null\ntags: [${a}, ${b}]\nstatus: active\nsource: []\nlinks: []\n---\n\n<!-- SUM -->\n${a}${b}的一次记录，第 ${i} 条。\n<!-- /SUM -->\n`
    writeFileSync(join(dir, '30_points', `M-${i}.md`), body)
  }
  return dir
}

function ms(fn) {
  const t = process.hrtime.bigint()
  const r = fn()
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r }
}

const rows = []
for (const n of sizes) {
  const dir = makeLib(n)
  let store = new MemoryStore(dir)

  const cold = ms(() => store.indexPoints()) // 冷启动：扫文件 + 写 retrieval.json
  store = new MemoryStore(dir)
  const warm = ms(() => store.indexPoints()) // 热：读 retrieval.json

  const points = store.indexPoints()
  const queries = Array.from({ length: Q }, (_, i) => `${pick(i)[0]}那天`)
  const search = ms(() => {
    let hit = 0
    const byId = new Map(points.map((p) => [p.id, p]))
    for (const q of queries) {
      const cand = store.candidates(q)
      const pool = cand ? cand.map((id) => byId.get(id)).filter(Boolean) : points
      hit += rankHybrid(pool, q, { threshold: 0.8, limit: 20 }).length
    }
    return hit
  })

  rows.push({ n, cold: cold.ms.toFixed(0), warm: warm.ms.toFixed(0), perQuery: (search.ms / Q).toFixed(2), hits: search.r })
  rmSync(dir, { recursive: true, force: true })
}

console.log('点数\t冷扫(ms)\t热读(ms)\t每查询(ms)\t命中数')
for (const r of rows) console.log(`${r.n}\t${r.cold}\t${r.warm}\t${r.perQuery}\t${r.hits}`)
