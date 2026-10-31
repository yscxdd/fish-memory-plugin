// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 开养前清零（`memory reset --all`，v0.19.0）。
 *
 * 为什么这是一条独立命令：它**违反"档案只追加"**这条不变量，所以只能存在一次、
 * 只在一个窗口里有效（还没开养）。用完就该关——不是"遗忘"，是"重新开始"。
 *
 * 钉四条：
 *   ① 清干净：档案 / 状态 / 日志 / 快照 / 技能 / 草稿；
 *   ② 不动配置：`00_core/`、文档、模板一个字节不改；
 *   ③ 先算后删：`apply:false` 只出清单；
 *   ④ 幂等：清完再算一次，应该是 0。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyResetAll, planResetAll } from '../lib/reset.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-reset-'))
  const put = (rel, text) => {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
  // 档案：2 天、3 条
  put('10_archive/messages/2026-10-30.jsonl', '{"id":"m1"}\n{"id":"m2"}\n')
  put('10_archive/messages/2026-10-31.jsonl', '{"id":"m3"}\n')
  put('10_archive/raw/2026-10-30.jsonl', '{"raw":1}\n')
  // 状态
  put('20_state/cursors.json', '{"a":1}')
  put('20_state/state.json', '{"tick":3}')
  put('20_state/sessions/s1.json', '{"tail":[]}')
  put('20_state/archive-manifest.json', '{"files":{}}')
  // 日志
  put('50_log/retrieval.log', '{"n":1}\n')
  put('50_log/host.log', '{"n":1}\n')
  // 唤醒包
  put('90_snapshot/wakeup-20261031/manifest.json', '{}')
  // 技能：模板 + 搭库期造的
  put('35_ability/TEMPLATE.md', '# 模板')
  put('35_ability/tools.md', '## 我手上有什么')
  put('35_ability/S-20261030-001.md', '# 维护记忆库')
  put('35_ability/S-20261030-001.json', '{}')
  // 记忆点：模板 + 一条
  put('30_points/TEMPLATE.md', '# 模板')
  put('30_points/M-2026-10-28-001.md', '---\nid: M-2026-10-28-001\n---\n')
  // 草稿
  put('40_pending/README.md', '# 草稿区')
  put('40_pending/M-2026-10-31-001.md', '---\nid: M-2026-10-31-001\n---\n')
  // 自述 / 调试
  put('15_self/2026-10.md', '# 我最近在想什么')
  put('_debug/assemble.json', '{}')
  // 核心层：配置（不动）+ 变更记录（清回表头）
  put('00_core/soul.md', '# SOUL\n\n- 绝不会：说教')
  put('00_core/user.md', '# USER\n\n- 我在哪：广州')
  put('00_core/core_changelog.md', '# 核心层变更记录\n\n2026-10-30 | user.md | v002 | 加「我在哪」\n')
  put('00_core/versions/soul.v001.md', '# SOUL')
  // 索引（派生）
  put('20_index/all.idx.jsonl', '{"id":"M-2026-10-28-001"}\n')
  // 文档
  put('MEMORY.md', '# MEMORY')
  put('COMPRESS.md', '# 压缩')
  return dir
}

test('清单：先算后删，apply=false 一个文件都不动', () => {
  const dir = fixture()
  const plan = planResetAll(dir)
  assert.equal(plan.archive_messages, 3, '3 条消息')
  assert.equal(plan.counts.archive, 2, '2 个档案文件')
  assert.equal(plan.counts['archive-raw'], 1)
  assert.ok(plan.counts.state >= 4)
  assert.ok(plan.counts.log >= 2)
  assert.ok(plan.counts.snapshot >= 1)
  assert.ok(plan.counts.ability >= 2)

  assert.ok(existsSync(join(dir, '10_archive/messages/2026-10-30.jsonl')), '只算不删')
  assert.ok(existsSync(join(dir, '30_points/M-2026-10-28-001.md')))
})

test('清完：经历没了，配置和文档还在', () => {
  const dir = fixture()
  const r = applyResetAll(dir)

  for (const rel of [
    '10_archive/messages/2026-10-30.jsonl',
    '10_archive/raw/2026-10-30.jsonl',
    '20_state/cursors.json',
    '50_log/retrieval.log',
    '90_snapshot/wakeup-20261031',
    '35_ability/S-20261030-001.md',
    '30_points/M-2026-10-28-001.md',
    '40_pending/M-2026-10-31-001.md',
    '15_self/2026-10.md',
    '_debug/assemble.json',
  ]) {
    assert.equal(existsSync(join(dir, rel)), false, `该删而没删：${rel}`)
  }

  for (const rel of [
    '00_core/soul.md',
    '00_core/user.md',
    '00_core/versions/soul.v001.md',
    'MEMORY.md',
    'COMPRESS.md',
    '35_ability/TEMPLATE.md',
    '35_ability/tools.md',
    '30_points/TEMPLATE.md',
    '40_pending/README.md',
  ]) {
    assert.ok(existsSync(join(dir, rel)), `不该删却删了：${rel}`)
  }

  assert.equal(r.archive_messages, 3) // 流水里只记数量
  assert.ok(existsSync(join(dir, '50_log/reset.log')))
})

test('核心层变更记录清回表头（搭库期的改动不带进开养）', () => {
  const dir = fixture()
  applyResetAll(dir)
  const text = readFileSync(join(dir, '00_core/core_changelog.md'), 'utf8')
  assert.match(text, /开养前清零/)
  assert.doesNotMatch(text, /加「我在哪」/)
})

test('索引重建为空（不是删掉就算）', () => {
  const dir = fixture()
  applyResetAll(dir)
  assert.ok(existsSync(join(dir, '20_index/all.idx.jsonl')), '空索引文件应该被重建')
  assert.equal(readFileSync(join(dir, '20_index/all.idx.jsonl'), 'utf8').trim(), '')
})

test('vault 日笔记也要清（那里是逐条对话原文，最像"经历"）', () => {
  const dir = fixture()
  mkdirSync(join(dir, '20_index/views'), { recursive: true })
  writeFileSync(join(dir, '20_index/views/2026-10-30.md'), '# 2026-10-30 · 287 条\n\n她：「好，开工。」\n', 'utf8')
  applyResetAll(dir)
  assert.equal(existsSync(join(dir, '20_index/views')), false, 'views 目录应该整个没了')
  assert.equal(existsSync(join(dir, '20_index/index.md')), false, '旧入口页也不该留')
})

test('幂等：清完再算一次，应该是 0', () => {
  const dir = fixture()
  applyResetAll(dir)
  const again = planResetAll(dir)
  assert.deepEqual(again.counts, {})
  assert.equal(again.index_stale, false, '重建后的空索引不算"还有旧投影"')
  assert.equal(again.archive_messages, 0)
})

test('只剩旧 vault 视图时，预览不许说"已经干净了"', () => {
  const dir = fixture()
  applyResetAll(dir)
  // 模拟"清完之后又手动跑了一次 vault"：20_index 里重新出现日笔记
  mkdirSync(join(dir, '20_index/views'), { recursive: true })
  writeFileSync(join(dir, '20_index/views/2026-10-31.md'), '# 2026-10-31 · 1 条\n', 'utf8')
  const plan = planResetAll(dir)
  assert.deepEqual(plan.counts, {}, '没有其他东西要清')
  assert.equal(plan.index_stale, true, '但旧投影还在，必须能看出来')
})

test('流水不含任何原话（只有数量与时间）', () => {
  const dir = fixture()
  applyResetAll(dir)
  const line = readFileSync(join(dir, '50_log/reset.log'), 'utf8').trim()
  assert.doesNotMatch(line, /广州|维护记忆库|M-2026/)
  assert.match(line, /"op":"reset-all"/)
})

// ── v0.20.1：流水要追加、删完要复查 ─────────────────────────────

test('reset.log 是追加：清两次就有两行（第二次不该抹掉第一次）', () => {
  const dir = fixture()
  applyResetAll(dir)
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points/M-x.md'), '---\nid: M-x\n---\n', 'utf8')
  applyResetAll(dir)
  const lines = readFileSync(join(dir, '50_log/reset.log'), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 2, `应当有两次清零的流水，实际 ${lines.length} 行`)
  for (const l of lines) JSON.parse(l) // 每行都是合法 JSON
})

test('apply 返回 residual：删完复查一遍，残留要能报出来', () => {
  const dir = fixture()
  const r = applyResetAll(dir)
  assert.ok(r.residual, '必须有 residual 字段')
  assert.equal(r.residual.total, 0, `清完应当没有残留，实际 ${JSON.stringify(r.residual.counts)}`)
  assert.equal(r.residual.index_stale, false)
})
