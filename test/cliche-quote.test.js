// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 套话检测的 v0.47.1 修正：**引文不计** + **回放基线**。
 *
 * 起因（实测）：第一版把她"在讨论套话"算成"在说套话"——一条回复里列了七族例句，
 * 一次命中七族，把 0/78 的基线写成 1/79。所以：
 *   ① 匹配前先剥掉代码块 / 行内代码 / 「」『』“”"" 里的内容；
 *   ② 剥完仍命中 ≥3 族 → 判为 meta（在讲这件事），单独记、不计入她的腔调；
 *   ③ 旧日志（v0.47.0 没有 meta 字段）读的时候按同一标准回推，不改数据；
 *   ④ `clicheReplay` 用档案里的历史终稿重算，给"加规则之前"的基线。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  META_FAMILY_MIN,
  clicheReplay,
  clicheStats,
  findCliches,
  noteCliche,
  stripQuoted,
} from '../lib/cliche.js'

const B = String.fromCharCode(96) // 反引号

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-cliche-'))
  for (const d of ['10_archive/messages', '20_state', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

function archive(dir, id, role, ts, text) {
  writeFileSync(join(dir, '10_archive/messages/s1.jsonl'), JSON.stringify({ id, seq: 1, role, ts, text }) + '\n', {
    flag: 'a',
  })
}

test('引文不计：行内代码 / 代码块 / 四种引号里的例句都不算', () => {
  const cases = [
    `她引用：${B}行，我认。${B}`,
    '他贴了「这句话稳」',
    `${B}${B}${B}\n我记下了。\n${B}${B}${B}`,
    '她把话放在引号里：“这话我不接”',
    '英文引号也是："你去，我跟"',
  ]
  for (const text of cases) assert.equal(findCliches(text).count, 0, `不该命中：${text.slice(0, 20)}`)
})

test('她真的这么说（无引号）→ 照常命中', () => {
  const h = findCliches('行，我认。这话我不接。')
  assert.equal(h.count, 2)
  assert.deepEqual(h.families, ['accept', 'refuse'])
})

test('stripQuoted 只剥引用，不动正文', () => {
  const s = stripQuoted('先认这个漏，然后「这话我不接」再说')
  assert.match(s, /先认这个漏/)
  assert.doesNotMatch(s, /这话我不接/)
})

test('meta：剥完仍命中 ≥3 族 → 判为在讲这件事', () => {
  const h = findCliches('回执（我记下了）、判词（这句话稳）、表态（你去，我跟）')
  assert.ok(h.count >= META_FAMILY_MIN)
  assert.equal(h.meta, true)
  assert.equal(META_FAMILY_MIN, 3)
})

test('noteCliche：meta 也写一行，但带 meta:true（以后能查假阳性有多少）', () => {
  const dir = fixture()
  const meta = noteCliche(dir, '回执（我记下了）、判词（这句话稳）、表态（你去，我跟）')
  assert.equal(meta.wrote, true)
  assert.equal(meta.meta, true)
  const real = noteCliche(dir, '行，我认。')
  assert.equal(real.meta, false)
})

test('统计：meta 行不计入命中，旧日志（没 meta 字段）按 ≥3 族回推', () => {
  const dir = fixture()
  noteCliche(dir, '回执（我记下了）、判词（这句话稳）、表态（你去，我跟）') // 新格式，meta:true
  writeFileSync(
    join(dir, '50_log/cliche.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), day: '2026-11-04', families: ['receipt', 'judge', 'permit', 'accept', 'refuse', 'pushback', 'interpret'] }) + '\n',
    { flag: 'a' },
  ) // 旧格式，无 meta，但 7 族
  noteCliche(dir, '行，我认。') // 真命中
  const st = clicheStats(dir, { days: 7 })
  assert.equal(st.hitTurns, 1, `真命中只该有 1 轮，实际 ${st.hitTurns}`)
  assert.equal(st.metaTurns, 2, `meta 应被单列出来，实际 ${st.metaTurns}`)
})

test('回放：用档案里的历史终稿重算（只读）', () => {
  const dir = fixture()
  archive(dir, 'a1', 'assistant', '2026-11-03T10:00:00Z', '行，我认。')
  archive(dir, 'a2', 'assistant', '2026-11-03T10:01:00Z', '今天下雨了，带伞。')
  archive(dir, 'a3', 'user', '2026-11-03T10:02:00Z', '行，我认。')
  const r = clicheReplay(dir, { days: 30, now: new Date('2026-11-04T00:00:00Z') })
  assert.equal(r.totalTurns, 2, '只数 assistant')
  assert.equal(r.all.hitTurns, 1)
  assert.equal(Math.round(r.all.rate * 100), 50)
})

test('回放 + 切点：加规则前后分开算', () => {
  const dir = fixture()
  archive(dir, 'b1', 'assistant', '2026-11-02T10:00:00Z', '行，我认。')
  archive(dir, 'b2', 'assistant', '2026-11-04T10:00:00Z', '今天下雨了，带伞。')
  archive(dir, 'b3', 'assistant', '2026-11-04T10:01:00Z', '这话我不接。')
  const r = clicheReplay(dir, { days: 30, split: '2026-11-04', now: new Date('2026-11-05T00:00:00Z') })
  assert.equal(r.before.turns, 1)
  assert.equal(r.before.hitTurns, 1)
  assert.equal(r.after.turns, 2)
  assert.equal(r.after.hitTurns, 1)
})
