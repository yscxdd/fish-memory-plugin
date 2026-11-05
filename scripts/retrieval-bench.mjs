#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * retrieval-bench.mjs — 两套中文检索的同题对照（v0.62.0 的测量件，不进插件包）。
 *
 * 为什么要有：`dsn-mnemo` 用的是「Intl.Segmenter 分词 + FTS5 BM25 + 字符级兜底」，
 * 我们用的是「二字组 + 覆盖率」。两套完全不同，**谁好在嘴上争不出来**。
 *
 * 跑法：
 *   node scripts/retrieval-bench.mjs            # 20 题 × 30 条记忆，两边各跑一遍
 *   node scripts/retrieval-bench.mjs --json     # 机器可读
 *
 * 口径（先说清楚，免得自己骗自己）：
 *   · 同一批记忆、同一批查询，**top-1 是否命中**；
 *   · 阈值都调到「只要能排进候选就算」——测的是**排序**，不是门控；
 *   · 记忆是**同一条文本**：我们的点 = 标题 + 摘要，它的日记 = 同一段文本；
 *   · 查询分三档：关键词（2-4 字）、短句、换说法（同义改写）——换说法那档才是真难点。
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rankHybrid } from '../lib/retrieve.js'
import { MEMORIES, QUERIES } from '../lib/benchdata.js'

export { MEMORIES, QUERIES }

// 默认路径从 homedir 拼，不写死任何人的家目录（仓库里不该出现个人绝对路径）
const MNEMO =
  process.env.MNEMO_LIB || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsn-mnemo', 'lib')

/** 我们的检索：记忆当成"点"，标题取第一句，摘要取全文 */
function oursTop1(query) {
  const points = MEMORIES.map((m) => ({
    id: m.id,
    title: m.text,
    summary: m.text,
    tags: [],
    date: '2026-11-05',
    salience: 3,
    status: 'active',
    type: 'event',
    cluster: '日常',
    origin: 'told',
    source: ['x'],
    links: [],
    quotes: [],
  }))
  const ranked = rankHybrid(points, query, { threshold: 0.05, limit: 3 })
  return ranked[0]?.point?.id ?? null
}

/** 它的检索：真跑 node:sqlite + FTS5 */
async function theirsTop1() {
  const { openDatabase } = await import(`file:///${MNEMO}/db/database.js`)
  const { insertDiary, searchDiaries } = await import(`file:///${MNEMO}/store/diary-store.js`)
  // 注意：recall.js 会 import '@deepseek-ai/dsh-tools'（本 profile 未安装），所以这里
  // **只用它的 SQL 排序**（`order by bm25(diaries_fts)`）——不含它额外的"重要度 + 近因"加权。
  // 这对它偏保守：真实链路里那一层会再拉开差距。

  const file = join(mkdtempSync(join(tmpdir(), 'mnemo-bench-')), 'bench.db')
  const db = openDatabase(file)
  const subject = { kind: 'user', id: 'bench' }

  const idOf = new Map()
  for (const m of MEMORIES) {
    const id = insertDiary(db, {
      content: m.text,
      subjectKind: subject.kind,
      subjectId: subject.id,
      importance: 0.5,
      emotion: 0.5,
      tags: '',
      visibility: 'private',
    })
    idOf.set(id, m.id)
  }

  const answer = (query) => {
    const q = String(query || '').trim()
    let hits = searchDiaries(db, q, 3, 'or', subject)
    if (!hits.length) hits = searchDiaries(db, q, 3, 'and', subject)
    return hits[0]?.id != null ? idOf.get(hits[0].id) ?? null : null
  }
  return { answer, close: () => db.close() }
}

if (!existsSync(MNEMO)) {
  console.error(`找不到 dsn-mnemo：${MNEMO}`)
  console.error('这个对照需要先把 dsn-mnemo 装回去（或设 MNEMO_LIB 指向它的 lib 目录）。')
  console.error('当时的跑分结果记在 docs/BENCH-2026-11-06-retrieval-vs-mnemo.md。')
  process.exit(2)
}

const mnemo = await theirsTop1()

const rows = []
for (const item of QUERIES) {
  const ours = oursTop1(item.q)
  const theirs = mnemo.answer(item.q)
  rows.push({
    q: item.q,
    kind: item.kind,
    expect: item.expect,
    ours,
    theirs,
    oursOk: ours === item.expect,
    theirsOk: theirs === item.expect,
  })
}
mnemo.close()

const byKind = (kind) => rows.filter((r) => r.kind === kind)
const rate = (arr, key) => (arr.length ? arr.filter((r) => r[key]).length / arr.length : 0)
const pct = (x) => `${Math.round(x * 100)}%`

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, total: rows.length }, null, 2))
} else {
  console.log('中文检索同题对照：20 题 × 30 条记忆（top-1 命中）\n')
  console.log('  档位          题数   bigram（我们）   FTS5（mnemo）')
  for (const kind of ['kw', 'sent', 'para']) {
    const arr = byKind(kind)
    console.log(`  ${kind.padEnd(12)}  ${String(arr.length).padStart(3)}   ${pct(rate(arr, 'oursOk')).padStart(10)}   ${pct(rate(arr, 'theirsOk')).padStart(12)}`)
  }
  console.log(`  ${'合计'.padEnd(12)}  ${String(rows.length).padStart(3)}   ${pct(rate(rows, 'oursOk')).padStart(10)}   ${pct(rate(rows, 'theirsOk')).padStart(12)}`)
  console.log('')
  const wrong = rows.filter((r) => !r.oursOk || !r.theirsOk)
  if (wrong.length) {
    console.log('  没中的题：')
    for (const r of wrong) {
      console.log(`    「${r.q}」 期望 ${r.expect} · 我们 ${r.ours ?? '空'} · 它 ${r.theirs ?? '空'}`)
    }
  }
}
