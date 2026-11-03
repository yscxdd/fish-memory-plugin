// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 篡改告警（v0.41.0，① 组）。
 *
 * 我们的处境和 digital-life-core 不同：它有 pre-tool hook 能**当场拦**；
 * 我们（DSH 插件）只有 `tools.register`，**拦不住**她跑 shell 改文件。
 *
 * 所以只能做诚实的另一半：**发现**。
 * 钉住：
 *   ① 每个受保护文件取 size + mtime + sha8；
 *   ② 内容变了 → changed，新文件 → added，没了 → removed；
 *   ③ 变化写 tamper.log（一行一条，含改了哪几个）；
 *   ④ 我们自己的合法写入之后能 refresh 基线（不刷就会误报）；
 *   ⑤ 只覆盖 00_core 的六个文件，不追踪 core_changelog（它是我们合法写的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TAMPER_LOG,
  TRACKED_CORE,
  checkTamper,
  lastTamperAt,
  loadFingerprint,
  recentTamper,
  refreshFingerprint,
  scanCore,
} from '../lib/tamper.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-tamper-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '50_log'), { recursive: true })
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我是谁\n', 'utf8')
  writeFileSync(join(dir, '00_core/user.md'), '# USER\n', 'utf8')
  return dir
}

test('扫描：只扫受保护的六个文件，各带 size/mtime/sha', () => {
  const dir = fixture()
  writeFileSync(join(dir, '00_core/core_changelog.md'), '不该被追踪\n', 'utf8')
  const s = scanCore(dir)
  assert.deepEqual(Object.keys(s).sort(), ['soul.md', 'user.md'])
  assert.equal(typeof s['soul.md'].size, 'number')
  assert.equal(typeof s['soul.md'].sha, 'string')
  assert.equal(TRACKED_CORE.includes('core_changelog.md'), false)
})

test('没动 → 什么都不报', () => {
  const dir = fixture()
  refreshFingerprint(dir)
  const r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.changed, [])
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
})

test('偷偷改了 soul → changed 里有它，并写日志', () => {
  const dir = fixture()
  refreshFingerprint(dir)
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 我是谁\n- 偷偷加的一行\n', 'utf8')
  const r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.changed, ['soul.md'])
  assert.equal(existsSync(join(dir, TAMPER_LOG)), true)
  const row = JSON.parse(readFileSync(join(dir, TAMPER_LOG), 'utf8').trim().split('\n').pop())
  assert.deepEqual(row.changed, ['soul.md'])
  assert.equal(row.at, NOW.toISOString())
})

test('新加/删掉核心文件也能报', () => {
  const dir = fixture()
  refreshFingerprint(dir)
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调\n', 'utf8')
  let r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.added, ['voice.md'])

  refreshFingerprint(dir)
  writeFileSync(join(dir, '00_core/voice.md'), '# 腔调（改过）\n', 'utf8')
  r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.changed, ['voice.md'])
})

test('refresh：我们自己的合法写入之后刷基线，就不再误报', () => {
  const dir = fixture()
  refreshFingerprint(dir)
  // 模拟我们自己的 soul apply
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n- 新版\n', 'utf8')
  refreshFingerprint(dir)
  const r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.changed, [], '刷过基线就不该再报')
})

test('没有基线时第一次检查不报（免得新库一上就告警）', () => {
  const dir = fixture()
  const r = checkTamper(dir, { now: NOW })
  assert.deepEqual(r.changed, [])
  assert.ok(loadFingerprint(dir), '第一次会顺手建立基线')
})

test('lastTamperAt / recentTamper：能查到最近一次告警', () => {
  const dir = fixture()
  refreshFingerprint(dir)
  writeFileSync(join(dir, '00_core/user.md'), '# USER\n- 加了一句\n', 'utf8')
  checkTamper(dir, { now: NOW })
  assert.equal(lastTamperAt(dir), NOW.toISOString())
  assert.equal(recentTamper(dir, 3).length, 1)
})
