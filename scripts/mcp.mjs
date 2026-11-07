// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * mcp.mjs — MCP 只读出口（v0.73.0，R5）。
 *
 * 为什么这是最便宜的杠杆：`@modelcontextprotocol/server-memory` 只有
 * entities / relations / observations 三个概念，周下载 29 万——
 * **能被 agent 直接调用的最小接口，比复杂的记忆算法更容易被采用。**
 *
 * 只实现 stdio + JSON-RPC 2.0 的四件事：`initialize` / `tools/list` / `tools/call` / `ping`。
 * 零依赖（只用 `node:readline` + 现成的 lib）。
 *
 * **只读**：四个工具全是查。写操作一律不暴露——要写走 `40_pending` 的现有闸门。
 * 这不是保守，是纪律：MCP 客户端会把它当"全知记忆"，
 * 一旦能写，任何一次乱调都会污染人格层。
 *
 * 用法：
 *   node scripts/mcp.mjs --dir <记忆库>
 *
 *   { "mcpServers": { "fish-memory": {
 *       "command": "node",
 *       "args": ["<插件目录>/scripts/mcp.mjs", "--dir", "<记忆库>"] } } }
 */

import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

import { MemoryStore } from '../lib/store.js'
import { assemble } from '../lib/render.js'
import { filterForScope } from '../lib/serveapi.js'
import { rankHybrid } from '../lib/retrieve.js'
import { searchArchive, searchPoints, renderRecall } from '../lib/recall.js'
import { evidenceOf, renderEvidence } from '../lib/evidence.js'
import { renderPoint } from '../lib/render.js'
import { readPointFiles } from '../lib/toolkit.js'
import { scopeOf, SCOPE_DM_MASTER, validateScope } from '../lib/scope.js'

const SERVER = { name: 'fish-memory', version: '0.73.0' }
const EMPTY_NOTE = '（这是本机记忆库：可能为空，也可能和你的问题无关。要细节用 memory_get。）'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const dir = resolve(arg('--dir', process.env.FISH_MEMORY_DIR || join(process.cwd(), 'fish-memory')))

const TOOLS = [
  {
    name: 'memory_search',
    description: '在本机记忆库里搜（记忆点 + 逐字档案）。返回 id 与摘要，不返回长正文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词或句子' },
        limit: { type: 'number', description: '最多几条（默认 8，上限 20）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: '按 id（M-… / E-…）取一条记忆点；也接受 seq:1203 展开一条档案消息。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'memory_context',
    description: '取当前会注入的上下文（核心层 + 关系状态 + 检索）。scope 不写就是主人私聊。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '可选：这条消息' },
        scope: { type: 'string', description: 'dm:master / group:<id> / global' },
      },
    },
  },
  {
    name: 'memory_evidence',
    description: '把一条记忆点的 source 逐条打回原文，并报档案链是否完好。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] })

function callTool(name, args = {}) {
  if (name === 'memory_search') {
    const q = String(args.query || '')
    if (!q.trim()) return text('（空查询）')
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 8))
    let points = []
    try {
      const store = new MemoryStore(dir)
      points = rankHybrid(store.indexPoints(), q, { threshold: 0.35, limit }).map((x) => x.point)
    } catch {
      /* 索引用不上就退回朴素检索 */
      points = searchPoints(dir, q, limit)
    }
    const archiveHits = (() => {
      try {
        return searchArchive(dir, q, { limit: 5 })
      } catch {
        return []
      }
    })()
    const lines = [`记忆点 ${points.length} 条`]
    for (const p of points) lines.push(`- ${p.id} · ${p.date || ''} ${p.title || ''}${p.summary ? `：${String(p.summary).slice(0, 60)}` : ''}`)
    if (archiveHits.length) {
      lines.push('', '档案原话：')
      // searchArchive 返回 {id, role, ts, excerpt}，不是 {seq,text}
      for (const m of archiveHits) lines.push(`- ${String(m.ts || '').slice(0, 16)} · ${m.role === 'assistant' ? '她' : '你'}：${String(m.excerpt || '').slice(0, 90)}`)
    }
    lines.push('', EMPTY_NOTE)
    return text(lines.join('\n'))
  }

  if (name === 'memory_get') {
    const id = String(args.id || '')
    if (!id) return text('（没给 id）')
    if (id.startsWith('seq:')) {
      const seq = Number(id.slice(4))
      const hit = (toolkit.readArchive(dir).messages || []).find((m) => m.seq === seq)
      return text(hit ? `seq:${seq} · ${hit.role === 'assistant' ? '她' : '你'}：${hit.text}` : `档案里没有 seq:${seq}`)
    }
    const p = readPointFiles(dir, '30_points').find((x) => x.id === id)
    if (!p) return text(`没有这条：${id}`)
    return text(`${renderPoint(p, 'full')}\n\n（source：${(p.source || []).join(', ') || '无'}）`)
  }

  if (name === 'memory_context') {
    const raw = args.scope ? String(args.scope) : SCOPE_DM_MASTER
    const v = validateScope(raw)
    if (!v.ok) return text(`scope 不合法：${raw}`)
    const q = String(args.q || '')
    try {
      const store = new MemoryStore(dir)
      const points = filterForScope(store.indexPoints(), v.scope)
      const r = assemble({
        store,
        query: q,
        sessionId: '',
        mode: 'daily',
        ability: '',
        retrieve: () => {
          const picked = rankHybrid(points, q, { threshold: 0.8, limit: 20, weight: (p) => store.memoryWeight(p) })
          return { picked: picked.slice(0, 3).map((x) => store.fullPoint(x.point)).filter(Boolean), filtered: [] }
        },
        scope: v.scope,
        now: new Date(),
      })
      return text(`${r.text}\n\n（本机库；scope=${v.scope}）`)
    } catch (e) {
      return text(`组装失败（库可能还不完整）：${e?.message || e}`)
    }
  }

  if (name === 'memory_evidence') {
    return text(renderEvidence(evidenceOf(dir, String(args.id || ''))))
  }

  throw new Error(`不认识的工具：${name}`)
}

import * as toolkit from '../lib/toolkit.js'

function handle(msg) {
  const { id, method, params } = msg
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    return ok({
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions:
        '本机记忆库（可能为空）。只读：memory_search / memory_get / memory_context / memory_evidence。' +
        '写操作请走 fish-memory 的 40_pending 闸门，不在这里做。',
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
  if (method === 'ping') return ok({})
  if (method === 'tools/list') return ok({ tools: TOOLS })
  if (method === 'tools/call') {
    try {
      return ok(callTool(params?.name, params?.arguments || {}))
    } catch (e) {
      return ok({ content: [{ type: 'text', text: `出错：${e?.message || e}` }], isError: true })
    }
  }
  return err(-32601, `不支持的方法：${method}`)
}

// 只在**被当脚本跑**时开 stdio 循环（被测试 import 时不抢 stdin）
const isMain = process.argv[1] && /mcp\.mjs$/.test(process.argv[1]) && !process.env.NODE_TEST_CONTEXT
if (isMain) {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let msg
    try {
      msg = JSON.parse(t)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`)
      return
    }
    const out = handle(msg)
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  })
}

export { TOOLS, handle, callTool }
