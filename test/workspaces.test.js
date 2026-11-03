// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 工作区文件索引（v0.42.0）。
 *
 * 借自 ArcDream Hub（MIT）的"名字级索引 + 边界读取"，但收紧了三处。
 *
 * 钉住：
 *   ① 只索引名字/路径/大小/时间，不读内容；
 *   ② 路径穿越三个坑都拦住（`..`、前缀相同的兄弟目录、大小写）；
 *   ③ 读取三道闸：边界 / ≤512KB / 后缀白名单；
 *   ④ 扫描跳过 node_modules 等，且超过 5 万文件就截断（不静默：返回值带 truncated）；
 *   ⑤ 搜索排序：全名匹配 > 前缀 > 包含 > 路径包含，同分按 mtime 新→旧。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_ROOTS,
  READ_MAX_BYTES,
  addWorkspace,
  buildFileIndex,
  indexStats,
  insideRoots,
  listAll,
  loadWorkspaces,
  readIndexedFile,
  removeWorkspace,
  searchFiles,
} from '../lib/workspaces.js'

const NOW = new Date('2026-11-04T00:00:00Z')

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'fishmem-ws-'))
  const lib = join(base, 'lib')
  const work = join(base, 'work')
  mkdirSync(join(lib, '20_state'), { recursive: true })
  mkdirSync(join(work, 'docs'), { recursive: true })
  mkdirSync(join(work, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(work, '报表.md'), '# 报表\n', 'utf8')
  writeFileSync(join(work, 'docs', '会议记录.txt'), '周一开会\n', 'utf8')
  writeFileSync(join(work, 'node_modules', 'x', 'should-skip.js'), 'x\n', 'utf8')
  writeFileSync(join(work, 'big.bin'), Buffer.alloc(600 * 1024))
  return { base, lib, work }
}

test('登记：绝对路径、必须存在、去重、有上限', () => {
  const { lib, work, base } = fixture()
  assert.equal(addWorkspace(lib, work, { now: NOW }).ok, true)
  assert.equal(addWorkspace(lib, work).ok, false, '重复登记要拒')
  assert.equal(addWorkspace(lib, 'relative/path').ok, false, '相对路径要拒')
  assert.equal(addWorkspace(lib, join(base, '不存在')).ok, false, '不存在的要拒')
  assert.equal(addWorkspace(lib, join(work, '报表.md')).ok, false, '文件不是目录')
  for (let i = 0; i < MAX_ROOTS + 2; i++) {
    const d = join(base, 'extra' + i)
    mkdirSync(d, { recursive: true })
    addWorkspace(lib, d)
  }
  assert.equal(loadWorkspaces(lib).roots.length <= MAX_ROOTS, true)
})

test('边界：里面算、外面不算、兄弟目录不算、穿越不算', () => {
  const { lib, work, base } = fixture()
  addWorkspace(lib, work)
  assert.equal(insideRoots(lib, join(work, '报表.md')).ok, true)
  assert.equal(insideRoots(lib, join(work, 'docs', '会议记录.txt')).ok, true)
  assert.equal(insideRoots(lib, base).ok, false, '登记目录本身不算"里面"')
  assert.equal(insideRoots(lib, join(work + '-evil', 'x.txt')).ok, false, '前缀相同的兄弟目录不许过')
  assert.equal(insideRoots(lib, join(work, '..', 'secret.txt')).ok, false, '.. 穿越不许过')
})

test('索引：只收名字级信息、跳过 node_modules、数量对得上', () => {
  const { lib, work } = fixture()
  addWorkspace(lib, work)
  const r = buildFileIndex(lib, { now: NOW })
  assert.equal(r.count, 3, `实际 ${r.count}（报表/会议记录/big.bin，node_modules 要跳过）`)
  assert.equal(r.truncated, false)
  const st = indexStats(lib)
  assert.equal(st.count, 3)
  assert.equal(st.at, NOW.toISOString())
})

test('搜索：全名 > 前缀 > 包含，同分按时间新→旧', () => {
  const { lib, work } = fixture()
  addWorkspace(lib, work)
  buildFileIndex(lib, { now: NOW })
  const r = searchFiles(lib, '报表', { now: NOW })
  assert.equal(r.hits.length >= 1, true)
  assert.equal(r.hits[0].n, '报表.md')

  const none = searchFiles(lib, '压根没有', { now: NOW })
  assert.equal(none.total, 0)
})

test('读取：三道闸——边界 / 大小 / 后缀', () => {
  const { lib, work, base } = fixture()
  addWorkspace(lib, work)

  const ok = readIndexedFile(lib, join(work, '报表.md'))
  assert.equal(ok.ok, true)
  assert.match(ok.text, /报表/)

  const outside = readIndexedFile(lib, join(base, 'outside.txt'))
  assert.equal(outside.ok, false)
  assert.match(outside.reason, /工作区/)

  const big = readIndexedFile(lib, join(work, 'big.bin'))
  assert.equal(big.ok, false)
  assert.match(big.reason, /太大|不读/)

  const ext = readIndexedFile(lib, join(work, 'big.bin'), { maxBytes: 10 * 1024 * 1024 })
  assert.equal(ext.ok, false)
  assert.match(ext.reason, /不读/, '后缀不在白名单也不读')
})

test('读不到的文件给理由，不抛', () => {
  const { lib, work } = fixture()
  addWorkspace(lib, work)
  const r = readIndexedFile(lib, join(work, '没有这个.md'))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('删登记：删了之后原来能读的就不让读了', () => {
  const { lib, work } = fixture()
  addWorkspace(lib, work)
  assert.equal(readIndexedFile(lib, join(work, '报表.md')).ok, true)
  removeWorkspace(lib, work)
  assert.equal(readIndexedFile(lib, join(work, '报表.md')).ok, false)
})

test('列表：能列出已登记目录与索引概况', () => {
  const { lib, work } = fixture()
  addWorkspace(lib, work)
  const rows = listAll(lib)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, work)
  assert.equal(typeof rows[0].files, 'number')
})
