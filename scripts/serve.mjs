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
 *   GET  /context?session=&q=&mode=daily|task   有界上下文 + 检索 + 状态
 *   POST /outcome {ability, result, note}        学习结果（显式回传）
 *
 * 不做：消息写入（等 QQ 适配器；写入路径要带 seq，不能随便开）。
 */

import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { assemble } from '../lib/render.js'
import { detectMode, layoutAbilities, rankAbilities, renderTools, scanAbilities } from '../lib/mode.js'
import { rankHybrid } from '../lib/retrieve.js'
import { SELF_TOPIC, latestSelf, renderSelfBlock } from '../lib/self.js'
import { statusOf } from '../lib/inspect.js'
import { estTokens } from '../lib/util.js'

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

function contextFor(session, q, forceMode) {
  const points = store.indexPoints()
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

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, dir })
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, statusOf(dir))
    if (req.method === 'GET' && url.pathname === '/context') {
      const q = url.searchParams.get('q') || ''
      const session = url.searchParams.get('session') || ''
      const mode = url.searchParams.get('mode') || undefined
      return json(res, 200, contextFor(session, q, mode))
    }
    if (req.method === 'POST' && url.pathname === '/outcome') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const o = JSON.parse(body || '{}')
          if (!o.ability) return json(res, 400, { error: 'ability is required' })
          mkdirSync(join(dir, '50_log'), { recursive: true })
          appendFileSync(
            join(dir, '50_log', 'ability.log'),
            JSON.stringify({ at: new Date().toISOString(), event: 'outcome', ...o }) + '\n',
            'utf8',
          )
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
