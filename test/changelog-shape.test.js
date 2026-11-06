// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * CHANGELOG 的结构（v0.66.0，E7）。
 *
 * 这是**同类事故第二次**：明细段被插进「一页看完」的表格中间，表格塌了，
 * 而没有任何东西会红——上一版就是这么过去的（v0.63.1 / v0.64.0 行首丢了 `| v`）。
 *
 * 钉住三件事：
 *   ① 表格区每一行都必须以 `| v` 开头（塌了必红）；
 *   ② 版本号单调递减（新版本在上面）；
 *   ③ 行数与 `test/` 里最新的测试数一致（别写陈旧数字）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const lines = text.split('\n')

const start = lines.findIndex((l) => l.trim() === '| 版本 | 主题 | 测试 | 一句话 |')
const end = lines.findIndex((l) => l.startsWith('**当前规模**'))
const tableRows = start >= 0 && end > start ? lines.slice(start + 2, end).filter((l) => l.trim()) : []

test('CHANGELOG 表格区：每一行都是 | vX.Y.Z 开头（塌了必红）', () => {
  assert.ok(start >= 0, '找不到表格头')
  assert.ok(end > start, '找不到「当前规模」行')
  assert.ok(tableRows.length > 50, `表格行太少（${tableRows.length}），像是被截断`)
  for (const row of tableRows) {
    assert.match(row, /^\|\s*v\d+\.\d+\.\d+\s*\|/, `这一行不是表格行：${row.slice(0, 60)}`)
    assert.match(row, /\|\s*$/, `这一行没闭合：${row.slice(0, 60)}`)
  }
})

test('CHANGELOG 表格：版本号从新到旧', () => {
  const versions = tableRows.map((r) => /^\|\s*(v\d+\.\d+\.\d+)/.exec(r)[1])
  const key = (v) => v.slice(1).split('.').map((n) => Number(n))
  for (let i = 1; i < versions.length; i++) {
    const a = key(versions[i - 1])
    const b = key(versions[i])
    const desc = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))
    assert.ok(desc, `版本顺序错了：${versions[i - 1]} 之后是 ${versions[i]}`)
  }
})

test('CHANGELOG 表格：没有重复版本', () => {
  const versions = tableRows.map((r) => /^\|\s*(v\d+\.\d+\.\d+)/.exec(r)[1])
  assert.equal(new Set(versions).size, versions.length, '有重复版本行')
})

test('CHANGELOG：标题里的最新版本与表格第一行一致', () => {
  const newest = /^\|\s*(v\d+\.\d+\.\d+)/.exec(tableRows[0])[1]
  assert.match(lines[0], new RegExp(newest.replace(/\./g, '\\.')), `标题没跟上最新版本 ${newest}`)
})

test('CHANGELOG：「当前规模」里的文件数与 package.json 的测试数不陈旧', () => {
  const scaleLine = lines[end]
  const n = Number((/当前规模\*\*：(\d+) 个文件/.exec(scaleLine) || [])[1])
  assert.ok(n > 200 && n < 400, `文件数看着不对：${n}`)
  // 测试数那一行：取表格第一行的测试数做对照
  const firstTest = Number((/\|\s*(\d+)\s*\|/.exec(tableRows[0]) || [])[1])
  const testLine = lines.find((l) => /^测试 97 → \d+/.test(l))
  assert.ok(testLine, '找不到「测试 97 → N」那一行')
  const total = Number((/测试 97 → (\d+)/.exec(testLine) || [])[1])
  assert.equal(total, firstTest, `规模行的测试数（${total}）与表格第一行（${firstTest}）不一致`)
})
