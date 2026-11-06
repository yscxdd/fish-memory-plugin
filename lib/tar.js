// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * tar.js — 最小 ustar 读写（v0.67.0，零依赖）。
 *
 * 为什么自己写：Node 没有内置 zip，但有 `zlib`。ustar 头 512 字节，够用。
 * 为什么是 tar 不是自造格式：**出事时用户拿 7-Zip 能直接打开**，不必依赖这个插件——
 * 对"备份"是硬要求。
 *
 * 只支持：普通文件（typeflag '0'）、ASCII 路径、无 PAX 扩展、无符号链接。
 * 这个库的路径全是 `00_core/soul.md` 这种形状，够用。
 */

const BLOCK = 512

function writeOctal(buf, offset, length, value) {
  const s = Math.max(0, Math.floor(Number(value) || 0)).toString(8).padStart(length - 1, '0')
  buf.write(s.slice(-(length - 1)), offset, 'ascii')
  buf[offset + length - 1] = 0
}

function readOctal(buf, offset, length) {
  const s = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) : 0
}

/** 单个文件的 512 字节头 */
function header(name, size, mtime) {
  const buf = Buffer.alloc(BLOCK, 0)
  buf.write(name.slice(0, 100), 0, 'utf8')
  writeOctal(buf, 100, 8, 0o644)
  writeOctal(buf, 108, 8, 0)
  writeOctal(buf, 116, 8, 0)
  writeOctal(buf, 124, 12, size)
  writeOctal(buf, 136, 12, Math.floor((mtime || Date.now()) / 1000))
  buf.write('        ', 148, 'ascii') // checksum 先按空格算
  buf.write('0', 156, 'ascii') // typeflag: 普通文件
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
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
    const name = head.toString('utf8', 0, 100).replace(/\0.*$/, '')
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
