// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * G1 真删除（v0.11.0）。
 *
 * 这套东西最容易做错的地方不是"删不掉"，而是**删完之后系统自己认为被篡改了**：
 * 完整性清单（v0.8.0）会把改动判成 changed、链会断、备份会和活库不一致。
 * 所以这一组测试盯的是"删完以后，其余机制仍然自洽"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveWriter, verifyChain } from '../lib/archive.js'
import { applyErase, planErase, readErasureLog } from '../lib/erase.js'
import { checkArchive } from '../lib/integrity.js'

const event = (seq, id, text, role = 'user') => ({
  type: role === 'user' ? 'user/message' : 'assistant/message',
  seq,
  time: Date.now(),
  surfaceOp: 'append',
  data:
    role === 'user'
      ? { id, role, content: [{ type: 'text', text }], source: { kind: 'user' } }
      : { message: { id, role, content: [{ type: 'text', text }], source: { kind: 'model' } } },
})

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 每条测试一个独立父目录：`<parent>/fish-memory` + `<parent>/fish-memory-backups` */
async function seed({ withBackup = false } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'fishmem-erase-root-'))
  const dir = join(parent, 'fish-memory')
  mkdirSync(join(dir, '20_state'), { recursive: true })
  const w = new ArchiveWriter(dir, { logger: { warn() {} } })
  await w.handle('s1', event(1, 'msg-a', '第一条：今天聊了天气'))
  await w.handle('s1', event(2, 'msg-b', '第二条：密码是 hunter2'))
  await w.handle('s1', event(3, 'msg-c', '第三条：晚安'))
  checkArchive(dir) // 建基线：模拟"这个版本早就跑过"

  if (withBackup) {
    const dest = join(parent, 'fish-memory-backups', 'fish-memory-2026-10-30')
    mkdirSync(join(dest, '10_archive', 'messages'), { recursive: true })
    const src = join(dir, '10_archive', 'messages')
    const files = readdirSync(src).filter((f) => f.endsWith('.jsonl'))
    const entries = []
    for (const f of files) {
      const target = join(dest, '10_archive', 'messages', f)
      writeFileSync(target, readFileSync(join(src, f)), 'utf8')
      entries.push({ path: `10_archive/messages/${f}`, size: readFileSync(target).length, sha256: sha256(target) })
    }
    writeFileSync(
      join(dest, 'MANIFEST.json'),
      JSON.stringify({ format: 'fish-memory-pack', version: 1, created_at: new Date().toISOString(), files: entries }, null, 2),
      'utf8',
    )
  }
  return dir
}

const rowsOf = (file) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const onlyJsonl = (dir) => {
  const base = join(dir, '10_archive', 'messages')
  return join(base, readdirSync(base).find((f) => f.endsWith('.jsonl')))
}

const pointMd = (id, sourceId, title = '密码那件事') =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: active\nsource: [${sourceId}]\n---\n\n<!-- SUM -->\n他说了密码。\n<!-- /SUM -->\n`

test('预览：列出要删的消息、认出被引用的点，且不落盘', async () => {
  const dir = await seed()
  mkdirSync(join(dir, '30_points'), { recursive: true })
  writeFileSync(join(dir, '30_points', 'M-2026-10-30-001.md'), pointMd('M-2026-10-30-001', 'msg-b'), 'utf8')

  const plan = planErase(dir, { messageIds: ['msg-b'] })
  assert.equal(plan.messages.length, 1)
  assert.equal(plan.messages[0].hash8.length, 8)
  assert.deepEqual(
    plan.refs.map((r) => r.id),
    ['M-2026-10-30-001'],
  )
  assert.equal(readFileSync(onlyJsonl(dir), 'utf8').includes('hunter2'), true, '预览不许改东西')
})

test('真删一条：原文没了、链仍可校验、墓碑不含原文', async () => {
  const dir = await seed()
  const plan = planErase(dir, { messageIds: ['msg-b'] })
  const r = applyErase(dir, plan, { reason: '里面有一句密钥' })
  assert.equal(r.removed, 1)

  const file = onlyJsonl(dir)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes('hunter2'), false, '原文必须真的没了')
  const rows = rowsOf(file)
  assert.equal(rows.length, 2)
  assert.equal(verifyChain(rows).ok, true, JSON.stringify(verifyChain(rows)))

  const tomb = readErasureLog(dir).find((t) => t.kind === 'message')
  assert.match(tomb.id, /^msg-\d+-/, '墓碑记的是档案记录 id')
  assert.equal(tomb.plat, 'msg-b', '同时留平台 id，方便对账')
  assert.equal(tomb.reason, '里面有一句密钥')
  assert.equal(tomb.hash8.length, 8)
  assert.equal(readFileSync(join(dir, '50_log', 'erasure.log'), 'utf8').includes('hunter2'), false, '墓碑不含原文')
})

test('删完再启动：完整性检查不该把这次授权删除当成篡改', async () => {
  const dir = await seed()
  applyErase(dir, planErase(dir, { messageIds: ['msg-b'] }), { reason: '测试' })
  const again = checkArchive(dir)
  assert.equal(again.ok, true, `删完还被报篡改就白做了：${JSON.stringify(again)}`)
  assert.deepEqual(again.changed, [])
})

test('被引用的点：默认不删，cascade 才连点一起删', async () => {
  const dir = await seed()
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const pointFile = join(dir, '30_points', 'M-2026-10-30-001.md')
  writeFileSync(pointFile, pointMd('M-2026-10-30-001', 'msg-b'), 'utf8')

  const plan = planErase(dir, { messageIds: ['msg-b'] })
  assert.equal(plan.refs.length, 1, '要认出引用')

  applyErase(dir, plan, { reason: '只删消息' })
  assert.equal(existsSync(pointFile), true, '默认不碰被引用的点')

  const dir2 = await seed()
  mkdirSync(join(dir2, '30_points'), { recursive: true })
  const pf2 = join(dir2, '30_points', 'M-2026-10-30-001.md')
  writeFileSync(pf2, pointMd('M-2026-10-30-001', 'msg-b'), 'utf8')
  const plan2 = planErase(dir2, { messageIds: ['msg-b'] })
  applyErase(dir2, { ...plan2, points: [...plan2.points, ...plan2.refs] }, { reason: 'cascade' })
  assert.equal(existsSync(pf2), false, 'cascade 要连点一起删')
  assert.ok(readErasureLog(dir2).some((t) => t.kind === 'point' && t.id === 'M-2026-10-30-001'))
})

test('--point 直接删点：不动档案', async () => {
  const dir = await seed()
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const pf = join(dir, '30_points', 'M-2026-10-30-009.md')
  writeFileSync(pf, pointMd('M-2026-10-30-009', 'msg-c', '单独删掉'), 'utf8')

  const plan = planErase(dir, { pointIds: ['M-2026-10-30-009'] })
  assert.equal(plan.points.length, 1)
  applyErase(dir, plan, { reason: '不需要了' })
  assert.equal(existsSync(pf), false)
  assert.equal(readFileSync(onlyJsonl(dir), 'utf8').trim().split('\n').length, 3, '档案原封不动')
})

test('找不到的 id：直接报错，绝不静默跳过', async () => {
  const dir = await seed()
  const plan = planErase(dir, { messageIds: ['msg-not-exist'] })
  assert.deepEqual(plan.unknown, ['msg-not-exist'])
  assert.throws(() => applyErase(dir, plan), /找不到这些 id/)
})

test('备份同步改写：备份里那行也没了，MANIFEST 的 sha256 跟着重算', async () => {
  const dir = await seed({ withBackup: true })
  const backupDay = join(dir, '..', 'fish-memory-backups', 'fish-memory-2026-10-30')
  const dayName = readdirSync(join(backupDay, '10_archive', 'messages')).find((f) => f.endsWith('.jsonl'))
  const backupPath = join(backupDay, '10_archive', 'messages', dayName)
  const manifestPath = join(backupDay, 'MANIFEST.json')
  const before = JSON.parse(readFileSync(manifestPath, 'utf8')).files.find((f) => f.path.endsWith(dayName)).sha256

  const plan = planErase(dir, { messageIds: ['msg-b'] })
  assert.ok(plan.backups.length >= 1, '要认出备份里也有这条')
  applyErase(dir, plan, { reason: '连备份一起' })

  assert.equal(readFileSync(backupPath, 'utf8').includes('hunter2'), false, '备份里也必须没了')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8')).files.find((f) => f.path.endsWith(dayName)).sha256
  assert.notEqual(after, before, 'MANIFEST 必须重算')
  assert.equal(after, sha256(backupPath), '哈希要与文件一致')
})
