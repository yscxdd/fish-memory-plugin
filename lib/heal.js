// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * heal.js — 两个兜底：核心层自愈 + 每日备份。
 *
 * ① healCore：00_core 下某个文件没了，从 versions/ 里最新的快照恢复；没有快照就告警。
 *    治的是"她把 soul.md 删了"这种不可逆事故——能恢复到最后一次改动前。
 * ② autoPack：每天打一份完整迁移包到记忆库**外面**的备份目录；同一天只打一次。
 * ③ pruneBackups（v0.8.0）：只保留最近 N 份。原来它**永不清理**，一天一份全量，
 *    含明文档案——增长和隐私两头都不合适。删的时候只认「fish-memory-YYYY-MM-DD」这个名字。
 *
 * 三者都不碰权限：权限是 DSH profile 的事，这里只保证"删了以后还能回来"。
 */

import { copyFileSync, existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { packMemory } from './pack.js'
import { localDay } from './util.js'

const CORE_FILES = ['soul.md', 'user.md', 'relation.md', 'rules.md']
/** 备份目录名必须长得像我们自己建的：一天一份 */
const BACKUP_NAME = /^fish-memory-\d{4}-\d{2}-\d{2}$/

function latestVersion(dir, base) {
  const vdir = join(dir, '00_core', 'versions')
  if (!existsSync(vdir)) return null
  const re = new RegExp(`^${base}\\.v(\\d+)\\.md$`)
  const versions = readdirSync(vdir)
    .map((n) => ({ n, m: n.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))
  return versions.length ? join(vdir, versions[0].n) : null
}

/**
 * @returns {{restored: string[], missing: string[]}}
 */
export function healCore(dir) {
  const restored = []
  const missing = []
  for (const f of CORE_FILES) {
    const target = join(dir, '00_core', f)
    if (existsSync(target)) continue
    const snap = latestVersion(dir, f.replace(/\.md$/, ''))
    if (!snap) {
      missing.push(f)
      continue
    }
    copyFileSync(snap, target)
    restored.push(f)
  }
  // 关键文件全没、连快照都没有：至少把目录建出来，别让后续读取炸
  return { restored, missing }
}

/**
 * 删掉过旧的备份，只留最近 `keep` 份。
 *
 * 安全规矩（宁可少删，不可误删）：
 *   - 只认目录名 `fish-memory-YYYY-MM-DD`；别的一律不碰（包括用户的其它文件夹）
 *   - 解析后必须**真的在** backupRoot 里（防止软链接/怪名字把它带出去）
 *   - 只删普通文件与空目录；遇到软链接直接跳过
 *   - keep < 1 视为"不清理"（防止配置写 0 把全部备份删光）
 *
 * @param {string} root 备份根目录
 * @param {number} keep 保留份数
 * @returns {{kept:string[], removed:string[], skipped:string[]}}
 */
export function pruneBackups(root, keep = 7) {
  const out = { kept: [], removed: [], skipped: [] }
  const keepN = Number(keep)
  if (!Number.isFinite(keepN) || keepN < 1) return out
  if (!root || !existsSync(root)) return out

  const base = resolve(root)
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }

  const backups = entries
    .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name))
    .map((e) => e.name)
    .sort() // 名字里带日期，字典序就是时间序
  out.kept = backups.slice(-keepN)
  const doomed = backups.slice(0, Math.max(0, backups.length - keepN))

  for (const name of doomed) {
    const abs = resolve(base, name)
    // 必须仍落在 base 之内（防 ../ 或符号链接指出去）
    if (!abs.startsWith(base + sep)) {
      out.skipped.push(name)
      continue
    }
    try {
      const inside = readdirSync(abs, { withFileTypes: true })
      let clean = true
      for (const item of inside) {
        if (!item.isFile()) {
          clean = false
          break
        }
        unlinkSync(join(abs, item.name))
      }
      if (!clean) {
        out.skipped.push(name)
        continue
      }
      rmdirSync(abs)
      out.removed.push(name)
    } catch {
      out.skipped.push(name)
    }
  }
  return out
}

/**
 * 每日备份：同一天已存在就跳过；打完顺手按保留策略清理。
 * @returns {{dest:string, files:number, pruned:{kept:string[], removed:string[], skipped:string[]}}|null}
 */
export function autoPack(dir, backupRoot, { now = new Date(), keep = 7 } = {}) {
  const root = backupRoot || join(dirname(dir), 'fish-memory-backups')
  const day = localDay(now)
  const dest = join(root, `fish-memory-${day}`)
  if (existsSync(dest)) return null
  const r = packMemory(dir, dest)
  // 先打新的，再清旧的：顺序反了的话，万一打包失败就白删了
  const pruned = pruneBackups(root, keep)
  return { dest, files: r.files, pruned }
}
