// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 隐私脱敏（v0.31.0）——补一个真漏洞。
 *
 * 档案是**逐字只追加**的：他随手把 API key / 手机号 / 身份证贴进对话，那条就永久躺在库里。
 * 现在两条路都堵上：
 *   ① 入库前脱敏（`buildRecord`）：从此档案里没有明文；
 *   ② `redactArchive()` 扫旧档案（维护操作，会改档案——契约 §11 #1 的第三个例外）。
 *
 * 三个必须成立的：
 *   · 幂等（同一段文字重复脱敏结果不变）
 *   · 保留关键词（`密码：xxx` → `密码：[脱敏:凭据]`，不能把「密码」吞掉）
 *   · 不误伤普通数字（日期、42、2026-11-02 不该被改）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasSecret, hitsSummary, redactText } from '../lib/redact.js'
import { buildRecord, redactArchive, verifyChain } from '../lib/archive.js'

test('手机号 / 身份证 / 邮箱 / 卡号 都被换掉', () => {
  assert.equal(redactText('电话 13812345678').text, '电话 [脱敏:手机号]')
  assert.equal(redactText('身份证 110105199003071234').text, '身份证 [脱敏:身份证]')
  assert.equal(redactText('邮箱 abc.def@example.com').text, '邮箱 [脱敏:邮箱]')
  assert.equal(redactText('卡号 6222021234567890123').text, '卡号 [脱敏:银行卡]')
})

test('API 密钥 / 长 hex / 凭据关键词', () => {
  assert.match(redactText('key sk-abcdef1234567890abcdef').text, /\[脱敏:API密钥\]/)
  // 裸十六进制不脱敏（真库里 17 处命中全是 sha256 校验和）
  const bareHex = 'sha256 0123456789abcdef0123456789abcdef'
  assert.equal(redactText(bareHex).text, bareHex)
  // 但跟着关键词就要脱
  assert.equal(redactText('api_key = 0123456789abcdef0123456789abcdef').text, 'api_key = [脱敏:凭据]')
  // 保留关键词，只换值
  assert.equal(redactText('密码：hunter2hunter2').text, '密码：[脱敏:凭据]')
  assert.equal(redactText('我的密码是 abc12345').text, '我的密码是 [脱敏:凭据]')
  assert.equal(redactText('token: ghp_abcdefghijklmnopqrstuvwxyz1234').text, 'token: [脱敏:API密钥]')
})

test('不误伤：日期 / 小数字 / 普通句子', () => {
  const s = '这一行没有敏感信息，只有 2026-11-02 和 42，还有 3 个苹果。'
  assert.equal(redactText(s).text, s)
  assert.equal(hasSecret(s), false)
})

test('幂等：脱敏两次结果一样', () => {
  const once = redactText('电话 13812345678，密码：hunter2hunter2').text
  const twice = redactText(once).text
  assert.equal(twice, once)
})

test('hitsSummary 给出人读的统计', () => {
  const { hits } = redactText('13812345678 和 13900001111 和 13800002222')
  assert.equal(hitsSummary(hits), '手机号×3')
})

test('buildRecord：入库前就脱敏（档案里不会有明文）', () => {
  const event = {
    type: 'user/message',
    seq: 7,
    time: Date.parse('2026-11-02T10:00:00Z'),
    data: { id: 'plat-abcdef', source: { kind: 'user' }, content: [{ type: 'text', text: '我的手机号 13812345678' }] },
  }
  const rec = buildRecord('sess-1', event)
  assert.ok(rec, '应当能建档')
  assert.equal(rec.text, '我的手机号 [脱敏:手机号]')
  assert.deepEqual(rec.redacted, [{ kind: '手机号', count: 1 }])
})

test('redactArchive：旧档案被清干净，且链还能验过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-redact-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  mkdirSync(join(dir, '50_log'), { recursive: true })
  const file = join(dir, '10_archive/messages/2026-11-02.jsonl')
  const mk = (id, seq, text, prev, hash) => JSON.stringify({ id, seq, prev, hash, ts: '2026-11-02T10:00:00.000Z', role: 'user', source_kind: 'user', text, session: 's', msgid_plat: id, turn: null, step: null, part: '1/1', reply_to: null, recalled: false, backfilled: false })
  writeFileSync(file, [mk('msg-1', 1, '号码 13812345678', 'genesis', 'aaa'), mk('msg-2', 2, '普通一行', 'aaa', 'bbb')].join('\n') + '\n', 'utf8')

  const dry = redactArchive(dir, { dry: true })
  assert.equal(dry.changed, 1)
  assert.match(readFileSync(file, 'utf8'), /13812345678/, 'dry 不该写盘')

  const done = redactArchive(dir)
  assert.equal(done.changed, 1)
  const text = readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /13812345678/, '明文要清掉')
  assert.match(text, /\[脱敏:手机号\]/)

  const recs = text.trim().split('\n').map((l) => JSON.parse(l))
  const v = verifyChain(recs)
  assert.equal(v.ok, true, JSON.stringify(v.errors || v))

  const log = readFileSync(join(dir, '50_log/redaction.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log.length, 1)
  assert.equal(log[0].changed, 1)
  assert.equal(log[0].hits[0].kind, '手机号')
})

test('redactArchive：没有敏感内容时不动文件、不写日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-redact2-'))
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  const file = join(dir, '10_archive/messages/2026-11-02.jsonl')
  const raw = JSON.stringify({ id: 'msg-1', seq: 1, prev: 'genesis', hash: 'x', ts: '2026-11-02T10:00:00.000Z', role: 'user', source_kind: 'user', text: '普通一行', session: 's', msgid_plat: 'msg-1' }) + '\n'
  writeFileSync(file, raw, 'utf8')
  const r = redactArchive(dir)
  assert.equal(r.changed, 0)
  assert.equal(readFileSync(file, 'utf8'), raw)
})
