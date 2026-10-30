// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * pack.js — 迁移包：只拷目录到新机器/新模型，她仍完整（总设计 §4.4 第 7 项）。
 *
 * 打包**不可再生的层**，不打包可重建的索引：
 *   00_core 10_archive 15_self 20_state 30_points 35_ability 40_pending 50_log
 *   排除：20_index（派生）、_samples、_debug、_segments/*.md（原文包可从档案重出）
 *
 * 格式是「目录 + MANIFEST.json」，不引入 zip 依赖；每个文件带 sha256，解包前先验。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { buildIndex, readPointFiles, writeIndex } from './toolkit.js'

export const PACK_VERSION = 1
export const PACK_INCLUDE = ['00_core', '10_archive', '15_self', '20_state', '30_points', '35_ability', '40_pending', '50_log']
const TOP_EXCLUDE = new Set(['20_index', '_samples', '_debug'])

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function shouldSkip(rel) {
  const parts = rel.split('/')
  if (parts.some((p) => TOP_EXCLUDE.has(p))) return true
  if (parts[0] === '40_pending' && parts[1] === '_segments' && rel.endsWith('.md')) return true
  return false
}

/** 列文件（相对路径用 /），跳过 junction / 符号链接 */
export function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = relative(base, abs).split('\\').join('/')
    if (shouldSkip(rel)) continue
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(abs, base, out)
    else if (entry.isFile()) out.push({ rel, abs, size: st.size })
  }
  return out
}

/**
 * 打包。目标目录必须不存在或为空。
 * @returns {{dest:string, files:number, bytes:number}}
 */
export function packMemory(src, dest, { force = false } = {}) {
  if (!existsSync(src)) throw new Error(`源目录不存在：${src}`)
  if (existsSync(dest) && readdirSync(dest).length && !force) throw new Error(`目标目录非空：${dest}（加 --force 覆盖）`)
  const tmp = `${dest}.tmp-${process.pid}`
  if (existsSync(tmp)) throw new Error(`临时目录已存在：${tmp}`)

  const entries = []
  for (const top of PACK_INCLUDE) {
    const d = join(src, top)
    if (!existsSync(d)) continue
    for (const f of walk(d, src)) entries.push(f)
  }
  if (!entries.some((e) => e.rel.startsWith('00_core/'))) throw new Error('源目录不像记忆库：没有 00_core/')

  mkdirSync(tmp, { recursive: true })
  const files = []
  let bytes = 0
  for (const e of entries) {
    const out = join(tmp, e.rel)
    mkdirSync(join(out, '..'), { recursive: true })
    copyFileSync(e.abs, out)
    const h = sha256(out)
    files.push({ path: e.rel, size: e.size, sha256: h })
    bytes += e.size
  }

  const manifest = {
    format: 'fish-memory-pack',
    version: PACK_VERSION,
    created_at: new Date().toISOString(),
    source: src,
    include: PACK_INCLUDE,
    files,
  }
  writeFileSync(join(tmp, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')

  if (existsSync(dest)) {
    // 空目录：只删空的
    try {
      renameSync(dest, `${dest}.old-${process.pid}`)
    } catch {
      /* 删不掉就报错 */
    }
  }
  renameSync(tmp, dest)
  return { dest, files: files.length, bytes }
}

/**
 * 解包到新目录：先验所有哈希，再拷；最后重建索引。
 * @returns {{dest:string, files:number, verified:number, rebuilt:number}}
 */
export function unpackMemory(packDir, dest, { force = false } = {}) {
  const manifestPath = join(packDir, 'MANIFEST.json')
  if (!existsSync(manifestPath)) throw new Error(`不是迁移包：缺 MANIFEST.json（${packDir}）`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.format !== 'fish-memory-pack') throw new Error(`包格式不对：${manifest.format}`)
  if (manifest.version > PACK_VERSION) throw new Error(`包版本过新：v${manifest.version} > v${PACK_VERSION}`)
  if (existsSync(dest) && readdirSync(dest).length && !force) throw new Error(`目标目录非空：${dest}（加 --force 覆盖）`)

  // 先验源，一个不对就整体不拷
  let verified = 0
  for (const f of manifest.files) {
    const p = join(packDir, f.path)
    if (!existsSync(p)) throw new Error(`包内缺文件：${f.path}`)
    const h = sha256(p)
    if (h !== f.sha256) throw new Error(`哈希不符：${f.path}`)
    verified += 1
  }

  const tmp = `${dest}.tmp-${process.pid}`
  mkdirSync(tmp, { recursive: true })
  for (const f of manifest.files) {
    const out = join(tmp, f.path)
    mkdirSync(join(out, '..'), { recursive: true })
    copyFileSync(join(packDir, f.path), out)
    if (sha256(out) !== f.sha256) throw new Error(`拷贝后哈希不符：${f.path}`)
  }
  if (existsSync(dest) && readdirSync(dest).length) {
    try {
      renameSync(dest, `${dest}.old-${process.pid}`)
    } catch {
      /* ignore */
    }
  }
  renameSync(tmp, dest)

  // 索引是派生的：解包后重建
  const points = readPointFiles(dest, '30_points')
  writeIndex(dest, buildIndex(points))
  return { dest, files: manifest.files.length, verified, rebuilt: points.filter((p) => p.status === 'active').length }
}
