// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 三件小的（v0.10.0）：schema 版本 / 相似度告警 / 跨进程竞态。
 *
 * 共同点：**都不许自动改数据**。
 *   - 版本不认识 → 报错，不猜；
 *   - 点太像 → 告警，不合并；
 *   - 别人动过文件 → 重读链头继续写（自愈）+ 留日志，不静默丢。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  POINT_SCHEMA_VERSION,
  migratePoint,
  readPointFiles,
  similarPoints,
  validatePoint,
} from '../lib/toolkit.js'
import { ArchiveWriter, verifyChain } from '../lib/archive.js'
import { parseFrontMatter } from '../lib/util.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

const point = (over = {}) => ({
  id: 'M-2026-10-30-001',
  title: '他讨厌香菜',
  date: '2026-10-30',
  salience: 3,
  type: 'preference',
  cluster: '偏好',
  status: 'pending',
  summary: '他说他讨厌香菜，以后点菜避开。',
  quote: '我讨厌香菜',
  quote_by: 'him',
  facts: '他说讨厌香菜。',
  thoughts: '',
  tags: ['香菜'],
  links: [],
  source: ['msg-1'],
  ...over,
})

const archive = { byId: new Map([['msg-1', { id: 'msg-1', text: '我讨厌香菜' }]]) }

// ── G5 schema 版本 ────────────────────────────────────────────

test('G5：没有 version 的老点按 1 读，不当错误', () => {
  const { errors } = validatePoint(point(), { archive })
  assert.deepEqual(errors, [])
  assert.equal(POINT_SCHEMA_VERSION, 1)
})

test('G5：来自更新版本的点必须报错（否则旧代码会按旧格式读错）', () => {
  const r = validatePoint(point({ version: POINT_SCHEMA_VERSION + 1 }), { archive })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0].message, /更新的插件/)
})

test('G5：version 非法值报错', () => {
  for (const bad of [0, -1, 1.5, 'x', null]) {
    const r = validatePoint(point({ version: bad }), { archive })
    const has = r.errors.some((e) => e.field === 'version')
    // null 会被当成"没写"，这是有意的：老文件里 null 视同缺省
    if (bad === null) assert.equal(has, false, 'null 视同缺省')
    else assert.equal(has, true, `应报错：${JSON.stringify(bad)}`)
  }
})

test('G5：migratePoint 当前是恒等（v1 无迁移），但入口存在', () => {
  const p = point()
  assert.deepEqual(migratePoint(p), p)
  // 未来的点不会被"降级"
  const future = point({ version: 99 })
  assert.equal(migratePoint(future).version, 99)
})

test('G5：readPointFiles 把 version 读出来（缺省时是 undefined）', () => {
  const dir = tmp('fishmem-schema-')
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const withVer = point({ id: 'M-2026-10-30-001', version: 1 })
  const without = point({ id: 'M-2026-10-30-002' })
  const toMd = (p) => `---\n${Object.entries(p)
    .filter(([k]) => !['facts', 'thoughts', 'summary'].includes(k))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join('\n')}\n---\n\n<!-- SUM -->\n${p.summary}\n<!-- /SUM -->\n`
  writeFileSync(join(dir, '30_points', 'a.md'), toMd(withVer), 'utf8')
  writeFileSync(join(dir, '30_points', 'b.md'), toMd(without), 'utf8')
  const pts = readPointFiles(dir, '30_points')
  assert.equal(pts.find((p) => p.id === 'M-2026-10-30-001').version, 1)
  assert.equal(pts.find((p) => p.id === 'M-2026-10-30-002').version, undefined)
})

// ── G6 相似度告警 ─────────────────────────────────────────────

test('G6：同一件事换个说法 → 提醒，但只是告警（不拦、不合并）', () => {
  const existing = [{ id: 'M-2026-10-30-001', title: '他讨厌香菜', summary: '他说他讨厌香菜，以后点菜避开。' }]
  const draft = point({ id: 'M-2026-10-31-001', title: '他嫌香菜', summary: '他说他讨厌香菜，以后点菜避开。' })
  const r = validatePoint(draft, { archive, points: existing })
  assert.deepEqual(r.errors, [], '相似不是错误——不许自动拦下来')
  const w = r.warnings.find((x) => x.field === 'similar')
  assert.ok(w, JSON.stringify(r.warnings))
  assert.match(w.message, /M-2026-10-30-001/)
})

test('G6：不同的事不提醒；太短的点不提醒（避免噪音）', () => {
  const existing = [{ id: 'M-2026-10-30-001', title: '他讨厌香菜', summary: '他说他讨厌香菜，以后点菜避开。' }]
  const different = point({ id: 'M-2026-10-31-001', title: '台风把窗户吹坏', summary: '去年台风天窗户被吹坏。' })
  assert.equal(validatePoint(different, { archive, points: existing }).warnings.some((w) => w.field === 'similar'), false)
  // 两个字的标题（mine.size < 4）不参与比较
  assert.deepEqual(similarPoints({ title: '香菜', summary: '' }, existing), [])
})

test('G6：similarPoints 只返回前 3 个、按相似度降序', () => {
  const base = { title: '他讨厌香菜', summary: '他说他讨厌香菜，以后点菜避开。' }
  const others = Array.from({ length: 5 }, (_, i) => ({ id: `M-${i}`, ...base }))
  const out = similarPoints(base, others)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((x) => x.score), [...out.map((x) => x.score)].sort((a, b) => b - a))
})

// ── V5 跨进程竞态 ─────────────────────────────────────────────

function seed() {
  const dir = tmp('fishmem-race-')
  mkdirSync(join(dir, '10_archive', 'messages'), { recursive: true })
  mkdirSync(join(dir, '20_state'), { recursive: true })
  mkdirSync(join(dir, '50_log'), { recursive: true })
  return dir
}

const event = (seq, id, text) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

test('V5：别人在两次写入之间加过一行 → 重读链头，链不断、留日志', async () => {
  const dir = seed()
  const warnings = []
  const w = new ArchiveWriter(dir, { logger: { warn: (m) => warnings.push(String(m)) } })
  await w.handle('s1', event(1, 'msg-a', '第一条'))

  const file = join(dir, '10_archive', 'messages', readdirSync(join(dir, '10_archive', 'messages'))[0])
  // 模拟另一个进程：直接往同一个文件追加一条（用一条独立的、prev 正确指向当前链尾的记录）
  const last = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop())
  const intruder = { id: 'msg-x', seq: 2, prev: last.hash, hash: 'ffffffff', ts: new Date().toISOString(), role: 'user', text: '另一个窗口写的' }
  appendFileSync(file, JSON.stringify(intruder) + '\n', 'utf8')

  // 我们这边的缓存还停在第一条：不重读的话 prev 会指向旧链尾 → 断链
  await w.handle('s1', event(3, 'msg-b', '第三条'))

  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 3)
  assert.equal(rows[2].prev, intruder.hash, 'prev 必须接在人家写的那条上')
  assert.equal(w.races, 1, '要记一次竞态')
  assert.ok(warnings.some((m) => /别的进程改过/.test(m)), JSON.stringify(warnings))
  assert.equal(existsSync(join(dir, '50_log', 'archive-race.log')), true, '要留日志')
  // 注意：intruder 的 hash 是我们随手写的 'ffffffff'，链校验自然不通过；
  // 这里只验证"我们的下一行接对了前辈"。真正的链校验由写入者保证。
})

test('V5：没有任何外部改动时，不报竞态、链保持有效', async () => {
  const dir = seed()
  const w = new ArchiveWriter(dir, { logger: { warn() {} } })
  await w.handle('s1', event(1, 'msg-a', '第一条'))
  await w.handle('s1', event(2, 'msg-b', '第二条'))
  assert.equal(w.races, 0)
  const file = join(dir, '10_archive', 'messages', readdirSync(join(dir, '10_archive', 'messages'))[0])
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(verifyChain(rows).ok, true, JSON.stringify(verifyChain(rows)))
})

// ── v0.20.1：front matter 的键不许是 __proto__ ─────────────────

test('front matter 里写 __proto__ / constructor 不会污染对象原型', () => {
  const text = ['---', 'id: M-1', '__proto__: {polluted: true}', 'constructor: {bad: true}', 'title: 正常字段', '---', '', '正文'].join('\n')
  const { meta } = parseFrontMatter(text)
  assert.equal(meta.title, '正常字段', '正常字段照常解析')
  assert.equal({}.polluted, undefined, '全局 Object.prototype 不能被污染')
  assert.equal(Object.getPrototypeOf(meta), Object.prototype, 'meta 的原型必须还是 Object.prototype')

  // 嵌套块里的危险键同样要挡
  const nested = ['---', 'id: M-2', 'emotion:', '  __proto__: {x: 1}', '  user: {valence: 0.5}', '---', ''].join('\n')
  const r2 = parseFrontMatter(nested).meta
  assert.equal(Object.getPrototypeOf(r2.emotion), Object.prototype, '嵌套对象原型也不能被改')
  assert.equal(r2.emotion.user.valence, 0.5)
})
