// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 可调参数 + 静态报告（v0.45.0，D 组 + A 组）。
 *
 * 为什么不是可写面板：面板改一个值 = 第二个写入口，audit/origin/version/tamper 全部可绕过。
 * 这里钉住两条：
 *   ① 白名单 + 类型 + 范围，写不合法就拒（不"纠正"、不"就近取整"）；
 *   ② 每次改动进 settings.log（键、从什么到什么、什么时候）。
 *
 * 报告这边钉住：
 *   ③ 生成报告**不改任何状态**；
 *   ④ 数据一律转义（文件名/原话里可能有 `<`）；
 *   ⑤ 单文件、不联网、不引外部资源。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TUNABLES,
  applyOverrides,
  effectiveValue,
  loadSettings,
  parseValue,
  resetSetting,
  setSetting,
} from '../lib/settings.js'
import { collectReport, renderReport, writeReport } from '../lib/report.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-cfg-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log', '90_snapshot']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), '# SOUL\n\n## 不会变的\n\n- a\n', 'utf8')
  return dir
}

test('白名单：认识的键能改，不认识的拒', () => {
  const dir = fixture()
  assert.equal(setSetting(dir, 'retrieval.threshold', '0.6').ok, true)
  assert.equal(loadSettings(dir)['retrieval.threshold'], 0.6)
  const bad = setSetting(dir, 'soul.text', '我换个人')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /不认识的参数/)
})

test('类型与范围：数字有界、布尔认 on/off，非法值不写半截', () => {
  const dir = fixture()
  assert.equal(setSetting(dir, 'retrieval.threshold', '5').ok, false)
  assert.equal(setSetting(dir, 'retrieval.threshold', 'abc').ok, false)
  assert.equal(loadSettings(dir)['retrieval.threshold'], undefined, '失败不该留下半截值')
  assert.equal(setSetting(dir, 'emotion.enabled', 'off').to, false)
  assert.equal(setSetting(dir, 'emotion.enabled', 'on').to, true)
  assert.equal(parseValue({ type: 'bool' }, 'maybe').ok, false)
})

test('每次改动进 settings.log（从什么到什么）', () => {
  const dir = fixture()
  setSetting(dir, 'retrieval.maxEvents', '5')
  const row = JSON.parse(readFileSync(join(dir, '50_log/settings.log'), 'utf8').trim().split('\n').pop())
  assert.equal(row.key, 'retrieval.maxEvents')
  assert.equal(row.from, 3)
  assert.equal(row.to, 5)
  assert.equal(typeof row.at, 'string')
})

test('reset：恢复默认并从 settings.json 里删掉', () => {
  const dir = fixture()
  setSetting(dir, 'retrieval.threshold', '0.5')
  const r = resetSetting(dir, 'retrieval.threshold')
  assert.equal(r.ok, true)
  assert.equal(loadSettings(dir)['retrieval.threshold'], undefined)
  assert.equal(effectiveValue(dir, TUNABLES.find((t) => t.key === 'retrieval.threshold')), 0.8)
})

test('applyOverrides：点号键写进嵌套对象，且不改原对象', () => {
  const base = { retrieval: { threshold: 0.8, maxEvents: 3 }, emotion: { enabled: true } }
  const out = applyOverrides(base, { 'retrieval.threshold': 0.6, 'emotion.enabled': false })
  assert.equal(out.retrieval.threshold, 0.6)
  assert.equal(out.emotion.enabled, false)
  assert.equal(base.retrieval.threshold, 0.8, '原对象不能被改')
  assert.equal(out.retrieval.maxEvents, 3, '没覆盖的键要留着')
})

test('报告：生成文件、内容含关键块、不改状态', () => {
  const dir = fixture()
  const before = readdirSync(join(dir, '20_state')).join(',')
  const r = writeReport(dir, { now: new Date('2026-11-04T01:00:00Z') })
  assert.equal(existsSync(r.path), true)
  const html = readFileSync(r.path, 'utf8')
  for (const k of ['状态报告', '情绪', '注入预算', '文件索引', '待审草稿', '核心层改动']) {
    assert.match(html, new RegExp(k), `报告里应有「${k}」`)
  }
  const after = readdirSync(join(dir, '20_state')).join(',')
  assert.equal(after, before, '生成报告不该写 20_state')
})

test('报告：数据里的尖括号被转义（不能变成标记）', () => {
  const dir = fixture()
  writeFileSync(
    join(dir, '30_points', 'M-1.md'),
    ['---', 'id: M-1', 'title: <script>alert(1)</script>', 'quote: null', 'date: 2026-11-01', 'salience: 2', 'type: event', 'cluster: x', 'status: active', 'source: []', 'links: []', '---', '', '<!-- SUM -->', 'x', '<!-- /SUM -->'].join('\n'),
    'utf8',
  )
  const html = renderReport(collectReport(dir))
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test('报告：空库也能生成（不因为没数据就报错）', () => {
  const dir = fixture()
  const data = collectReport(dir)
  assert.equal(data.counts.points, 0)
  const html = renderReport(data)
  assert.match(html, /还没开始被养|还没有记忆点/)
})
