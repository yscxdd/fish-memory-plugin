// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 体检脚本（v0.86.0）。
 *
 * 这些用例钉的是**"插件没加载"能被查出来**——那是最可能的失败形态：
 * 对话照常、她什么都不记得、没有任何报错。
 * 所以每条都从"故意的坏现场"开始：缺声明 / junction 断 / 库空 / 备份过期。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkBackup,
  checkBackupLocation,
  checkDeclared,
  checkInstalled,
  checkLibrary,
  fixDeclared,
  runDoctor,
  writeAlert,
} from '../scripts/doctor.mjs'

function tmp(prefix = 'fishmem-doctor-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一个"看起来正常"的 profile */
function fakeProfile(pluginDir) {
  const p = tmp('profile-')
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-fish-memory': `link:${pluginDir}` } }, null, 2), 'utf8')
  return p
}

/** 造一个最小的库（core + 一条档案） */
function fakeLib() {
  const d = tmp('lib-')
  for (const sub of ['00_core', '10_archive/messages', '20_state', '30_points', '50_log']) mkdirSync(join(d, sub), { recursive: true })
  writeFileSync(join(d, '00_core/soul.md'), '# SOUL\n', 'utf8')
  writeFileSync(join(d, '10_archive/messages/2026-11-08.jsonl'), '', 'utf8')
  return d
}

// ── ① 声明 ───────────────────────────────────────────────────
test('医生：profile 里的 link 声明缺了 → 判失败（这就是 11-03 那次）', () => {
  const plugin = tmp('plugin-')
  const prof = tmp('profile-')
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }), 'utf8')
  const r = checkDeclared(prof, plugin)
  assert.equal(r.ok, false)
  assert.match(r.detail, /没有 dsh-fish-memory/)
})

test('医生：声明指向别的目录 → 判失败（装错的不是本仓库那份）', () => {
  const plugin = tmp('plugin-')
  const other = tmp('other-')
  const prof = fakeProfile(other)
  const r = checkDeclared(prof, plugin)
  assert.equal(r.ok, false)
  assert.match(r.detail, /指向别处/)
})

test('医生 --fix：补回声明，且改之前先备份 profile', () => {
  const plugin = tmp('plugin-')
  const prof = tmp('profile-')
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }, null, 2), 'utf8')

  const r = fixDeclared(prof, plugin)
  assert.equal(r.ok, true)
  const j = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'))
  assert.ok(String(j.dependencies['dsh-fish-memory']).startsWith('link:'))
  const baks = readdirSync(prof).filter((f) => f.startsWith('package.json.bak-doctor-'))
  assert.equal(baks.length, 1, '改之前必须留一份备份')
})

test('医生 --fix：已经有声明就不动（幂等）', () => {
  const plugin = tmp('plugin-')
  const prof = fakeProfile(plugin)
  const before = readFileSync(join(prof, 'package.json'), 'utf8')
  const r = fixDeclared(prof, plugin)
  assert.equal(r.ok, true)
  assert.match(r.detail, /不需要修/)
  assert.equal(readFileSync(join(prof, 'package.json'), 'utf8'), before)
})

// ── ② 装进去的那份 ───────────────────────────────────────────
test('医生：junction 断了（装了但入口不在）→ 判失败', () => {
  const prof = tmp('profile-')
  mkdirSync(join(prof, 'node_modules/dsh-fish-memory/lib'), { recursive: true })
  const r = checkInstalled(prof)
  assert.equal(r.ok, false)
  assert.match(r.detail, /入口不在/)
})

test('医生：装好的那份能读出入口 → 通过', () => {
  const prof = tmp('profile-')
  mkdirSync(join(prof, 'node_modules/dsh-fish-memory/lib'), { recursive: true })
  writeFileSync(join(prof, 'node_modules/dsh-fish-memory/lib/index.js'), 'export default {}\n', 'utf8')
  writeFileSync(join(prof, 'node_modules/dsh-fish-memory/package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
  const r = checkInstalled(prof)
  assert.equal(r.ok, true)
  assert.match(r.detail, /9\.9\.9/)
})

// ── ③ 库与链 ─────────────────────────────────────────────────
test('医生：库不存在 → 判失败（她"什么都不记得"的另一种形态）', () => {
  const r = checkLibrary(join(tmp(), 'nope'))
  assert.equal(r.ok, false)
  assert.match(r.detail, /库不存在/)
})

test('医生：core 缺 soul.md → 判失败', () => {
  const d = tmp('lib-')
  mkdirSync(join(d, '00_core'), { recursive: true })
  const r = checkLibrary(d)
  assert.equal(r.ok, false)
  assert.match(r.detail, /soul\.md/)
})

test('医生：健康的库通过，并报 core 文件数', () => {
  const d = fakeLib()
  const r = checkLibrary(d)
  assert.equal(r.ok, true)
  assert.match(r.detail, /core 1 个/)
})

// ── ④ 备份新鲜度 ─────────────────────────────────────────────
test('医生：备份超过 48 小时 → 判失败（她还在，但最近没人打包）', () => {
  const root = tmp('bak-')
  const d = join(root, 'fish-memory-2026-01-01')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'MANIFEST.json'), JSON.stringify({ format: 'fish-memory-pack', files: [] }), 'utf8')
  const r = checkBackup(root, { now: Date.now() + 3 * 86_400_000 })
  assert.equal(r.ok, false)
  assert.match(r.detail, /超过 48 小时/)
})

test('医生：没有备份 → 判失败', () => {
  const root = tmp('bak-')
  const r = checkBackup(root)
  assert.equal(r.ok, false)
  assert.match(r.detail, /一份备份都没有/)
})

// ── ⑤ 位置提示 / 告警文件 / 总流程 ───────────────────────────
test('医生：备份和库同盘时给提示（不判失败）', () => {
  const d = tmp('lib-')
  const r = checkBackupLocation(d, join(d, '..', 'fish-memory-backups'))
  assert.equal(r.ok, true)
  assert.equal(r.warn, true)
  assert.match(r.detail, /同一个盘|不在库所在的盘/)
})

test('医生：失败时在工作区根写告警文件，且内容说得清后果', () => {
  const ws = tmp('ws-')
  const p = writeAlert(ws, ['profile 声明：没有 dsh-fish-memory'])
  assert.ok(p && p.endsWith('.md'))
  const text = readFileSync(p, 'utf8')
  assert.match(text, /不会报错/)
  assert.match(text, /doctor\.mjs --fix/)
})

test('医生：端到端（缺声明）→ ok=false 且列出失败项', () => {
  const plugin = tmp('plugin-')
  const prof = tmp('profile-')
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
  const lib = fakeLib()
  const r = runDoctor({ dir: lib, profileDir: prof, backupRoot: join(lib, '..', 'fish-memory-backups') })
  assert.equal(r.ok, false)
  assert.ok(r.bad.some((b) => b.name === 'profile 声明'))
})
