// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * v0.85.0：原话的标点 + CRLF 的 front matter。
 *
 * `quoteLine` 那条是评审列在"次要项"里的，但它动的不是性能，是**「原话逐字」这条硬规则**：
 * 旧实现把结尾标点全部剥掉再统一补句号，
 *
 *   他说："周六见面吗？"  →  他说："周六见面吗。"     ← 疑问句变陈述句
 *   她说："真的！！"      →  她说："真的。"
 *
 * 她记得的原话是她的底线（插件自己写在契约里的），所以这条单独一个版本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { quoteLine } from '../lib/render.js'

// ── quoteLine：结尾标点原样保留 ─────────────────────────────
test('v0.85：问号不会被改成句号（疑问句还是疑问句）', () => {
  assert.equal(quoteLine({ quote: '周六见面吗？', quoteBy: 'him' }), '他说："周六见面吗？"')
  assert.equal(quoteLine({ quote: '周六见面吗?', quoteBy: 'him' }), '他说："周六见面吗?"')
})

test('v0.85：感叹号、省略号、破折号都原样保留', () => {
  assert.equal(quoteLine({ quote: '真的！！', quoteBy: 'her' }), '她说："真的！！"')
  assert.equal(quoteLine({ quote: '算了吧……', quoteBy: 'him' }), '他说："算了吧……"')
  assert.equal(quoteLine({ quote: '你——', quoteBy: 'him' }), '他说："你——。"')
})

test('v0.85：没有结尾标点时才补句号（不双标点、不吞标点）', () => {
  assert.equal(quoteLine({ quote: '下次还来', quoteBy: 'her' }), '她说："下次还来。"')
  assert.equal(quoteLine({ quote: '好。', quoteBy: 'him' }), '他说："好。"', '已有句号不再补')
  assert.equal(quoteLine({ quote: '好。', quoteBy: 'him' }).includes('。。'), false)
})

test('v0.85：引号结尾时，里面没标点就补一个（不吞也不叠）', () => {
  // 「走吧」内部没有终止标点 → 补句号；写成「走吧。」就不再补
  assert.equal(quoteLine({ quote: '他说「走吧」', quoteBy: 'him' }), '他说："他说「走吧」。"')
  assert.equal(quoteLine({ quote: '他说「走吧。」', quoteBy: 'him' }), '他说："他说「走吧。」"')
})

test('v0.85：空原话照旧返回空串（不造一句）', () => {
  assert.equal(quoteLine({ quote: '', quoteBy: 'him' }), '')
  assert.equal(quoteLine({ quote: '   ', quoteBy: 'him' }), '')
})

// ── vault：Windows 上编辑过的点（CRLF）不该静默消失 ────────────
test('v0.85：vault.js 的 front matter 正则认 CRLF', () => {
  const src = readFileSync(new URL('../lib/vault.js', import.meta.url), 'utf8')
  const line = src.split('\n').find((l) => l.includes('raw.match(/^---'))
  assert.ok(line, '找不到解析 front matter 的那行')
  const code = line.trim().startsWith('//') ? src.split('\n').find((l) => l.includes('raw.match(/^---') && !l.trim().startsWith('//')) : line
  assert.match(code, /\\r\?\\n/, `front matter 正则要能吃 CRLF，实际：${code}`)
})
