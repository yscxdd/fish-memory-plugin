// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * zip.js — 最小 ZIP 写盘（v0.74.0，零依赖；A8）。
 *
 * 为什么自己写：发布包以前用 PowerShell 的 `Compress-Archive`，
 * 它出来的 zip 有两个毛病：
 *   ① 路径用反斜杠（`docs\发布到GitHub.md`）——`unzip` 直接告警，Linux 上解出来是一个怪文件；
 *   ② 中文名不带 UTF-8 标志位，解压成 `ÕÅæ...md`。
 *
 * 这两个都不是"小瑕疵"：**发布包是别人第一次接触这个项目的东西。**
 *
 * 现在自己写：文件名统一 `/`，通用标志位第 11 位（UTF-8）置上，deflate 用 `node:zlib`。
 * 验证方式也很硬：`tar -tf`（bsdtar 能读 zip）和 Windows 资源管理器都能打开。
 */

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800 // 通用标志位第 11 位：文件名是 UTF-8

// ── CRC32（ZIP 必需，zlib 不直接给）──────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间（zip 里用的是本地时间，精度 2 秒） */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 写一个 zip。
 *
 * @param {{name:string, data:Buffer|string}[]} files  name 用 `/`（反斜杠会被自动换掉）
 * @param {string} outFile
 * @returns {{bytes:number, files:number, digest:string}}
 */
const MAX_ENTRIES = 0xffff // 条目数字段是 16 位：超过会静默回绕，产出坏包

export function writeZip(files, outFile) {
  // 评审 v0.80.1 次要项：以前条目数超过 65535 会**静默回绕**，写出一个坏 zip 却没有任何报错。
  if (files.length > MAX_ENTRIES) {
    throw new Error(`zip 条目数超过上限（${files.length} > ${MAX_ENTRIES}）：改用分卷或排除大目录`)
  }
  const locals = []
  const centrals = []
  let offset = 0
  const now = new Date()
  const { time, date } = dosTime(now)

  for (const f of files) {
    const name = String(f.name).replace(/\\/g, '/')
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const deflated = deflateRawSync(raw, { level: 9 })
    // 压不小的就存原文（zip 允许同包混用）
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // 需要的版本 2.0
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // 生成方版本
    central.writeUInt16LE(20, 6) // 需要的版本
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // 磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头偏移
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  const out = Buffer.concat([...locals, centralBuf, eocd])
  writeFileSync(outFile, out)
  return {
    bytes: out.length,
    files: files.length,
    digest: createHash('sha256').update(out).digest('hex'),
  }
}

