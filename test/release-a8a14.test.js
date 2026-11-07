// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 交付与工程债 A8 / A10 / A11 / A12 / A13 / A14（v0.74.0）。
 *
 * 这六条都不影响"她记不记得住"，影响的是"这东西像个正经东西吗"：
 *   A8  zip 里中文名乱码 + 反斜杠路径
 *   A10 死代码 checkPayload（哈希口径永远对不上，留着会误导人）
 *   A11 tar 头 100 字节硬截断（中文名 >33 字被静默改名）
 *   A12 日志不轮转（ability.log 还能被 HTTP 无限追加）
 *   A13 契约没进包 → docs.test.js 每次发布 skip 三条断言
 *   A14 detect() 无条件 spawn reg.exe
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitName, tarPack, tarUnpack } from '../lib/tar.js'
import { rotateLog } from '../lib/util.js'
import { writeZip } from '../lib/zip.js'

const SRC = (rel) => new URL(`../${rel}`, import.meta.url)

// ── A11 ────────────────────────────────────────────────────────
test('A11：>100 字节的中文名走 prefix 分支，往返后一字不差', () => {
  const p = '10_archive/messages/很长的目录名字很长的目录名字很长的目录名字/这一年的对话记录节选与备份说明.md'
  assert.ok(Buffer.byteLength(p, 'utf8') > 100, '这条要真的超过 100 字节才有意义')
  const s = splitName(p)
  assert.ok(Buffer.byteLength(s.prefix, 'utf8') <= 155)
  assert.ok(Buffer.byteLength(s.name, 'utf8') <= 100)
  const back = tarUnpack(tarPack([{ name: p, data: Buffer.from('ok') }]))
  assert.equal(back[0].name, p, '名字不许被静默截断')
})

test('A11：真的放不下时要报错，不许静默改名', () => {
  const tooLong = `a/${'很长的目录名'.repeat(30)}/x.md`
  assert.throws(() => splitName(tooLong), /文件名太长/)
})

test('A11：普通短名仍然直接放 name 字段', () => {
  const s = splitName('00_core/soul.md')
  assert.equal(s.prefix, '')
  assert.equal(s.name, '00_core/soul.md')
})

// ── A12 ────────────────────────────────────────────────────────
test('A12：日志超过阈值就轮转，旧的进 .1/.2/.3，最多留 keep 份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-log-'))
  const f = join(dir, 'ability.log')
  writeFileSync(f, 'x'.repeat(200), 'utf8')

  assert.equal(rotateLog(f, { maxBytes: 100, keep: 2 }), true, '超过 100 字节要轮转')
  assert.equal(existsSync(`${f}.1`), true)
  assert.equal(existsSync(f), false, '轮转后原文件被挪走')

  writeFileSync(f, 'y'.repeat(200), 'utf8')
  rotateLog(f, { maxBytes: 100, keep: 2 })
  assert.equal(existsSync(`${f}.1`), true)
  assert.equal(existsSync(`${f}.2`), true)
  // .2 里的应该是第一次那份（x）
  assert.match(readFileSync(`${f}.2`, 'utf8'), /^x/)

  writeFileSync(f, 'z'.repeat(200), 'utf8')
  rotateLog(f, { maxBytes: 100, keep: 2 })
  const files = readdirSync(dir).sort()
  assert.ok(files.length <= 3, `最多 keep+1 个文件，实际：${files.join(',')}`)
})

test('A12：没到阈值不动文件（每次追加都扫是浪费）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-log2-'))
  const f = join(dir, 'small.log')
  writeFileSync(f, 'a'.repeat(10), 'utf8')
  assert.equal(rotateLog(f, { maxBytes: 1000 }), false)
  assert.equal(readdirSync(dir).length, 1)
})

// ── A10 ────────────────────────────────────────────────────────
test('A10：死代码 checkPayload 已经删掉了', () => {
  const src = readFileSync(SRC('lib/restore.js'), 'utf8')
  assert.ok(!src.includes('checkPayload'), '它算的是"文件内容拼接"的哈希，和头部的 gzip 哈希口径永远对不上')
})

// ── A13 ────────────────────────────────────────────────────────
test('A13：契约随插件发布（docs.test.js 不再 skip）', () => {
  const contract = SRC('docs/CONTRACT-v1.0-plugin-interface.md')
  assert.ok(existsSync(contract), '契约必须在仓库里，否则那三条断言永远测不到')
  const t = readFileSync(contract, 'utf8')
  assert.match(t, /7\.5\.1 人格修订提案/)
  assert.match(t, /pin: hard/)
  assert.match(t, /asset:<kind>:<id>/)
})

test('A13：契约里不许残留个人盘符路径', () => {
  const t = readFileSync(SRC('docs/CONTRACT-v1.0-plugin-interface.md'), 'utf8')
  assert.ok(!/[CD]:\\Users/i.test(t), '契约要出门，不该带用户名路径')
})

// ── A14 ────────────────────────────────────────────────────────
test('A14：FISH_MEMORY_EVERYTHING_NO_SPAWN=1 时一个外部进程都不起', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-es-'))
  const key = 'FISH_MEMORY_EVERYTHING_NO_SPAWN'
  const old = process.env[key]
  process.env[key] = '1'
  try {
    // 模块在 import 时读环境变量，所以要重新载入一份
    const mod = await import(`../lib/everything.js?no-spawn=${Date.now()}`)
    let spawned = false
    const r = mod.detect(dir, {
      run: () => {
        spawned = true
        throw new Error('不该起进程')
      },
      env: {},
    })
    assert.equal(spawned, false, 'reg.exe / where 都不许起')
    assert.equal(r.available, false)
    assert.match(String(r.reason || ''), /禁用/)
  } finally {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  }
})

// ── A8 ─────────────────────────────────────────────────────────
test('A8：zip 里文件名用 / 分隔，且带 UTF-8 标志位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-zip-'))
  const out = join(dir, 't.zip')
  writeZip(
    [
      { name: 'docs\\发布到GitHub.md', data: '反斜杠会被换成斜杠' },
      { name: 'lib/zip.js', data: 'x' },
    ],
    out,
  )
  const buf = readFileSync(out)
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '本地文件头签名')
  const flags = buf.readUInt16LE(6)
  assert.ok(flags & 0x0800, '通用标志位第 11 位（UTF-8）必须置上，否则解压成乱码')
  const nameLen = buf.readUInt16LE(26)
  const name = buf.toString('utf8', 30, 30 + nameLen)
  assert.ok(!name.includes('\\'), `zip 里不许出现反斜杠：${name}`)
  assert.equal(name, 'docs/发布到GitHub.md')
})

test('A8：zip 的中央目录条目数对得上，且能被正确解压', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-zip2-'))
  const out = join(dir, 't.zip')
  const files = [
    { name: 'a.txt', data: 'hello' },
    { name: '很深/的目录/名字.md', data: 'x'.repeat(100) },
    { name: 'empty.txt', data: '' },
  ]
  const r = writeZip(files, out)
  assert.equal(r.files, 3)
  assert.ok(r.bytes > 0)
  assert.ok(statSync(out).size === r.bytes)
  // 中央目录：从末尾 EOCD 往前找
  const buf = readFileSync(out)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd > 0, '要有 EOCD')
  assert.equal(buf.readUInt16LE(eocd + 10), 3, '中央目录里的条目数')
})

test('A8：发布脚本存在，且用我们自己的 zip 写入器（不用 Compress-Archive）', () => {
  const src = readFileSync(SRC('scripts/release-zip.mjs'), 'utf8')
  assert.match(src, /writeZip/)
  assert.ok(!/shell\.exec|powershell|execFileSync/.test(src), '不许再调 PowerShell 打包')
  assert.ok(existsSync(SRC('lib/zip.js')))
  mkdirSync(tmpdir(), { recursive: true })
})
