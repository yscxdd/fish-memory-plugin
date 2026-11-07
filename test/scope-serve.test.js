// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * A3 + A4（v0.71.0）。
 *
 * A3：隔离一直只做了**读侧**。写侧没人给点标归属，而缺省是 `global`——
 * 接群那天，私聊点的**标题**会跟着索引行进群（\`private\` 只降到索引行，标题仍是隐私）。
 *
 * A4：本地 HTTP 服务对**本机任何进程**都敞开：\`/context\` 返回整段注入文本，
 * \`/outcome\` 没有 body 上限、还能用 \`...o\` 覆盖 \`event\` 字段，也不校验 Host
 * （只绑回环挡不住 DNS rebinding）。
 *
 * 这些测试都用**外部可观察量**：HTTP 状态码、注入文本里有没有别人的标题、日志文件内容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { filterByScope, scopeOf, stampScope, visible } from '../lib/scope.js'
import { readPointFiles } from '../lib/toolkit.js'

const point = (dir, { id, scope = null, visibility = 'private', title = '他不喜欢被丢下' }) => {
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'date: 2026-11-06',
    'type: event',
    'cluster: 日常',
    'salience: 3',
    'origin: told',
    'status: active',
    `visibility: ${visibility}`,
    ...(scope ? [`scope: ${scope}`] : []),
    'source: ["msg-1-abcdef"]',
    'links: []',
    '---',
    '',
    '<!-- SUM -->',
    title,
    '<!-- /SUM -->',
    '',
    '正文。',
  ].join('\n')
  writeFileSync(join(dir, '30_points', `${id}.md`), fm, 'utf8')
}

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-a3-'))
  for (const d of ['00_core', '10_archive/messages', '20_state', '30_points', '40_pending', '50_log']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

// ── A3 ─────────────────────────────────────────────────────────
test('A3：没有 scope 的点缺省就是 global（这就是漏洞本身）', () => {
  const dir = lib()
  point(dir, { id: 'M-2026-11-06-001' })
  const ps = readPointFiles(dir, '30_points')
  assert.equal(scopeOf(ps[0]), 'global')
  assert.equal(visible(ps[0], 'group:12345'), true, '群作用域里居然可见')
})

test('A3：stamp 之后群作用域看不见私聊点（标题不再进群）', () => {
  const dir = lib()
  point(dir, { id: 'M-2026-11-06-001', title: '他怕被丢下' })
  point(dir, { id: 'M-2026-11-06-002', title: '他妈妈生病了' })
  const r = stampScope(dir, 'dm:master')
  assert.equal(r.stamped, 2)

  const ps = readPointFiles(dir, '30_points')
  for (const p of ps) assert.equal(scopeOf(p), 'dm:master')
  const inGroup = filterByScope(ps, 'group:12345')
  assert.equal(inGroup.length, 0, `群里不该看见任何私聊点，实际 ${inGroup.map((p) => p.title).join('、')}`)
  const inDm = filterByScope(ps, 'dm:master')
  assert.equal(inDm.length, 2, '私聊该都看得见')
})

test('A3：stamp 只碰缺 scope 的点，并且留了日志', () => {
  const dir = lib()
  point(dir, { id: 'M-2026-11-06-001' })
  point(dir, { id: 'M-2026-11-06-002', scope: 'group:99999' })
  const r = stampScope(dir, 'dm:master')
  assert.equal(r.stamped, 1)
  assert.equal(r.skipped, 1, '已有 scope 的不该被覆盖')

  const log = readFileSync(join(dir, '50_log/scope-stamp.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log.length, 1)
  assert.equal(log[0].scope, 'dm:master')
  assert.ok(log[0].before && log[0].after, '日志要有改动前后指纹')
})

test('A3：stamp 之后再跑一次是幂等的（0 个要补）', () => {
  const dir = lib()
  point(dir, { id: 'M-2026-11-06-001' })
  assert.equal(stampScope(dir, 'dm:master').stamped, 1)
  assert.equal(stampScope(dir, 'dm:master').stamped, 0)
})

test('A3：技能模板里必须有 scope / visibility 两行（写侧从出生就带归属）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /`scope`/, '模板里没有 scope 这一行')
  assert.match(src, /`visibility`/, '模板里没有 visibility 这一行')
})

// ── A4 ─────────────────────────────────────────────────────────
const SERVE = new URL('../scripts/serve.mjs', import.meta.url)

test('A4：serve 有 Host 白名单（DNS rebinding 挡在门外）', () => {
  const src = readFileSync(SERVE, 'utf8')
  assert.match(src, /OK_HOSTS/)
  assert.match(src, /forbidden host/)
})

test('A4：serve 支持 token（配了才启用），没配保持现在的手感', () => {
  const src = readFileSync(SERVE, 'utf8')
  assert.match(src, /FISH_MEMORY_TOKEN/)
  assert.match(src, /Bearer/)
  assert.match(src, /unauthorized/)
})

test('A4：/outcome 有 body 上限，且 event 字段不可被覆盖', () => {
  const src = readFileSync(SERVE, 'utf8')
  assert.match(src, /MAX_BODY/)
  assert.match(src, /413/)
  // `...o` 必须在 `event: 'outcome'` 之前
  const idx = src.indexOf("{ ...o, at:")
  assert.ok(idx > 0, '写法应该是 { ...o, at, event }（o 在前）')
  assert.ok(src.indexOf("event: 'outcome'") > idx)
})

test('A4：真的起服务试三条边界（Host / body / event）', async () => {
  const dir = lib()
  const { spawn } = await import('node:child_process')
  const http = await import('node:http')
  const port = 18000 + (process.pid % 500)
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--dir', dir, '--port', String(port)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'ignore',
    env: { ...process.env, FISH_MEMORY_TOKEN: 'secret-token' },
  })

  // fetch 不允许改 Host 头（undici 会忽略），所以这里用裸 http 请求
  const req = ({ method = 'GET', path = '/health', headers = {}, body = null }) =>
    new Promise((resolve, reject) => {
      let settled = false
      const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          settled = true
          resolve({ status: res.statusCode, body: data })
        })
      })
      r.on('error', (e) => {
        // 服务端在我们发大 body 时可能先结束连接：已经拿到响应就不算错
        if (settled) return
        reject(e)
      })
      if (body) r.write(body)
      r.end()
    })

  const wait = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await req({ headers: { authorization: 'Bearer secret-token' } })
        if (r.status === 200) return true
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  try {
    assert.equal(await wait(), true, '服务没起来')

    const noAuth = await req({})
    assert.equal(noAuth.status, 401, '配了 token 就必须要求 Authorization')

    // Host 头必须是回环：挡 DNS rebinding
    const badHost = await req({ headers: { authorization: 'Bearer secret-token', host: 'evil.com' } })
    assert.equal(badHost.status, 403, `Host 不是回环必须拒，实际 ${badHost.status}`)

    const ok = await req({ headers: { authorization: 'Bearer secret-token' } })
    assert.equal(ok.status, 200)

    // body 上限
    const big = await req({
      method: 'POST',
      path: '/outcome',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'text/plain' },
      body: 'x'.repeat(70 * 1024),
    })
    assert.equal(big.status, 413, `超过 64KB 必须 413，实际 ${big.status}`)

    // event 字段不可被覆盖
    const spoof = await req({
      method: 'POST',
      path: '/outcome',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ability: 'x', event: 'erased-everything' }),
    })
    assert.equal(spoof.status, 200)
    const log = readFileSync(join(dir, '50_log/ability.log'), 'utf8')
    assert.ok(log.includes('"event":"outcome"'), '事件字段要固定为 outcome')
    assert.ok(!log.includes('erased-everything'), 'o.event 不许覆盖 event 字段')
  } finally {
    child.kill()
  }
})
