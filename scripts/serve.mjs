#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * serve.mjs — 本地记忆服务（读接口 + 学习结果接口）。
 *
 * 定位：真相仍是文件；这个进程只是给别的客户端（QQ/桌面/CLI）一个稳定入口。
 * 现在提供：
 *   GET  /health
 *   GET  /status
 *   GET  /context?session=&q=&mode=&scope=   有界上下文 + 检索 + 状态（scope 缺省 = dm:master）
 *   GET  /today                                "她今天"一屏（只读；给 /dashboard 用）
 *   GET  /dashboard                            她自己的一页（2 秒自动刷新，仅本机）
 *   GET  /scope?channelType=&groupId=&senderId=&masterIds=&homeGroups=&memberRole=
 *                                            "这条消息属于谁"（只判归属，不写任何东西）
 *   POST /outcome {ability, result, note}        学习结果（显式回传）
 *
 * 不做：消息写入（等 QQ 适配器；写入路径要带 seq，不能随便开）。
 */

import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { assemble } from '../lib/render.js'
import { filterForScope, parseContextQuery, scopeAnswer } from '../lib/serveapi.js'
import { renderDashboardHtml } from './dashboard-html.mjs'
import { todayView } from '../lib/today.js'
import { detectMode, layoutAbilities, rankAbilities, renderTools, scanAbilities } from '../lib/mode.js'
import { rankHybrid } from '../lib/retrieve.js'
import { SELF_TOPIC, latestSelf, renderSelfBlock } from '../lib/self.js'
import { statusOf } from '../lib/inspect.js'
import { estTokens, rotateLog } from '../lib/util.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const dir = resolve(arg('--dir', join(process.cwd(), 'fish-memory')))
const port = Number(arg('--port', 8787))
const store = new MemoryStore(dir, { logger: console })

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function contextFor(session, q, forceMode, scope = 'dm:master') {
  // v0.59.0：按 scope 过滤（真要进群时，通道把 scope 传进来即可）
  const points = filterForScope(store.indexPoints(), scope)
  const mode = forceMode || detectMode(q, { lastAssistantText: '' }).mode
  const picked = rankHybrid(points, q, { threshold: 0.8, limit: 20, weight: (p) => store.memoryWeight(p) })
    .slice(0, 3)
    .map((x) => store.fullPoint(x.point))
    .filter(Boolean)

  let ability = ''
  if (mode === 'task') {
    const laid = layoutAbilities(rankAbilities(scanAbilities(dir), q), 2400)
    const tools = renderTools(dir)
    const inner = [tools, laid.text].filter(Boolean).join('\n\n')
    if (inner) ability = `<!-- 你会做的事 -->\n${inner}\n<!-- /你会做的事 -->`
  }

  const r = assemble({ store, query: q, sessionId: session || '', mode, ability, retrieve: () => picked })
  let text = r.text

  // 有界上下文：最近 3 轮（6 条），只用来接话，不是记忆
  const s = session ? store.session(session) : null
  if (s?.tail?.length) {
    const tail = s.tail.slice(-6).map((m) => `${m.role === 'assistant' ? '她' : '你'}：${m.text}`)
    text = `<!-- 最近几轮（只用于接话） -->\n${tail.join('\n')}\n<!-- /最近几轮 -->\n\n${text}`
  }

  if (SELF_TOPIC.test(q)) {
    const self = latestSelf(dir)
    if (self) text = `${text}\n\n${renderSelfBlock(self.slice(0, 1600))}`
  }

  return { text, mode, rendered: r.rendered, tokens: estTokens(text) }
}

/**
 * A4（v0.71.0）：这个服务原来对**本机任何进程**都敞开。
 *
 * 三件事一起做才有意义：
 *   ① `FISH_MEMORY_TOKEN` 配了就要求 `Authorization: Bearer <token>`（不配保持现在的手感）；
 *   ② `Host` 必须是 127.0.0.1 / localhost —— 只绑回环**挡不住 DNS rebinding**：
 *      恶意网页把域名解析到 127.0.0.1，浏览器就能打这个接口（/outcome 用 text/plain 是简单请求，不预检）；
 *   ③ body 上限 64KB + 自造事件字段（`event` 不许被覆盖）。
 */
const TOKEN = process.env.FISH_MEMORY_TOKEN || ''
const MAX_BODY = 64 * 1024
const OK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostAllowed(req) {
  const h = String(req.headers.host || '')
  const name = h.replace(/:\d+$/, '').toLowerCase()
  return OK_HOSTS.has(name)
}

function authAllowed(req) {
  if (!TOKEN) return true
  const got = String(req.headers.authorization || '')
  return got === `Bearer ${TOKEN}`
}

const server = createServer((req, res) => {
  try {
    // A4：先挡 Host（DNS rebinding），再挡 token（可选）
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' })
    if (!authAllowed(req)) return json(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, dir })
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { ...statusOf(dir), scope: process.env.FISH_MEMORY_SCOPE || 'dm:master' })
    if (req.method === 'GET' && url.pathname === '/context') {
      const parsed = parseContextQuery(url.searchParams)
      if (!parsed.ok) return json(res, parsed.status, { error: parsed.error })
      const body = contextFor(parsed.session, parsed.q, parsed.mode, parsed.scope)
      return json(res, 200, { ...body, scope: parsed.scope })
    }
    if (req.method === 'GET' && url.pathname === '/today') {
      return json(res, 200, todayView(dir))
    }
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      const html = renderDashboardHtml()
      // CSP（v0.78.2）：这一页是我们自己拼的 HTML，但**数据来自记忆库**——
      // 万一哪天有人把抓来的网页内容写进记忆点，CSP 是"就算混进去也跑不起来"的那层。
      // 只允许自己的 /today 端点，禁 inline script 之外的任何外连。
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }
    if (req.method === 'GET' && url.pathname === '/scope') {
      const sp = url.searchParams
      return json(
        res,
        200,
        scopeAnswer({
          channelType: sp.get('channelType'),
          groupId: sp.get('groupId'),
          senderId: sp.get('senderId'),
          masterIds: sp.get('masterIds'),
          homeGroups: sp.get('homeGroups'),
          memberRole: sp.get('memberRole'),
        }),
      )
    }
    if (req.method === 'POST' && url.pathname === '/outcome') {
      let body = ''
      let tooBig = false
      req.on('data', (c) => {
        if (tooBig) return
        body += c
        // A4：没有上限的话，本机一个循环就能把内存撑爆
        if (body.length > MAX_BODY) {
          tooBig = true
          body = ''
          json(res, 413, { error: `body 太大（上限 ${MAX_BODY} 字节）` })
          // 丢掉剩下的数据但不掐连接：直接 destroy 会先断在响应 flush 之前，
          // 客户端看到的是 ECONNRESET，而不是我们要传达的 413。
          req.resume()
        }
      })
      req.on('end', () => {
        if (tooBig) return
        try {
          const o = JSON.parse(body || '{}')
          if (!o.ability) return json(res, 400, { error: 'ability is required' })
          mkdirSync(join(dir, '50_log'), { recursive: true })
          const abilityLog = join(dir, '50_log', 'ability.log')
          appendFileSync(
            abilityLog,
            // A4：`...o` 放前面——以前 o.event 能覆盖掉 event 字段，账本可以被污染成任意 event
            JSON.stringify({ ...o, at: new Date().toISOString(), event: 'outcome' }) + '\n',
            'utf8',
          )
          // A12（v0.74.0）：这个文件只有 HTTP 在写，不轮转就会一直长
          rotateLog(abilityLog)
          json(res, 200, { ok: true })
        } catch (e) {
          json(res, 400, { error: String(e?.message || e) })
        }
      })
      return
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fish-memory 服务：http://127.0.0.1:${port}  dir=${dir}`)
})
