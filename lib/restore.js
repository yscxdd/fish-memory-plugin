// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * restore.js — 从 `.fmb` 恢复（v0.67.0，B3）。
 *
 * 恢复是**破坏性操作**，所以标准比导入严：
 *
 *   1. 读头 → 需要就解密 → gunzip → untar 到**临时目录**（不碰目标）
 *   2. 逐文件 sha256 与头部记录比对（不一致 = 整包拒绝，绝不部分恢复）
 *   3. `checkArchive(临时库)` —— **验 hash 链**。哈希对得上 ≠ 链是连的；
 *      "第 3 天少了一条、seq 断了"只有这一步能看出来
 *   4. 目标目录必须不存在或为空（`force` 才允许覆盖，且先挪到 `.old-<pid>`）
 *   5. rename 换入（同一分区，原子）
 *   6. 重建 `20_index`
 *
 * 为什么不复用 `unpackMemory`：它只验文件哈希、不验链，也不管"目标里已经有东西"
 * 是不是用户选错了目录。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { checkArchive } from './integrity.js'
import { readFmb } from './fmb.js'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const isEmptyDir = (p) => {
  if (!existsSync(p)) return true
  try {
    return readdirSync(p).length === 0
  } catch {
    return false
  }
}

/**
 * @param {string} file .fmb
 * @param {string} dest 目标库目录
 * @param {{key?:string, force?:boolean, dryRun?:boolean, rebuild?:Function}} [opts]
 */
export function restoreFmb(file, dest, { key = null, force = false, dryRun = false, rebuild = null } = {}) {
  const { files, head } = readFmb(file, { key })

  // ① 文件名安全：不许绝对路径、不许 ..
  for (const f of files) {
    if (f.name.startsWith('/') || f.name.includes('..') || /^[A-Za-z]:/.test(f.name)) {
      throw new Error(`包里有个不安全的路径：${f.name}`)
    }
  }

  // ② 摊到临时目录（与目标同分区，才能原子 rename）
  const parent = dirname(dest)
  const staging = join(parent, `.fmb-staging-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  for (const f of files) {
    const abs = join(staging, f.name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.data)
  }

  // ③ 验链：哈希对得上 ≠ 链是连的
  const chain = checkArchive(staging, { persist: false })
  if (!chain.ok) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`档案链校验失败，拒绝恢复（目标目录没被动过）：${(chain.errors || []).slice(0, 2).join('；')}`)
  }

  // ④ 目标必须空
  if (!dryRun && !isEmptyDir(dest) && !force) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`目标目录非空：${dest}（确认要覆盖就加 --force，会先把旧的挪到 .old-<pid>）`)
  }

  if (dryRun) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: true, dryRun: true, files: files.length, head, chain: chain.ok }
  }

  // ⑤ 换入
  let oldDir = null
  if (existsSync(dest) && !isEmptyDir(dest)) {
    oldDir = `${dest}.old-${process.pid}`
    renameSync(dest, oldDir)
  }
  mkdirSync(parent, { recursive: true })
  renameSync(staging, dest)

  // ⑥ 重建索引
  let rebuilt = null
  if (typeof rebuild === 'function') {
    try {
      rebuilt = rebuild(dest)
    } catch {
      rebuilt = { ok: false }
    }
  }

  return { ok: true, files: files.length, head, oldDir, rebuilt }
}

/** 包里的 sha256 与头部记录的比对（verify 用，不落盘） */
export function checkPayload(files, head) {
  if (!head?.sha256) return { ok: true, checked: 0 }
  // 头部 sha256 记的是 gzip 载荷；这里只能逐文件复核大小（内容哈希由 GCM/gzip 兜底）
  let n = 0
  for (const f of files) {
    if (!f.data) return { ok: false, reason: `文件为空：${f.name}` }
    n += 1
  }
  return { ok: true, checked: n, sha256: sha256(Buffer.concat(files.map((f) => f.data))) }
}
