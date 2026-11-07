// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * tar.js — 最小 ustar 读写（v0.67.0 起；v0.74.0 支持长文件名）。
 *
 * 为什么自己写：Node 没有内置 zip，但有 `zlib`。ustar 头 512 字节，够用。
 * 为什么是 tar 不是自造格式：**出事时用户拿 7-Zip 能直接打开**，不必依赖这个插件——
 * 对"备份"是硬要求。
 *
 * **A11（v0.74.0）**：头里的名字字段只有 100 字节。以前超了直接 `slice(0,100)`——
 * 中文名 33 个字就到 99 字节（UTF-8 三字节一个），再多就**静默截断**，而且截断处
 * 可能切在多字节字符中间。备份里丢文件名，和丢文件同罪。
 * 现在按 POSIX 的做法拆两段：name ≤100 字节 + prefix ≤155 字节（合计 255，中文约 85 字）；
 * 拆不下就**报错**，不静默改名。
 *
 * 只支持：普通文件（typeflag '0'）、无 PAX 扩展、无符号链接。
 */

const BLOCK = 512
const NAME_MAX = 100
const PREFIX_MAX = 155
const PREFIX_OFFSET = 345 // ustar 头里 prefix 字段的位置

function writeOctal(buf, offset, length, value) {
  const s = Math.max(0, Math.floor(Number(value) || 0)).toString(8).padStart(length - 1, '0')
  buf.write(s.slice(-(length - 1)), offset, 'ascii')
  buf[offset + length - 1] = 0
}

function readOctal(buf, offset, length) {
  const s = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) : 0
}

const nbytes = (s) => Buffer.byteLength(s, 'utf8')

/**
 * 把路径拆成 ustar 的 name / prefix 两段（A11）。
 * 拆不下就抛错——**宁可失败，也不要静默改名**。
 */
export function splitName(path) {
  const p = String(path || '').replace(/\\/g, '/')
  if (nbytes(p) <= NAME_MAX) return { name: p, prefix: '' }
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const prefix = p.slice(0, i)
    const name = p.slice(i + 1)
    if (nbytes(name) <= NAME_MAX && nbytes(prefix) <= PREFIX_MAX) return { name, prefix }
  }
  throw new Error(
    `文件名太长（ustar 上限 255 字节）：${p.slice(0, 40)}…（${nbytes(p)} 字节）。缩短目录层级或文件名。`,
  )
}

/** 单个文件的 512 字节头 */
function header(name, size, mtime) {
  const { name: short, prefix } = splitName(name)
  const buf = Buffer.alloc(BLOCK, 0)
  buf.write(short, 0, 'utf8')
  writeOctal(buf, 100, 8, 0o644)
  writeOctal(buf, 108, 8, 0)
  writeOctal(buf, 116, 8, 0)
  writeOctal(buf, 124, 12, size)
  writeOctal(buf, 136, 12, Math.floor((mtime || Date.now()) / 1000))
  buf.write('        ', 148, 'ascii') // checksum 先按空格算
  buf.write('0', 156, 'ascii') // typeflag: 普通文件
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
  if (prefix) buf.write(prefix, PREFIX_OFFSET, 'utf8')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return buf
}

/**
 * 打成一个 tar buffer。
 * @param {{name:string, data:Buffer, mtime?:number}[]} files
 */
export function tarPack(files) {
  const parts = []
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    parts.push(header(f.name, data.length, f.mtime))
    parts.push(data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad, 0))
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)) // 两块 0 = 结束
  return Buffer.concat(parts)
}

/**
 * 解开一个 tar buffer。
 * @returns {{name:string, data:Buffer}[]}
 */
export function tarUnpack(buf) {
  const out = []
  let off = 0
  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK)
    // 全 0 = 结束
    if (head.every((b) => b === 0)) break
    const short = head.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = head.toString('utf8', PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_MAX).replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${short}` : short
    const size = readOctal(head, 124, 12)
    const type = head.toString('ascii', 156, 157)
    off += BLOCK
    if (type === '0' || type === '\0' || type === '') {
      if (!name) throw new Error('tar 头里没有文件名')
      if (size < 0 || off + size > buf.length) throw new Error(`tar 被截断：${name} 需要 ${size} 字节`)
      out.push({ name, data: buf.subarray(off, off + size) })
    }
    off += Math.ceil(size / BLOCK) * BLOCK
  }
  return out
}
