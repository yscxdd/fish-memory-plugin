// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * integrity.js — 档案完整性：说得出"哪一天的档案被动过"。
 *
 * 原来的自检（archive.js 的 verifyLatest）只看**最后一个文件**的**最后 100 行**，
 * 所以改前天的 `.jsonl` 在启动时完全看不见——只有手工跑 `memory audit` 才会发现。
 *
 * 做法：**指纹清单**。
 *   - `20_state/archive-manifest.json` 存每个文件 `{count, firstHash, lastHash, bytes}`。
 *   - 每次启动（首次建库时）把清单和磁盘对一遍：
 *       少了文件 / 文件变了 → 报出来（写 50_log/archive-integrity.log）；
 *       多了新文件 → 正常（新的一天）。
 *   - **当天那个文件不参与"变了"判定**（它本来就会长），只更新它的基准。
 *
 * 成本：一次读完所有 `.jsonl`。超过 `MAX_VERIFY_BYTES` 就不再逐条验链，
 * 改成"每文件首尾各 100 条"抽样，并在结果里标 `sampled: true`——**宁可说"我抽样了"，
 * 也不要假装全验过**。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyChain } from './archive.js'

export const MANIFEST_FILE = join('20_state', 'archive-manifest.json')
export const INTEGRITY_LOG = join('50_log', 'archive-integrity.log')
export const MANIFEST_VERSION = 1
/** 超过这个体量就退到抽样（全量验链是 O(字节)，十万条以后启动会明显变慢） */
export const MAX_VERIFY_BYTES = 16 * 1024 * 1024
const SAMPLE = 100

function listArchive(dir) {
  const base = join(dir, '10_archive', 'messages')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((name) => ({ name, path: join(base, name), bytes: statSync(join(base, name)).size }))
}

function parseLines(text) {
  const out = { records: [], bad: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.records.push(JSON.parse(line))
    } catch {
      out.bad += 1
    }
  }
  return out
}

/**
 * 一个文件的指纹。`firstHash/lastHash` 用的是记录自己的 hash 字段。
 * @returns {{count:number, firstHash:string|null, lastHash:string|null, bytes:number, bad:number}}
 */
export function fingerprintFile(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { count: 0, firstHash: null, lastHash: null, bytes: 0, bad: 1 }
  }
  const { records, bad } = parseLines(text)
  return {
    count: records.length,
    firstHash: records.length ? records[0].hash || null : null,
    lastHash: records.length ? records[records.length - 1].hash || null : null,
    bytes: Buffer.byteLength(text, 'utf8'),
    bad,
  }
}

/** 链校验：小文件全量；大文件只验首尾各 100 条（结果里标 sampled） */
function chainOf(path, bytes, totalBytes) {
  const text = readFileSync(path, 'utf8')
  const { records } = parseLines(text)
  if (totalBytes <= MAX_VERIFY_BYTES) return { ...verifyChain(records), sampled: false }
  const head = records.slice(0, SAMPLE)
  const tail = records.slice(-SAMPLE)
  return { ...verifyChain([...head, ...tail]), sampled: true }
}

export function readManifest(dir) {
  const path = join(dir, MANIFEST_FILE)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || raw.version !== MANIFEST_VERSION || typeof raw.files !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/** 写清单；写不进去不抛（别让完整性检查把插件弄挂） */
export function writeManifest(dir, files, now = new Date().toISOString()) {
  const path = join(dir, MANIFEST_FILE)
  const payload = {
    version: MANIFEST_VERSION,
    at: now,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    note: '当天那个文件每次都更新基准；更早的文件变了就是被改过',
  }
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 对一遍"清单 vs 磁盘"。
 *
 * @param {string} dir
 * @param {{persist?:boolean, now?:string}} [opts] persist=false 时只查不写（audit 用）
 * @returns {{
 *   ok:boolean, firstRun:boolean, checked:number, bytes:number, sampled:boolean,
 *   changed:string[], missing:string[], added:string[], grown:string[],
 *   broken:{file:string, reason:string}[], badLines:{file:string, count:number}[],
 *   newest:string|null
 * }}
 */
export function checkArchive(dir, { persist = true, now = new Date().toISOString() } = {}) {
  const files = listArchive(dir)
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const prev = readManifest(dir)
  const firstRun = !prev

  const changed = []
  const missing = []
  const added = []
  const grown = []
  const broken = []
  const badLines = []
  const next = {}
  let sampled = false

  // 排序后的最后一个 = 当天的文件：它还会长，不参与"变了"判定
  const newest = files.length ? files[files.length - 1].name : null

  for (const f of files) {
    const fp = fingerprintFile(f.path)
    next[f.name] = { count: fp.count, firstHash: fp.firstHash, lastHash: fp.lastHash, bytes: fp.bytes }
    if (fp.bad) badLines.push({ file: f.name, count: fp.bad })

    // 先验链：下面"是不是纯追加"的判断要建立在链完整上
    const chain = chainOf(f.path, f.bytes, totalBytes)
    if (chain.sampled) sampled = true
    if (!chain.ok) broken.push({ file: f.name, reason: chain.reason || '链校验未通过' })

    if (prev) {
      const before = prev.files[f.name]
      if (!before) added.push(f.name)
      else if (f.name !== newest) {
        // 跨天之后，昨天的文件也会走到这里。**档案只追加是合法操作**，
        // 所以"变长 + 首条 hash 没变 + 链完整"不算被改——那是正常追加。
        // 之前这里一律按"变了"处理，于是每天 0 点后必然误报一次
        // （基线停在白天某次检查，昨天最后 100 多条追加没进基线）。
        if (before.firstHash === fp.firstHash && fp.count > before.count && chain.ok && !fp.bad) {
          grown.push(f.name)
        } else if (before.count !== fp.count || before.lastHash !== fp.lastHash || before.firstHash !== fp.firstHash) {
          changed.push(f.name)
        }
      }
    }
  }

  if (prev) for (const name of Object.keys(prev.files)) if (!files.some((f) => f.name === name)) missing.push(name)

  // grown 也要写回：否则基线永远停在旧值，下一次跨天又误报
  if (persist && (firstRun || changed.length || missing.length || added.length || grown.length || broken.length)) {
    writeManifest(dir, next, now)
  }

  return {
    ok: !changed.length && !missing.length && !broken.length && !badLines.length && !sampled,
    firstRun,
    checked: files.length,
    bytes: totalBytes,
    sampled,
    changed,
    missing,
    added,
    grown,
    broken,
    badLines,
    newest,
  }
}
