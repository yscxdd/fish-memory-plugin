// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * envcheck.test.js — 钉住两条环境闸门的判据（v0.15.1）。
 *
 * 这两条历史上都"判不出失败"：`版本一致` 写死 true，`运行时版本` 只算 warn。
 * 于是"磁盘 0.15.0、进程 0.14.1"仍然打印「✓ 所有闸门通过」、退出码 0——
 * 而这个项目最常栽的坑就是"改了 lib/ 没重启"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeVersion, runtimeGate, versionGate } from '../lib/envcheck.js'

test('normalizeVersion：容忍 v 前缀与空白', () => {
  assert.equal(normalizeVersion('v0.15.1'), '0.15.1')
  assert.equal(normalizeVersion(' 0.15.1 '), '0.15.1')
  assert.equal(normalizeVersion(undefined), '')
})

test('版本一致：两边相同才过', () => {
  const r = versionGate({ pkgVersion: '0.15.1', installedVersion: '0.15.1', checked: true })
  assert.equal(r.ok, true)
  assert.match(r.detail, /0\.15\.1/)
})

test('版本一致：源码新、profile 旧 → 失败（以前这行永远打 ✓）', () => {
  const r = versionGate({ pkgVersion: '0.15.1', installedVersion: '0.14.1', checked: true })
  assert.equal(r.ok, false)
  assert.equal(r.level, 'fail')
  assert.match(r.detail, /0\.15\.1/)
  assert.match(r.detail, /0\.14\.1/)
  assert.match(r.detail, /sync/)
})

test('版本一致：profile 里没有这个包 → 失败，不是跳过', () => {
  const r = versionGate({ pkgVersion: '0.15.1', installedVersion: undefined, checked: true })
  assert.equal(r.ok, false)
  assert.match(r.detail, /找不到/)
})

test('版本一致：没设 DSH_PROFILE_DIR → 跳过，不算失败', () => {
  const r = versionGate({ pkgVersion: '0.15.1', installedVersion: undefined, checked: false })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
})

test('运行时版本：lib 指纹一致 → 过，版本号不同也不怪它', () => {
  const r = runtimeGate({ liveLib: 'aaaaaaaa', localLib: 'aaaaaaaa', liveVersion: '0.15.0', diskVersion: '0.15.1' })
  assert.equal(r.ok, true)
  assert.match(r.detail, /一致/)
})

test('运行时版本：指纹不同 → 失败（以前只是 warn，不计入退出码）', () => {
  const r = runtimeGate({ liveLib: 'a11b8266', localLib: '66d50df2', liveVersion: '0.14.1', diskVersion: '0.15.1' })
  assert.equal(r.ok, false)
  assert.equal(r.level, 'fail')
  assert.match(r.detail, /a11b8266/)
  assert.match(r.detail, /66d50df2/)
})

test('运行时版本：老启动记录没有指纹 → 不判失败，但说明原因', () => {
  assert.equal(runtimeGate({ liveLib: null, localLib: 'x', liveVersion: '0.13.1', diskVersion: '0.15.1' }).ok, true)
  assert.equal(runtimeGate({ liveLib: null, localLib: 'x', liveVersion: null, diskVersion: '0.15.1' }).ok, true)
})
