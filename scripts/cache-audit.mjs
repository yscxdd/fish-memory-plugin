// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * cache-audit.mjs — 只读地回答"宿主到底有没有缓存、命中率多少"。
 *
 * 为什么不在 lib/ 里：它是诊断工具，不进插件运行时；且要解 zstd 多帧（v0.49.1 起用 node:zlib 内置实现，零依赖）。
 *
 * 读的是 DSH 的会话日志（`~/.dsh` → `sessions/<工作区>/<会话>/session.v4.jsonl.zstd`），
 * 每行一个事件，其中 `assistant/message` 的 `data.usage` 带：
 *   inputTokens（**未缓存**输入） / cacheReadTokens / cacheWriteTokens / outputTokens
 *
 * 命中率 = ΣcacheRead / Σ(cacheRead + input)。
 * **不要对逐轮比率取平均**——短请求会把均值带偏，必须先把分子分母各自求和。
 *
 * 用法：
 *   node scripts/cache-audit.mjs --session <x.jsonl[.zstd]>   # 内置解压，不需要 fzstd
 *                                [--block <记忆库目录>] [--json]
 *
 * 它不解压到磁盘、不写任何文件、不联网。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 解**多帧拼接**的 zstd（v0.49.1 修）。
 *
 * 为什么需要：DSH 的会话日志是**一次追加一帧**，整个文件是几千个帧首尾相接。
 * `zstdDecompressSync()` 只解第一帧（实测：15MB 的文件只解出 250 字节的头部）。
 * 实测这台机器上既没有 npm 也没有 fzstd，所以原文档那条 `--fzstd` 路径跑不起来。
 *
 * 做法：扫帧魔数 `28 B5 2F FD`，逐帧试解；解不出就往后挪 4 字节。
 * 零依赖、270ms 解完 15MB（12505 帧）。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
export function decompressAllFrames(buf) {
  const parts = []
  let pos = 0
  let frames = 0
  while (pos < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, pos)
    if (idx < 0) break
    try {
      const out = zstdDecompressSync(buf.subarray(idx))
      if (out.length) {
        parts.push(out)
        frames += 1
      }
    } catch {
      /* 不是真帧头（可能是压缩数据里的巧合），往后挪 */
    }
    pos = idx + 4
  }
  return { buffer: Buffer.concat(parts), frames }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name) => process.argv.includes(`--${name}`)

const src = arg('session')
if (!src) {
  console.error('用法：node scripts/cache-audit.mjs --session <会话文件> [--fzstd <fzstd 路径>] [--block <记忆库>] [--json]')
  process.exit(2)
}

function readSession(path, fzstdPath) {
  const buf = readFileSync(path)
  if (!path.endsWith('.zstd')) return buf.toString('utf8')
  if (buf.subarray(0, 4).toString('hex') !== '28b52ffd') throw new Error(`${path} 不是 zstd 帧`)
  if (!fzstdPath && !process.env.ALLOW_NATIVE_ZSTD) {
    // 内置解压已经能跑；只有它失败时才需要 fzstd
  }
  if (false) {
    throw new Error(
      '这个是 zstd 压缩的。两种办法：\n' +
        '  1) npm i fzstd，再加 --fzstd <项目>/node_modules/fzstd/umd/index.js\n' +
        '  2) 先用别的工具转成明文 .jsonl，再把它传给 --session'
    )
  }
  // 先用内置多帧解压（零依赖）；解不出才退回 fzstd
  try {
    const { buffer } = decompressAllFrames(buf)
    if (buffer.length) return buffer.toString('utf8')
  } catch {
    /* 落到 fzstd */
  }
  const mod = require(fzstdPath)
  return Buffer.from(mod.decompress(buf)).toString('utf8')
}
// 本文件是 ESM，require 得自己造一个——只为了不把 fzstd 变成硬依赖。
const require = createRequire(import.meta.url)

const text = readSession(src, arg('fzstd'))
const events = []
for (const line of text.split('\n')) {
  if (!line) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* 坏行跳过：日志坏了不该让审计崩 */
  }
}

const usages = []
const headers = []
const queries = []
for (const e of events) {
  if (e.type === 'assistant/message' && e.data?.usage) {
    const u = e.data.usage
    usages.push({ input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, cacheWrite: u.cacheWriteTokens || 0, out: u.outputTokens || 0 })
  }
  if (e.type === 'request/header' && e.data?.header?.config) headers.push(e.data.header.config)
  if (e.type === 'user/message' && e.data) {
    const c = e.data.message?.content ?? e.data.content ?? []
    const t = Array.isArray(c) ? c.map((x) => x.text || '').join('') : String(c)
    if (t && !t.startsWith('<') && t.length < 400) queries.push(t)
  }
}

const sum = (xs, k) => xs.reduce((n, r) => n + r[k], 0)
const input = sum(usages, 'input')
const cacheRead = sum(usages, 'cacheRead')
const cacheWrite = sum(usages, 'cacheWrite')
const prompt = usages.map((u) => u.input + u.cacheRead).sort((a, b) => a - b)
const uncached = usages.map((u) => u.input).sort((a, b) => a - b)
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0)

const report = {
  session: src,
  model: headers.at(-1)?.model || headers[0]?.model || null,
  provider: headers.at(-1)?.provider || headers[0]?.provider || null,
  turns: usages.length,
  cacheHitRate: cacheRead + input > 0 ? cacheRead / (cacheRead + input) : 0,
  zeroCacheTurns: usages.filter((u) => u.cacheRead === 0).length,
  promptTokens: { p10: q(prompt, 0.1), p50: q(prompt, 0.5), p90: q(prompt, 0.9), max: q(prompt, 1) },
  uncachedTokens: { p50: q(uncached, 0.5), p90: q(uncached, 0.9) },
  cacheWriteTokens: cacheWrite,
}

// ── 注入块字节稳定性（B6 第一步）───────────────────────────────
const blockDir = arg('block')
if (blockDir && queries.length) {
  const { MemoryStore } = await import('../lib/store.js')
  const { assemble } = await import('../lib/render.js')
  const { bigrams, pickByEvent, rank } = await import('../lib/retrieve.js')
  const { estTokens } = await import('../lib/util.js')
  const store = new MemoryStore(blockDir)
  const texts = []
  for (const query of queries.slice(0, 80)) {
    const r = assemble({
      store,
      query,
      sessionId: 'cache-audit',
      retrieve: ({ points }) => pickByEvent(rank(points, bigrams(query), { threshold: 0.8 }), 3),
    })
    texts.push({ text: r.text, tokens: r.tokens.total })
  }
  const lcp = (a, b) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  let identical = 0
  let lost = []
  for (let i = 1; i < texts.length; i++) {
    if (texts[i].text === texts[i - 1].text) {
      identical++
      continue
    }
    const n = lcp(texts[i - 1].text, texts[i].text)
    const reusable = Math.floor(estTokens(texts[i - 1].text.slice(0, n)) / 64) * 64
    lost.push(Math.max(0, texts[i].tokens - reusable))
  }
  report.block = {
    turns: texts.length,
    identicalAdjacent: identical,
    changedAdjacent: texts.length - 1 - identical,
    lostTokensMedian: q(lost.sort((a, b) => a - b), 0.5) || 0,
    injectedTokensMedian: q(texts.map((t) => t.tokens).sort((a, b) => a - b), 0.5),
  }
}

if (has('json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
console.log(`会话 ${src.split(/[\\/]/).slice(-2, -1)[0]}`)
console.log(`路由 ${report.provider || '-'} / ${report.model || '-'}`)
console.log(`轮次 ${report.turns}   零缓存轮 ${report.zeroCacheTurns}`)
console.log(`缓存命中率 ${pct(report.cacheHitRate)}（Σ缓存读 / Σ(缓存读+未缓存输入)）`)
console.log(`每轮提示词 tok: p10 ${report.promptTokens.p10}  p50 ${report.promptTokens.p50}  p90 ${report.promptTokens.p90}  max ${report.promptTokens.max}`)
console.log(`每轮未命中 tok: p50 ${report.uncachedTokens.p50}  p90 ${report.uncachedTokens.p90}`)
if (report.block) {
  const b = report.block
  console.log(`\n注入块（${b.turns} 轮）：相邻轮逐字相同 ${b.identicalAdjacent}，变化 ${b.changedAdjacent}`)
  console.log(`注入总量中位 ${b.injectedTokensMedian} tok；变化时丢的 token 中位 ${b.lostTokensMedian}`)
}
