// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * Everything 加速器（v0.43.0）。
 *
 * 为什么要它：我们的 JSON 索引只扫登记目录、要手动重建；Everything 走 MFT+USN，全盘、毫秒级。
 *
 * 钉住：
 *   ① 编码：**管道里是 GBK**（不是 UTF-8），重定向到文件才是 UTF-16LE+BOM——两种都要能解；
 *   ② FILETIME → 毫秒（es.exe 的 `date_modified` 是 100ns 起 1601）；
 *   ③ **结果必须过滤到登记工作区**（安全闸，不是优化）；
 *   ④ 探测顺序：env → config → 注册表安装目录 → PATH；
 *   ⑤ 拿不到就返回 ok:false，**绝不抛**（回落本地索引）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FILETIME_EPOCH_MS,
  detect,
  everythingStatus,
  filetimeToMs,
  findWithEverything,
  normalizeRow,
  parseOutput,
  saveConfig,
  searchRaw,
} from '../lib/everything.js'
import { addWorkspace } from '../lib/workspaces.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'fishmem-es-'))
  const lib = join(base, 'lib')
  const work = join(base, 'work')
  mkdirSync(join(lib, '20_state'), { recursive: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, '报表.md'), '# 报表\n', 'utf8')
  return { base, lib, work }
}

/** 造一段"GBK 管道输出"：ASCII 部分 + 原始 GBK 字节（"报表" = B1A8 B1ED） */
function gbkJson(filenameAsciiPrefix, gbkBytes, suffix) {
  return Buffer.concat([
    Buffer.from(`[{"size":123,"date_modified":134378542160000000,"filename":"`, 'utf8'),
    Buffer.from(filenameAsciiPrefix, 'utf8'),
    Buffer.from(gbkBytes),
    Buffer.from(`${suffix}"}]`, 'utf8'),
  ])
}

test('编码：GBK 管道输出能解出正确中文', () => {
  // 真实 es.exe 输出里反斜杠是 JSON 转义过的（文本里两个反斜杠）
  const buf = gbkJson('C:\\\\w\\\\', [0xb1, 0xa8, 0xb1, 0xed], '.md')
  const rows = parseOutput(buf)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].n, '报表.md')
  assert.equal(rows[0].s, 123)
})

test('编码：UTF-16LE + BOM 也能解（重定向到文件的情况）', () => {
  const body = JSON.stringify([{ filename: 'D:\\工作\\报表.md', size: 9, date_modified: 134378542160000000 }])
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])
  const rows = parseOutput(buf)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].n, '报表.md')
})

test('UTF-8（无 BOM）优先按 UTF-8 解，不会误判成 GBK', () => {
  const buf = Buffer.from(JSON.stringify([{ filename: 'D:\\a\\报表.md', size: 1 }]), 'utf8')
  assert.equal(parseOutput(buf)[0].n, '报表.md')
})

test('空输出 / 坏 JSON → 空数组，不抛', () => {
  assert.deepEqual(parseOutput(Buffer.alloc(0)), [])
  assert.deepEqual(parseOutput(Buffer.from('not json', 'utf8')), [])
})

test('FILETIME → 毫秒', () => {
  const ms = filetimeToMs(134378542160000000)
  assert.equal(ms, 134378542160000000 / 10000 - FILETIME_EPOCH_MS)
  assert.equal(new Date(ms).getUTCFullYear(), 2026)
  assert.equal(filetimeToMs(0), null)
  assert.equal(filetimeToMs('x'), null)
})

test('normalizeRow：缺字段也不炸，路径里取文件名', () => {
  const r = normalizeRow({ filename: 'D:\\a\\b\\c.txt', size: '12' })
  assert.equal(r.n, 'c.txt')
  assert.equal(r.s, 12)
  assert.equal(normalizeRow({}), null)
})

test('探测：env → config → 注册表 → PATH', () => {
  const { lib } = fixture()
  const fakeRun = (cmd, args) => {
    if (cmd === 'reg') return { status: 0, stdout: '    InstallLocation    REG_SZ    C:\\fake\\Everything\r\n' }
    if (cmd === 'where') return { status: 1, stdout: '' }
    return { status: 1, stdout: '' }
  }
  // 注册表里的目录不存在 → 不算可用
  const d1 = detect(lib, { run: fakeRun, env: {} })
  assert.equal(d1.available, false)
  assert.equal(d1.source, 'none')
  assert.equal(typeof d1.reason, 'string')
})

test('按配置找工作区内的文件；工作区外的被过滤掉（安全闸）', () => {
  const { lib, work, base } = fixture()
  addWorkspace(lib, work)
  // 假 es.exe：返回两条，一条在工作区内、一条在工作区外
  const fakeRun = (cmd, args) => {
    if (cmd !== 'es') return { status: 1, stdout: Buffer.alloc(0) }
    const rows = [
      { filename: join(work, '报表.md'), size: 10, date_modified: 134378542160000000 },
      { filename: join(base, 'outside-secret.md'), size: 20, date_modified: 134378542160000000 },
    ]
    return { status: 0, stdout: Buffer.from(JSON.stringify(rows), 'utf8') }
  }
  const r = findWithEverything(lib, '报表', { esPath: 'es', run: fakeRun })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'everything')
  assert.equal(r.hits.length, 1, '只留工作区内那条')
  assert.equal(r.dropped, 1, '工作区外那条要被记成 dropped')
})

test('拿不到 es.exe → ok:false，带理由（调用方回落本地索引）', () => {
  const { lib } = fixture()
  const r = findWithEverything(lib, 'x', { run: () => ({ status: 1, stdout: '' }), env: {} })
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'unavailable')
  assert.match(r.reason, /es\.exe/)
})

test('es.exe 报错 → ok:false，不抛', () => {
  const { lib } = fixture()
  const r = searchRaw('x', { esPath: 'es', run: () => ({ status: 2, stdout: Buffer.alloc(0) }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /退出码/)
})

test('status：enabled/available/source 都能读；saveConfig 能记住路径', () => {
  const { lib } = fixture()
  saveConfig(lib, { esPath: 'D:\\x\\es.exe', enabled: false })
  const st = everythingStatus(lib, { run: () => ({ status: 1, stdout: '' }) })
  assert.equal(st.enabled, false)
  assert.equal(st.available, false)
})
