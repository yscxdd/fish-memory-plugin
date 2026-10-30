// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { promoteSkill } from '../lib/backtest.js'

const S = (v, lesson = '## 上次错在哪（v1 → v2）\n**v1**：直接转。\n', triggers = '转码, 格式转换, 视频压缩') => `---
id: S-1
name: 用 ffmpeg 转码视频
trigger: [${triggers}]
status: active
version: ${v}
sections:
  - {name: 什么时候不能用, must_full: true}
  - {name: 上次错在哪, must_full: true}
---

## 做什么
转格式。

## 什么时候不能用
源文件坏时。

${lesson}`

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-sp-'))
  mkdirSync(join(dir, '35_ability/_cases'), { recursive: true })
  writeFileSync(join(dir, '35_ability/S-1.md'), S(1))
  writeFileSync(join(dir, '35_ability/_cases/S-1.json'), JSON.stringify(['帮我转码', '格式转换', '视频压缩']))
  return dir
}

test('skill-promote：回测通过才落盘，旧版进 versions', () => {
  const dir = make()
  const draft = join(dir, 'draft.md')
  writeFileSync(draft, S(2))
  const r = promoteSkill(dir, draft)
  assert.equal(r.applied, true, r.invariants?.join(';'))
  assert.equal(existsSync(join(dir, '35_ability/versions/S-1.v1.md')), true)
  assert.match(readFileSync(join(dir, '35_ability/S-1.md'), 'utf8'), /version: 2/)
})

test('skill-promote：v2 缺「上次错在哪」= 拒绝，不落盘', () => {
  const dir = make()
  const draft = join(dir, 'draft.md')
  writeFileSync(draft, S(2, ''))
  const r = promoteSkill(dir, draft)
  assert.equal(r.applied, false)
  assert.match(readFileSync(join(dir, '35_ability/S-1.md'), 'utf8'), /version: 1/)
})
