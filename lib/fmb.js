// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * fmb.js — 单文件备份包 `.fmb`（v0.67.0，B1 + B2）。
 *
 * 为什么是**一个文件**：同步盘的同步粒度是文件、不是事务。把整库目录塞进去会
 * "边写边传"，还会在被删/改名时产生冲突副本——而档案 hash 链最怕分叉。
 * 所以同步盘只该看见"一个已经写完的文件"。
 *
 * 格式：
 *
 *   FMBACKUPv1\n                      12 字节魔数
 *   {头部 JSON}\n                     明文：v/enc/created_at/library/files/bytes/sha256/salt/iv
 *   <载荷>                            明文=tar.gz；加密=AES-256-GCM(tar.gz)
 *
 * **头部故意明文**：不解密也能看到"这是哪天的、多大、几个文件"，
 * 网盘里翻文件时不用先掏口令；也才能让 `verify` 在不给口令时报出"这是加密包"。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

import { PACK_INCLUDE } from './pack.js'
import { tarPack, tarUnpack } from './tar.js'

export const MAGIC = 'FMBACKUPv1\n'
export const FMB_EXT = '.fmb'
export const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, len: 32 })
export const IV_BYTES = 12
export const SALT_BYTES = 16

const TOP_EXCLUDE = new Set(['20_index', '_samples', '_debug', '90_snapshot'])
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 库里该进包的文件（相对路径 + 内容） */
export function collectFiles(dir) {
  const out = []
  const walk = (abs, base) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, e.name)
      if (e.isDirectory()) {
        if (base === '' && TOP_EXCLUDE.has(e.name)) continue
        walk(full, base === '' ? e.name : join(base, e.name))
        continue
      }
      if (!e.isFile()) continue
      const rel = base === '' ? e.name : `${base}/${e.name}`
      out.push({ name: rel.split(sep).join('/'), data: readFileSync(full), mtime: statSync(full).mtimeMs })
    }
  }
  for (const top of PACK_INCLUDE) {
    const abs = join(dir, top)
    if (!existsSync(abs)) continue
    walk(abs, top)
  }
  // v0.67.1（F7）：库根的 .md（MEMORY.md 之类）以前不在白名单里——
  // 那不是决定，是漏：恢复后"库的说明书没了"会让人以为库不完整。
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || !/\.md$/i.test(f.name)) continue
    const abs = join(dir, f.name)
    out.push({ name: f.name, data: readFileSync(abs), mtime: statSync(abs).mtimeMs })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function deriveKey(passphrase, salt) {
  // Node 默认 maxmem 是 32MB，N=2^15/r=8 约需 32MB+，不显式抬会报 memory limit exceeded
  return scryptSync(String(passphrase), salt, SCRYPT.len, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * 1024 * 1024,
  })
}

/**
 * 导出单文件包。
 *
 * @param {string} dir 记忆库
 * @param {{outFile?:string, key?:string, now?:Date}} [opts]
 * @returns {{file:string, bytes:number, files:number, encrypted:boolean, digest:string}}
 */
export function exportFmb(dir, { outFile = null, key = null, now = new Date() } = {}) {
  if (!existsSync(dir)) throw new Error(`库不存在：${dir}`)
  const files = collectFiles(dir)
  if (!files.length) throw new Error('这个库是空的，没有可导出的东西')

  const payloadFiles = files
  const tar = tarPack(payloadFiles.map((f) => ({ name: f.name, data: f.data, mtime: f.mtime })))
  const gz = gzipSync(tar, { level: 9 })

  const encrypted = Boolean(key)
  let payload = gz
  let head = {
    v: 1,
    enc: null,
    created_at: now.toISOString(),
    library: {
      // 只记"库里有什么"，**不记绝对路径**（这份文件要出门）
      points: payloadFiles.filter((f) => f.name.startsWith('30_points/')).length,
      calls: payloadFiles.length,
    },
    files: payloadFiles.length,
    bytes: gz.length,
    sha256: sha256(gz),
    listing: payloadFiles.slice(0, 200).map((f) => ({ name: f.name, size: f.data.length })),
  }
  if (encrypted) {
    const salt = randomBytes(SALT_BYTES)
    const iv = randomBytes(IV_BYTES)
    const k = deriveKey(key, salt)
    const cipher = createCipheriv('aes-256-gcm', k, iv)
    const body = Buffer.concat([cipher.update(gz), cipher.final()])
    payload = Buffer.concat([body, cipher.getAuthTag()])
    head = { ...head, enc: 'aes-256-gcm', scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, salt: salt.toString('base64'), iv: iv.toString('base64'), bytes: payload.length }
  }

  const headBuf = Buffer.from(`${JSON.stringify(head)}\n`, 'utf8')
  const file = Buffer.concat([Buffer.from(MAGIC, 'ascii'), headBuf, payload])
  const target = outFile || join(dir, '..', `fish-memory-${now.toISOString().slice(0, 10).replace(/-/g, '')}${FMB_EXT}`)

  // 先写 .partial 再 rename：同步盘只会看见一个写完的文件
  const partial = `${target}.partial-${process.pid}`
  writeFileSync(partial, file)
  renameSync(partial, target)
  if (existsSync(partial)) unlinkSync(partial)

  return { file: target, bytes: file.length, files: payloadFiles.length, encrypted, digest: sha256(file) }
}

/** 读头（不解密） */
export function readFmbHeader(file) {
  const buf = readFileSync(file)
  if (buf.length < MAGIC.length + 2) throw new Error('不是备份包：文件太短')
  if (buf.toString('ascii', 0, MAGIC.length) !== MAGIC) throw new Error('不是备份包：魔数不对')
  const nl = buf.indexOf(0x0a, MAGIC.length)
  if (nl < 0) throw new Error('不是备份包：头部没有结束符')
  const head = JSON.parse(buf.toString('utf8', MAGIC.length, nl))
  return { head, payload: buf.subarray(nl + 1) }
}

/**
 * 解包（需要口令时必须给）。
 * @returns {{files:{name:string,data:Buffer}[], head:object}}
 */
export function readFmb(file, { key = null } = {}) {
  const { head, payload } = readFmbHeader(file)
  let gz
  if (head.enc === 'aes-256-gcm') {
    if (!key) throw new Error('这是加密包，需要口令（--key-file 或 FISH_MEMORY_BACKUP_PASSPHRASE）')
    const salt = Buffer.from(head.salt, 'base64')
    const iv = Buffer.from(head.iv, 'base64')
    const tag = payload.subarray(payload.length - 16)
    const body = payload.subarray(0, payload.length - 16)
    const k = deriveKey(key, salt)
    const decipher = createDecipheriv('aes-256-gcm', k, iv)
    decipher.setAuthTag(tag)
    try {
      gz = Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      // 认证失败要说人话：不是"JSON 解析错误"，是口令不对或者包被改过
      throw new Error('认证失败：口令不对，或这个包被改动过（GCM 校验没通过）')
    }
  } else {
    gz = payload
  }
  if (head.sha256 && sha256(gz) !== head.sha256) throw new Error('包内容与头部记录不符（可能是传到一半的文件）')

  let tar
  try {
    tar = gunzipSync(gz)
  } catch {
    throw new Error('解压失败：这个包不是完整的 gzip（网盘截断的典型表现）')
  }
  const files = tarUnpack(tar)
  if (!files.length) throw new Error('包里没有文件')
  return { files, head }
}

/**
 * 干跑校验：能解开、能 untar、**链是连的**。
 *
 * @param {string} file
 * @param {{key?:string, dir?:string}} [opts] dir 给了就把文件摊到临时目录再验链
 */
export function verifyFmb(file, { key = null, checkChain = null } = {}) {
  // v0.67.0 修：这里忘了把 key 传下去，于是加密包永远报「需要口令」
  const { files, head } = readFmb(file, { key })
  const names = new Set(files.map((f) => f.name))
  for (const need of ['00_core', '10_archive', '30_points']) {
    if (![...names].some((n) => n.startsWith(`${need}/`))) throw new Error(`包里缺 ${need}/（不像一个完整的记忆库）`)
  }
  const chain = typeof checkChain === 'function' ? checkChain(files) : null
  return { ok: true, head, files: files.length, bytes: readFileSync(file).length, chain }
}

/** 只删自己命名的包；保留最近 keep 天 + 每月 1 号留 monthly 份 */
export function pruneFmb(dir, { keep = 7, monthly = 6, now = new Date(), dry = false } = {}) {
  if (!existsSync(dir)) return { removed: [], kept: [] }
  const mine = readdirSync(dir)
    .filter((f) => /^fish-memory-\d{8}\.fmb$/.test(f))
    .sort()
  if (!mine.length) return { removed: [], kept: [] }

  const days = mine.map((f) => ({ file: f, day: f.match(/(\d{8})/)[1] }))
  const keepSet = new Set()
  // 最近 keep 天
  for (const d of days.slice(-keep)) keepSet.add(d.file)
  // 每月 1 号留 monthly 份
  const firstOfMonth = days.filter((d) => d.day.endsWith('01')).slice(-monthly)
  for (const d of firstOfMonth) keepSet.add(d.file)

  const removed = []
  for (const d of days) {
    if (keepSet.has(d.file)) continue
    const abs = join(dir, d.file)
    if (dirname(abs) !== dir) continue // 只在这个目录里动手
    if (!dry) unlinkSync(abs)
    removed.push(d.file)
  }
  return { removed, kept: [...keepSet].sort() }
}
