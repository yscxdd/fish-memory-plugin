// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backtestSkill } from '../lib/backtest.js'

const SKILL = (version = 2, extra = '## 上次错在哪（v1 → v2）\n**v1**：直接转。\n') => `---
id: S-1
type: skill
name: 用 ffmpeg 转码视频
trigger: [转码, 格式转换, 视频压缩]
status: active
version: ${version}
last_applied: null
sections:
  - {name: 什么时候不能用, must_full: true}
  - {name: 上次错在哪, must_full: true}
  - {name: 怎么做, must_full: false}
---

## 做什么
把视频转成别的格式。

## 什么时候不能用
- 源文件损坏。

## 怎么做
1. ffmpeg -i a b

${extra}`

function make(skill = SKILL()) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-bt-'))
  mkdirSync(join(dir, '35_ability/_cases'), { recursive: true })
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  writeFileSync(join(dir, '35_ability/S-1.md'), skill)
  writeFileSync(join(dir, '35_ability/_cases/S-1.json'), JSON.stringify(['帮我转码', '格式转换一下', '视频压缩', '今天吃什么']))
  return dir
}

test('backtest：触发覆盖 3/4，结构不变量通过', () => {
  const r = backtestSkill(make(), 'S-1')
  assert.equal(r.hits, 3)
  assert.equal(r.queries, 4)
  assert.deepEqual(r.invariants, [])
  assert.equal(r.ok, true)
})

test('backtest：v2 缺「上次错在哪」= 不通过', () => {
  const r = backtestSkill(make(SKILL(2, '')), 'S-1')
  assert.ok(r.invariants.some((i) => i.includes('上次错在哪')), r.invariants.join(';'))
  assert.equal(r.ok, false)
})
