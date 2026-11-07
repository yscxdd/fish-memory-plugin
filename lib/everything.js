// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * Everything 加速器（v0.43.0）。
 *
 * 为什么用它：我们的 JSON 索引只扫登记目录、要手动重建；Everything 走 NTFS MFT + USN，
 * **全盘、毫秒级、永远最新**。它补的正是我们"只能看登记目录"的短板。
 *
 * 三种接法，按可移植性排序，我们选第三种：
 *   · HTTP Server（要开端口，多一个监听面）
 *   · ETP/FTP（只能列目录，不能搜）
 *   · **ES.exe（官方命令行，走 IPC，不开端口）← 我们用这个**
 *
 * 三道闸（一条都不能少）：
 *   ① **结果必须过滤到登记工作区**——Everything 搜的是全盘（`C:\Windows`、别人的文件都在里面）；
 *   ② 只拿名字/路径/大小/修改时间，不拿内容；
 *   ③ 读内容仍然只能走 `memory read`（边界 + ≤512KB + 后缀白名单）。
 *
 * 实测（Everything 1.5.0.1424b + es.exe 1.1.0.38）：
 *   · 输出是 **UTF-16LE 带 BOM**（FF FE），不是 UTF-8
 *   · `-json` 字段：`filename`（全路径）/ `size` / `date_modified`（**Windows FILETIME**，100ns 起 1601）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'
import { insideRoots } from './workspaces.js'

export const EVERYTHING_FILE = join('20_state', 'everything.json')
export const ES_NAMES = ['es.exe']
export const FILETIME_EPOCH_MS = 11644473600000

/** 写/读 es.exe 路径（省得每次去注册表找） */
export function loadConfig(dir) {
  const raw = readJsonSafe(join(dir, EVERYTHING_FILE), null)
  return {
    enabled: raw?.enabled !== false,
    esPath: typeof raw?.esPath === 'string' && raw.esPath ? raw.esPath : null,
  }
}

export function saveConfig(dir, patch) {
  const cur = loadConfig(dir)
  atomicWriteJson(join(dir, EVERYTHING_FILE), { version: 1, ...cur, ...patch })
  return loadConfig(dir)
}

/** 从注册表拿安装目录（Everything 自己的安装信息，最可靠） */
/**
 * A14（v0.74.0）：以前 `detect()` 会无条件 spawn `reg.exe` 去读注册表。
 *
 * 在管控机器/沙箱里这会被拦、会超时，而它只是"猜一个安装目录"——
 * 猜不到就猜不到，不该拖住启动。现在：
 *   ① 先看环境变量（零成本）；
 *   ② registry 这一步**默认跳过**，要它跑得显式 `FISH_MEMORY_EVERYTHING_REG=1`；
 *   ③ 真正跑的时候也带超时。
 */
// A14（v0.74.0）：外部进程探测整体可关（沙箱/管控机器）。
// 注册表默认**不开**（那是最容易被拦的一步），要它就显式 FISH_MEMORY_EVERYTHING_REG=1。
const REG_ENABLED = process.env.FISH_MEMORY_EVERYTHING_REG === '1'
const NO_SPAWN = process.env.FISH_MEMORY_EVERYTHING_NO_SPAWN === '1'

function installDirFromRegistry(run = spawnSync) {
  if (!REG_ENABLED) return null

  const keys = [
    'HKLM\\SOFTWARE\\voidtools\\Everything',
    'HKCU\\Software\\voidtools\\Everything',
  ]
  for (const key of keys) {
    try {
      const r = run('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', timeout: 4000 })
      if (r.status !== 0 || !r.stdout) continue
      const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(r.stdout)
      if (m?.[1]) return m[1].trim()
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return null
}

/**
 * 找 es.exe。
 * 顺序：env `EVERYTHING_ES` → `20_state/everything.json` → 注册表安装目录 → PATH。
 * @returns {{available:boolean, esPath:string|null, source:string, reason?:string}}
 */
export function detect(dir, { run = spawnSync, env = process.env, registry = null } = {}) {
  const fromEnv = env.EVERYTHING_ES
  if (fromEnv && existsSync(fromEnv)) return { available: true, esPath: fromEnv, source: 'env' }

  const cfg = loadConfig(dir)
  if (cfg.esPath && existsSync(cfg.esPath)) return { available: true, esPath: cfg.esPath, source: 'config' }

  const regDir = registry !== null ? registry : installDirFromRegistry(run)
  if (regDir) {
    for (const name of ES_NAMES) {
      const p = join(regDir, name)
      if (existsSync(p)) return { available: true, esPath: p, source: 'registry' }
    }
  }

  // A14：整体禁用外部进程时，连 where 也不跑（让它 0ms 返回，而不是被拦一次再超时）
  if (NO_SPAWN) return { available: false, esPath: null, source: 'none', reason: '已禁用外部进程探测（FISH_MEMORY_EVERYTHING_NO_SPAWN=1）' }

  try {
    const r = run('where', ['es.exe'], { encoding: 'utf8', timeout: 3000 })
    const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (r.status === 0 && line && existsSync(line)) return { available: true, esPath: line, source: 'path' }
  } catch {
    /* ignore */
  }
  return { available: false, esPath: null, source: 'none', reason: '没找到 es.exe（可放进 Everything 安装目录，或设 EVERYTHING_ES）' }
}

/** Windows FILETIME（100ns since 1601）→ 毫秒 */
export function filetimeToMs(ft) {
  const n = Number(ft)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n / 10_000 - FILETIME_EPOCH_MS)
}

/** 一行 JSON → 统一形状 {p,n,s,m} */
export function normalizeRow(row) {
  const p = String(row?.filename || row?.path || row?.full_path || '')
  if (!p) return null
  const n = p.split(/[\\/]/).pop() || p
  const s = Number(row?.size)
  const m = filetimeToMs(row?.date_modified)
  return { p, n, s: Number.isFinite(s) && s >= 0 ? s : 0, m }
}

/** 解析 es.exe 的输出（UTF-16LE + BOM，容错 UTF-8） */
export function parseOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8')
  // 实测（es.exe 1.1.0.38 + 中文 Windows）：
  //   · 重定向到文件时是 UTF-16LE + BOM（FF FE）
  //   · **管道传给我们时是 GBK（控制台代码页），不是 UTF-8**——直接按 utf8 解会出乱码
  // 所以：先认 BOM，再用"严格 UTF-8"试一次，失败就退 GBK。
  let text
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.slice(2).toString('utf16le')
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.slice(3).toString('utf8')
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      try {
        text = new TextDecoder('gbk').decode(buf)
      } catch {
        text = buf.toString('utf8')
      }
    }
  }
  const t = text.trim()
  if (!t) return []
  try {
    const j = JSON.parse(t)
    return Array.isArray(j) ? j.map(normalizeRow).filter(Boolean) : []
  } catch {
    return []
  }
}

/** 查一次（不过滤）。失败返回 {ok:false}，绝不抛。 */
export function searchRaw(q, { esPath, limit = 50, timeoutMs = 2000, run = spawnSync } = {}) {
  const query = String(q || '').replace(/[\r\n]+/g, ' ').trim()
  if (!query) return { ok: false, reason: '空查询', rows: [] }
  if (!esPath) return { ok: false, reason: '没有 es.exe', rows: [] }
  try {
    const r = run(esPath, ['-n', String(limit), '-json', '-size', '-dm', '-full-path-and-name', query], {
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    if (r.status !== 0) return { ok: false, reason: `es.exe 退出码 ${r.status}`, rows: [] }
    return { ok: true, rows: parseOutput(r.stdout) }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), rows: [] }
  }
}

/**
 * 查 + **过滤到登记工作区**（这是安全闸，不是优化）。
 * @returns {{ok:boolean, mode:string, hits:Array, dropped:number, total:number, reason?:string}}
 */
export function findWithEverything(dir, q, { limit = 50, esPath = null, run = spawnSync, timeoutMs = 2000 } = {}) {
  const det = esPath ? { available: true, esPath } : detect(dir, { run })
  if (!det.available) return { ok: false, mode: 'unavailable', hits: [], dropped: 0, total: 0, reason: det.reason }
  const raw = searchRaw(q, { esPath: det.esPath, limit, run, timeoutMs })
  if (!raw.ok) return { ok: false, mode: 'error', hits: [], dropped: 0, total: 0, reason: raw.reason }
  const hits = []
  let dropped = 0
  for (const row of raw.rows) {
    if (insideRoots(dir, row.p).ok) hits.push(row)
    else dropped += 1
  }
  return { ok: true, mode: 'everything', hits, dropped, total: raw.rows.length }
}

/** 状态（给 CLI / audit） */
export function everythingStatus(dir, { run = spawnSync } = {}) {
  const det = detect(dir, { run })
  const cfg = loadConfig(dir)
  return { enabled: cfg.enabled, available: det.available, source: det.source, esPath: det.esPath, reason: det.reason || null }
}
