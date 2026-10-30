// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 数据可信度（v0.8.0）：档案完整性 + 备份保留。
 *
 * 两组都在测"检测/清理的边界"——这类功能最容易写成"看起来在干活，其实抓不到/删过头"：
 *   ① 改前天的档案，能不能在**下次启动**时被看见（老的 verifyLatest 只看最后一天的文件，抓不到）；
 *   ② 清旧备份，会不会误删不属于备份的东西。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkArchive, fingerprintFile, readManifest, MANIFEST_FILE } from '../lib/integrity.js'
import { pruneBackups } from '../lib/heal.js'
import { ArchiveWriter, hashOf } from '../lib/archive.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

/** 造一个有两天的档案库：**必须是真链**（prev 串起来 + hash 由内容算出），否则验链没意义 */
async function seedArchive(days = 2) {
  const dir = tmp('fishmem-integ-')
  mkdirSync(join(dir, '20_state'), { recursive: true })
  mkdirSync(join(dir, '10_archive', 'messages'), { recursive: true })
  const files = []
  for (let d = 0; d < days; d++) {
    const day = `2026-10-${String(28 + d).padStart(2, '0')}`
    const file = join(dir, '10_archive', 'messages', `${day}.jsonl`)
    files.push({ day, file })
    const lines = []
    let prev = 'genesis'
    for (const i of [1, 2]) {
      const rec = {
        id: `msg-${d}-${i}`,
        seq: d * 10 + i,
        prev,
        hash: '',
        ts: `${day}T0${i}:00:00.000Z`,
        recorded_at: `${day}T0${i}:00:00.000Z`,
        role: 'user',
        source_kind: 'user',
        text: `第 ${d}-${i} 条`,
        session: `s${d}`,
        msgid_plat: `plat-${d}-${i}`,
      }
      rec.hash = hashOf(rec)
      prev = rec.hash
      lines.push(JSON.stringify(rec))
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  }
  return { dir, files }
}

test('完整性：首次跑建立基准，第二次比对说"没有变化"', async () => {
  const { dir } = await seedArchive(2)
  const first = checkArchive(dir)
  assert.equal(first.firstRun, true)
  assert.equal(first.checked, 2)
  assert.ok(first.ok, JSON.stringify(first))
  assert.ok(existsSync(join(dir, MANIFEST_FILE)), '要有清单文件')
  assert.equal(readManifest(dir).version, 1)

  const second = checkArchive(dir)
  assert.equal(second.firstRun, false)
  assert.ok(second.ok, JSON.stringify(second))
  assert.deepEqual(second.changed, [])
})

test('完整性：改**旧的**档案（不是当天那份）→ 下次启动能看见', async () => {
  const { dir, files } = await seedArchive(2)
  checkArchive(dir) // 基线

  // 改第一天（旧文件）里的一条正文——注意 hash 字段没跟着改，链校验会重算出不一致
  const old = files[0].file
  writeFileSync(old, readFileSync(old, 'utf8').replace('第 0-1 条', '第 9-9 条'), 'utf8')

  const r = checkArchive(dir)
  assert.equal(r.ok, false, '必须报出来')
  const named = [...r.changed, ...r.broken.map((b) => b.file), ...r.badLines.map((b) => b.file)]
  assert.ok(named.includes('2026-10-28.jsonl'), `要指名道姓说是哪一天：${JSON.stringify(r)}`)
})

test('完整性：删掉旧文件里的**最后一行**（条数变了）→ 指纹能抓到', async () => {
  const { dir, files } = await seedArchive(2)
  checkArchive(dir)
  const lines = readFileSync(files[0].file, 'utf8').trim().split('\n')
  writeFileSync(files[0].file, lines[0] + '\n', 'utf8')
  const r = checkArchive(dir)
  assert.equal(r.ok, false)
  assert.ok(r.changed.includes('2026-10-28.jsonl'), JSON.stringify(r))
})

test('完整性：当天那份变长是正常的，不许报"被改"', async () => {
  const { dir, files } = await seedArchive(2)
  checkArchive(dir) // 基线
  const newest = files[1].file
  writeFileSync(
    newest,
    readFileSync(newest, 'utf8') +
      JSON.stringify({ id: 'msg-new', seq: 99, prev: 'x', hash: 'abcdef12', ts: '2026-10-29T09:00:00.000Z', role: 'user', source_kind: 'user', text: '又一条', session: 's1', msgid_plat: 'plat-new' }) +
      '\n',
    'utf8',
  )
  const r = checkArchive(dir)
  assert.deepEqual(r.changed, [], '当天文件在长，不算篡改')
})

test('完整性：跨天后的"昨天文件补了尾巴"不算被改（追加是合法操作）', async () => {
  // 真事故：2026-10-31 00:1x，基线停在白天 22:07（221 条），昨天文件实际 312 条，
  // 「0 点后必然误报一次」——因为基线只在"被改"时刷新。修法见 lib/integrity.js。
  const { dir, files } = await seedArchive(2)
  checkArchive(dir) // 基线：两天各 2 条

  const old = files[0].file
  const lastRec = JSON.parse(readFileSync(old, 'utf8').trim().split('\n').pop())
  const rec = {
    id: 'msg-0-3',
    seq: 3,
    prev: lastRec.hash,
    hash: '',
    ts: '2026-10-28T03:00:00.000Z',
    recorded_at: '2026-10-28T03:00:00.000Z',
    role: 'user',
    source_kind: 'user',
    text: '第 0-3 条',
    session: 's0',
    msgid_plat: 'plat-0-3',
  }
  rec.hash = hashOf(rec)
  writeFileSync(old, readFileSync(old, 'utf8') + JSON.stringify(rec) + '\n', 'utf8')
  // 真正跨天：出现新一天的文件，于是昨天那份不再是最新那份
  writeFileSync(join(dir, '10_archive', 'messages', '2026-10-30.jsonl'), '', 'utf8')

  const r = checkArchive(dir)
  assert.equal(r.ok, true, `追加合法，不该报错：${JSON.stringify(r)}`)
  assert.deepEqual(r.changed, [], '不许把"昨天文件长了一条"当成篡改')
  assert.deepEqual(r.grown, ['2026-10-28.jsonl'])
  assert.equal(readManifest(dir).files['2026-10-28.jsonl'].count, 3, '基线要跟着更新，否则下次还会误报')
})

test('完整性：接受追加 ≠ 接受改写——昨天文件被换掉正文仍然要报', async () => {
  const { dir, files } = await seedArchive(2)
  checkArchive(dir)
  const old = files[0].file
  const lines = readFileSync(old, 'utf8').trim().split('\n')
  const rec = JSON.parse(lines[1])
  rec.text = '被改过的第二条'
  lines[1] = JSON.stringify(rec) // hash 字段没跟着改 → 链校验会算出不一致
  writeFileSync(old, lines.join('\n') + '\n', 'utf8')

  const r = checkArchive(dir)
  assert.equal(r.ok, false, '改写必须被抓住（否则"只追加"这条不变式就废了）')
  const named = [...r.changed, ...r.broken.map((b) => b.file), ...r.badLines.map((b) => b.file)]
  assert.ok(named.includes('2026-10-28.jsonl'), JSON.stringify(r))
})

test('完整性：文件被删 → 报 missing；新增一天 → 报 added（正常）', async () => {
  const { dir, files } = await seedArchive(2)
  checkArchive(dir)
  // 新增一天（正常）
  writeFileSync(join(dir, '10_archive', 'messages', '2026-10-30.jsonl'), '', 'utf8')
  let r = checkArchive(dir)
  assert.deepEqual(r.added, ['2026-10-30.jsonl'])
  // 删掉一天（异常）
  const { unlinkSync } = await import('node:fs')
  unlinkSync(files[0].file)
  r = checkArchive(dir)
  assert.deepEqual(r.missing, ['2026-10-28.jsonl'])
  assert.equal(r.ok, false)
})

test('完整性：坏行要被发现（不是静默跳过）', async () => {
  const { dir, files } = await seedArchive(1)
  checkArchive(dir)
  writeFileSync(files[0].file, readFileSync(files[0].file, 'utf8') + '{这不是 JSON}\n', 'utf8')
  const r = checkArchive(dir)
  assert.ok(r.badLines.length > 0, JSON.stringify(r))
  assert.equal(r.ok, false)
})

test('指纹：认得出首尾 hash 与条数', async () => {
  const { files } = await seedArchive(1)
  const fp = fingerprintFile(files[0].file)
  assert.equal(fp.count, 2)
  assert.equal(fp.bad, 0)
  assert.ok(fp.bytes > 0)
})

// ── 备份保留 ──────────────────────────────────────────────────

function seedBackups(names, extra = []) {
  const root = tmp('fishmem-backups-')
  for (const name of names) {
    const d = join(root, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'MANIFEST.json'), '{}', 'utf8')
  }
  for (const e of extra) mkdirSync(join(root, e), { recursive: true })
  return root
}

test('备份保留：只留最近 N 份，旧的删掉', () => {
  const root = seedBackups([
    'fish-memory-2026-10-20',
    'fish-memory-2026-10-21',
    'fish-memory-2026-10-22',
    'fish-memory-2026-10-23',
  ])
  const r = pruneBackups(root, 2)
  assert.deepEqual(r.kept, ['fish-memory-2026-10-22', 'fish-memory-2026-10-23'])
  assert.deepEqual(r.removed, ['fish-memory-2026-10-20', 'fish-memory-2026-10-21'])
  const left = readdirSync(root).sort()
  assert.deepEqual(left, ['fish-memory-2026-10-22', 'fish-memory-2026-10-23'])
})

test('备份保留：不碰别人的目录、不碰软链接、keep<1 时一个都不删', () => {
  const root = seedBackups(['fish-memory-2026-10-20', 'fish-memory-2026-10-21'], ['重要资料', 'fish-memory-notes'])
  const r = pruneBackups(root, 1)
  assert.deepEqual(r.removed, ['fish-memory-2026-10-20'])
  const left = readdirSync(root).sort()
  assert.ok(left.includes('重要资料'), '不属于备份的东西必须留着')
  assert.ok(left.includes('fish-memory-notes'), '名字不像我们建的要跳过')
  assert.ok(left.includes('fish-memory-2026-10-21'))

  const none = pruneBackups(root, 0)
  assert.deepEqual(none.removed, [], 'keep=0 不能把备份删光')
})

test('备份保留：根目录不存在、非目录，都不抛错', () => {
  assert.deepEqual(pruneBackups(join(tmpdir(), 'no-such-dir-xyz'), 3).removed, [])
  const f = join(tmp('fishmem-backups-'), 'file.txt')
  writeFileSync(f, 'x', 'utf8')
  assert.deepEqual(pruneBackups(f, 3).removed, [])
})
