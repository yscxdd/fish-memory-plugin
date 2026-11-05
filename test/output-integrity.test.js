// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 输出完整性（v0.60.0）——"顺手发现"的护栏。
 *
 * 起因：别人那份 bug 清单第 4 条是「`process.exit()` 截断管道输出」。
 * 我们有 49 处 `process.exit(`、只有 6 处 `process.exitCode`，所以实测了一遍：
 * `gold --json` / `gold --set hard --json` 走管道都**完整**（2559 / 2757 字节，JSON 能解析）。
 *
 * 结论：**当前不重现**。但这是一个"哪天输出变大就会咬人"的坑，
 * 所以用测试把它钉住——而不是做一次 49 处的盲目重构（那会引入更大的风险）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const runPiped = (args) => spawnSync(process.execPath, ['scripts/memory.mjs', ...args], { cwd: ROOT, encoding: 'utf8' })

test('gold --json 走管道不截断（输出必须是完整 JSON）', () => {
  const r = runPiped(['gold', '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotThrow(() => JSON.parse(r.stdout), '输出被截断或混了别的东西')
})

test('gold --set hard --json 走管道同样完整', () => {
  const r = runPiped(['gold', '--set', 'hard', '--json'])
  assert.doesNotThrow(() => JSON.parse(r.stdout), r.stdout.slice(-120))
})

test('merge-check --json 走管道同样完整', () => {
  const r = runPiped(['merge-check', join(ROOT, 'no-such-dir'), '--json'])
  // 路径不存在时它抛错（退出非 0），但只要出得来，就不该是半截 JSON
  if (r.stdout.trim()) assert.doesNotThrow(() => JSON.parse(r.stdout), r.stdout.slice(-120))
})
