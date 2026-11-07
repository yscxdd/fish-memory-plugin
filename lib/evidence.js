// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * evidence.js — 把一条点的 source 逐条打回原文（v0.69.0，T6）。
 *
 * 为什么需要：`audit` 只抽样验"source 存在性"，而"给人看"的查证要自己翻档案、对 hash。
 * 视频里那句"**存证据，别只存结论**"——存了证据却查不动，等于只存了结论。
 *
 * 只读：
 *   · `msg-…`  → 打回档案那一行的原文 + 所在文件 + 验链结果
 *   · `asset:…`/`book:…` → 素材条目 + verifyAsset 结果
 *   · 末尾一行结论：`N/N 条证据可回溯，链完好`
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadAssets, parseAssetSource, verifyAsset } from './assets.js'
import { checkArchive } from './integrity.js'
import { readArchive, readPointFiles } from './toolkit.js'

const clip = (s, n = 120) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * @returns {{ok:boolean, id:string, rows:object[], total:number, okCount:number, chain:{ok:boolean,checked:number}, problems:string[]}}
 */
export function evidenceOf(dir, id) {
  const point = readPointFiles(dir, '30_points').find((p) => p.id === id)
  if (!point) return { ok: false, id, rows: [], total: 0, okCount: 0, chain: { ok: true, checked: 0 }, problems: [`没有这一条：${id}`] }

  const archive = readArchive(dir)
  const chain = checkArchive(dir, { persist: false })
  const brokenFiles = new Set((chain.broken || []).map((b) => b.file))
  const assets = loadAssets(dir)

  const rows = []
  const problems = []
  for (const src of point.source || []) {
    if (String(src).startsWith('asset:') || String(src).startsWith('book:')) {
      const ref = parseAssetSource(src)
      if (!ref) {
        rows.push({ src, kind: 'asset', ok: false, note: '写法不对' })
        problems.push(`${src}: 素材源写法不对`)
        continue
      }
      const entry = assets.books?.[ref.id]
      let ok = Boolean(entry)
      let note = entry ? `素材：${entry.title || ref.id}` : '素材清单里没有这一项'
      if (entry) {
        try {
          const v = verifyAsset(dir, src, { books: assets.books })
          if (v && v.ok === false) {
            ok = false
            note += '（内容校验没过）'
          }
        } catch {
          /* 校验器不可用不阻断 */
        }
      }
      rows.push({ src, kind: 'asset', ok, note })
      if (!ok) problems.push(`${src}: ${note}`)
      continue
    }

    const msg = archive.byId.get(src)
    if (!msg) {
      rows.push({ src, kind: 'msg', ok: false, note: '档案里找不到这条消息' })
      problems.push(`${src}: 档案里找不到`)
      continue
    }
    const file = `${String(msg.ts || '').slice(0, 10)}.jsonl`
    const chainOk = !brokenFiles.has(file)
    rows.push({
      src,
      kind: 'msg',
      ok: chainOk,
      role: msg.role,
      at: msg.ts,
      text: clip(msg.text),
      file,
      note: chainOk ? '链完好' : '所在文件链有问题',
    })
    if (!chainOk) problems.push(`${src}: 所在文件 ${file} 链有问题`)
  }

  const okCount = rows.filter((r) => r.ok).length
  return {
    ok: problems.length === 0 && chain.ok,
    id,
    title: point.title,
    status: point.status,
    rows,
    total: rows.length,
    okCount,
    chain: { ok: chain.ok, checked: chain.checked },
    problems,
  }
}

/** 终端输出 */
export function renderEvidence(r) {
  const lines = [`证据：${r.id}${r.title ? ` · ${r.title}` : ''}${r.status ? `（${r.status}）` : ''}`, '']
  if (!r.rows.length) lines.push('  （这条点没有 source——按纪律它本来不该入库）')
  for (const row of r.rows) {
    if (row.kind === 'msg') {
      lines.push(`  ${row.ok ? '✓' : '✗'} ${row.src} · ${row.role === 'assistant' ? '她' : '你'} · ${String(row.at || '').slice(0, 16)}`)
      lines.push(`      「${row.text}」`)
      lines.push(`      文件 ${row.file} · ${row.note}`)
    } else {
      lines.push(`  ${row.ok ? '✓' : '✗'} ${row.src} · ${row.note}`)
    }
  }
  lines.push('')
  lines.push(`  ${r.okCount}/${r.total} 条证据可回溯，${r.chain.ok ? '链完好' : '链有问题'}（验了 ${r.chain.checked} 个档案文件）`)
  for (const p of r.problems.slice(0, 5)) lines.push(`  ✗ ${p}`)
  return lines.join('\n')
}
