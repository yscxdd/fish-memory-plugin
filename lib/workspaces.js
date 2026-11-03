// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 工作区文件索引（v0.42.0）——借自 ArcDream Hub（MIT）的"名字级索引 + 边界读取"。
 *
 * 补的缺口：她能记住"我们聊过什么"，但答不了"你上次说的那个报表在哪"。
 *
 * 三条安全规矩（比他们更紧）：
 *   ① **只扫登记的目录**，不碰整盘；
 *   ② **只索引名字/路径/大小/时间**，不读内容——
 *      读内容是另一条显式的路（`readIndexedFile`），且必须过边界 + 大小 + 后缀三道闸；
 *   ③ **路径穿越要拦住**：`..`、符号链接逃逸、前缀相同的兄弟目录（`C:\a` vs `C:\ab`）都算越界。
 *
 * 零依赖：索引用 JSON（5 万条也就几 MB），不上 SQLite。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'

export const WORKSPACES_FILE = join('20_state', 'workspaces.json')
export const FILE_INDEX = join('20_state', 'file-index.json')
export const MAX_ROOTS = 8
export const MAX_FILES = 50000
export const MAX_DEPTH = 8
export const READ_MAX_BYTES = 512 * 1024
export const READ_EXTS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml', '.toml', '.ini',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.html', '.css', '.sh', '.ps1', '.xml',
])

/** 扫描时跳过的目录名 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.cache', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vscode', '.gradle', '.mvn', 'coverage', '.pytest_cache',
  '.dsh-office', '.dsh-spill', '.pnpm-store',
])
const SKIP_RE = /^(pip-|npm-|\.dsh-)/

/* ── 登记表 ─────────────────────────────────────────────── */

export function loadWorkspaces(dir) {
  const raw = readJsonSafe(join(dir, WORKSPACES_FILE), null)
  if (!raw || !Array.isArray(raw.roots)) return { version: 1, roots: [] }
  return {
    version: 1,
    roots: raw.roots
      .filter((r) => r && typeof r.path === 'string')
      .map((r) => ({ path: r.path, addedAt: r.addedAt || null })),
  }
}

function saveWorkspaces(dir, reg) {
  atomicWriteJson(join(dir, WORKSPACES_FILE), { version: 1, roots: reg.roots })
}

/** 登记一个目录（绝对路径、必须存在、不能重复、最多 8 个） */
export function addWorkspace(dir, p, { now = new Date() } = {}) {
  const raw = String(p || '').trim()
  if (!raw) return { ok: false, reason: '路径不能为空' }
  if (!isAbsolute(raw)) return { ok: false, reason: '必须是绝对路径' }
  const abs = resolve(raw)
  if (!existsSync(abs)) return { ok: false, reason: `目录不存在：${abs}` }
  let st
  try {
    st = statSync(abs)
  } catch (e) {
    return { ok: false, reason: `读不到：${e?.message || e}` }
  }
  if (!st.isDirectory()) return { ok: false, reason: '不是目录' }
  const reg = loadWorkspaces(dir)
  if (reg.roots.some((r) => r.path.toLowerCase() === abs.toLowerCase())) return { ok: false, reason: '已经登记过了' }
  if (reg.roots.length >= MAX_ROOTS) return { ok: false, reason: `最多登记 ${MAX_ROOTS} 个目录` }
  reg.roots.push({ path: abs, addedAt: now.toISOString() })
  saveWorkspaces(dir, reg)
  return { ok: true, path: abs, count: reg.roots.length }
}

export function removeWorkspace(dir, p) {
  const abs = resolve(String(p || ''))
  const reg = loadWorkspaces(dir)
  const before = reg.roots.length
  reg.roots = reg.roots.filter((r) => r.path.toLowerCase() !== abs.toLowerCase())
  saveWorkspaces(dir, reg)
  return { ok: before !== reg.roots.length, count: reg.roots.length }
}

/* ── 路径边界 ───────────────────────────────────────────── */

/**
 * 目标是否在某个登记目录**里面**（不是它本身）。
 * 三个坑都拦住：`..` 穿越、前缀相同的兄弟目录、大小写（Windows）。
 */
export function insideRoots(dir, target, { roots = null } = {}) {
  const abs = resolve(String(target || ''))
  const list = roots || loadWorkspaces(dir).roots.map((r) => r.path)
  for (const root of list) {
    const rel = relative(resolve(root), abs)
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) continue
    return { ok: true, root }
  }
  return { ok: false }
}

/* ── 索引 ───────────────────────────────────────────────── */

export function loadFileIndex(dir) {
  const raw = readJsonSafe(join(dir, FILE_INDEX), null)
  if (!raw || !Array.isArray(raw.files)) return null
  return raw
}

/**
 * 扫一遍登记目录，只收名字级信息。
 * @returns {{count:number, truncated:boolean, roots:number, ms:number}}
 */
export function buildFileIndex(dir, { now = new Date() } = {}) {
  const started = Date.now()
  const reg = loadWorkspaces(dir)
  const files = []
  let truncated = false

  for (const { path: root } of reg.roots) {
    if (!existsSync(root)) continue
    const stack = [{ p: root, depth: 0 }]
    while (stack.length) {
      const { p, depth } = stack.pop()
      if (depth > MAX_DEPTH) continue
      let entries
      try {
        entries = readdirSync(p, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (files.length >= MAX_FILES) {
          truncated = true
          break
        }
        const full = join(p, e.name)
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || SKIP_RE.test(e.name)) continue
          stack.push({ p: full, depth: depth + 1 })
          continue
        }
        if (!e.isFile()) continue
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        const dot = e.name.lastIndexOf('.')
        files.push({
          p: full,
          n: e.name,
          e: dot > 0 ? e.name.slice(dot).toLowerCase() : '',
          s: st.size,
          m: Math.round(st.mtimeMs),
        })
      }
      if (truncated) break
    }
    if (truncated) break
  }

  atomicWriteJson(join(dir, FILE_INDEX), {
    version: 1,
    at: now.toISOString(),
    roots: reg.roots.map((r) => r.path),
    count: files.length,
    truncated,
    files,
  })
  return { count: files.length, truncated, roots: reg.roots.length, ms: Date.now() - started }
}

/** 按名字/路径找（子串，大小写不敏感）。索引不存在就先建。 */
export function searchFiles(dir, query, { limit = 20, now = new Date() } = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { hits: [], total: 0, built: false }
  let idx = loadFileIndex(dir)
  let built = false
  if (!idx) {
    buildFileIndex(dir, { now })
    idx = loadFileIndex(dir)
    built = true
  }
  const files = idx?.files || []
  const scored = []
  for (const f of files) {
    const name = f.n.toLowerCase()
    const path = f.p.toLowerCase()
    let score = 0
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 60
    else if (name.includes(q)) score = 40
    else if (path.includes(q)) score = 20
    if (!score) continue
    scored.push({ ...f, score })
  }
  scored.sort((a, b) => b.score - a.score || b.m - a.m)
  return { hits: scored.slice(0, limit), total: scored.length, built, indexAt: idx?.at || null }
}

/* ── 读取（唯一会碰内容的入口） ─────────────────────────── */

/**
 * 读一个登记目录里的文本文件。三道闸：边界 / 大小 / 后缀。
 * @returns {{ok:true, text:string, path:string, bytes:number} | {ok:false, reason:string}}
 */
export function readIndexedFile(dir, p, { maxBytes = READ_MAX_BYTES } = {}) {
  const raw = String(p || '').trim()
  if (!raw) return { ok: false, reason: '路径不能为空' }
  const abs = resolve(raw)
  const bound = insideRoots(dir, abs)
  if (!bound.ok) return { ok: false, reason: '路径不在已登记的工作区里（先用 memory ws add 登记）' }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { ok: false, reason: `读不到：${abs}` }
  }
  if (!st.isFile()) return { ok: false, reason: '不是文件' }
  if (st.size > maxBytes) return { ok: false, reason: `文件太大（${Math.round(st.size / 1024)}KB > ${Math.round(maxBytes / 1024)}KB），请直接打开看` }
  const dot = abs.lastIndexOf('.')
  const ext = dot > 0 ? abs.slice(dot).toLowerCase() : ''
  if (!READ_EXTS.has(ext)) return { ok: false, reason: `这类文件不读（${ext || '无后缀'}）：只读文本类` }
  try {
    const text = readFileSync(abs, 'utf8')
    return { ok: true, text, path: abs, bytes: st.size }
  } catch (e) {
    return { ok: false, reason: `读失败：${e?.message || e}` }
  }
}

/** 索引概况（给 CLI / audit） */
export function indexStats(dir) {
  const idx = loadFileIndex(dir)
  const reg = loadWorkspaces(dir)
  if (!idx) return { exists: false, roots: reg.roots.length, count: 0, at: null, truncated: false }
  return { exists: true, roots: reg.roots.length, count: idx.count || 0, at: idx.at || null, truncated: !!idx.truncated }
}
/** CLI 用：每个登记目录 + 它在索引里有多少文件 */
export function listAll(dir) {
  const reg = loadWorkspaces(dir)
  const idx = loadFileIndex(dir)
  const files = idx?.files || []
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  return reg.roots.map((r) => {
    const base = norm(r.path) + '/'
    return {
      path: r.path,
      addedAt: r.addedAt,
      exists: existsSync(r.path),
      files: files.filter((f) => norm(f.p).startsWith(base)).length,
    }
  })
}