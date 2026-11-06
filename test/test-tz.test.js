// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 三时区测试跑的解析器（v0.52.2）。
 *
 * 为什么单测这个：`tz-check.mjs` 自己要是把"3 条新失败"读成"0 条"，
 * 那它比没有更糟——它会给出虚假的绿。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KNOWN, ZONES, parseTestOutput } from '../scripts/tz-check.mjs'

const SAMPLE = `
ℹ tests 645
ℹ pass 642
ℹ fail 3
ℹ skipped 0
✖ startRun：同一天第二次自动加序号，latestRun 指对 (6.64ms)
✖ #1 档案只追加：换掉一行的正文，链校验必须失败 (22.3ms)
`

test('数得出 tests/pass/fail', () => {
  const r = parseTestOutput(SAMPLE)
  assert.equal(r.tests, 645)
  assert.equal(r.pass, 642)
  assert.equal(r.fail, 3)
})

test('抓得到失败用例名（去掉耗时；重复行去重）', () => {
  const dup = SAMPLE + '✖ startRun：同一天第二次自动加序号，latestRun 指对 (6.64ms)\n'
  const r = parseTestOutput(dup)
  assert.equal(r.failed.length, 2)
  assert.ok(r.failed[0].startsWith('startRun：'))
  assert.ok(!r.failed[0].includes('ms'), '不该带耗时')
})

test('三个时区都覆盖；已知债按"时区"分开记', () => {
  assert.deepEqual(ZONES, ['UTC', 'Asia/Shanghai', 'America/New_York'])
  assert.ok(Array.isArray(KNOWN['America/New_York']), 'KNOWN 的每一项都必须是数组（可以是空）')
  assert.equal((KNOWN['UTC'] || []).length, 0, 'UTC 不该有已知债')
  assert.equal(KNOWN['America/New_York'].length, 0, 'v0.53.0 起纽约也没有已知债了')
})
