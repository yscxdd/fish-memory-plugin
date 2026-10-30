// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * pressure.js — 上下文压力保护。
 *
 * 到限时宿主会压缩历史，原文被摘要替换。我们抢在压缩前把当前段落的原文包
 * 落到 40_pending/_segments/，并在下一轮注入里提醒先压。
 * 不调模型、不自动改库：只保证"包先存在"。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readContextWindow } from './host.js'
import { readArchive, renderDigest, splitSegments } from './toolkit.js'

/**
 * 从 tokenMeter.measure() 的返回里取"用量"，分母单独给。
 *
 * 宿主契约里 `TokenMeasurement` 只有
 *   { logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }
 * ——**没有上限字段**。所以上限必须由调用方提供（`session.requestContext().contextWindow`
 * 或配置 `pressure.contextWindow`）。v0.4.2 之前在测量结果里找 contextWindow，
 * 恒为 undefined，于是压力保护从来没触发过。
 */
export function pressureRatio(m, contextWindow) {
  if (!m || typeof m !== 'object') return null
  const used =
    m.totalTokens ?? m.used ?? m.inputTokens ?? m.tokens ?? m.usage?.totalTokens ?? m.promptTokens
  const limit =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : m.contextWindow ?? m.limit ?? m.maxTokens ?? m.window ?? m.context?.window ?? m.usage?.contextWindow
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) return used / limit
  return null
}

/**
 * 这一轮的上下文窗口大小：会话请求上下文优先，其次配置，最后环境变量。
 * 都拿不到就返回 null（宁可不报压力，也不瞎报）。
 *
 * 宿主那一读（`session.requestContext()`）在 `lib/host.js` 的 readContextWindow 里
 * （[HOST: session-context-window]）——版更时只改那里，这里只管优先级。
 */
export function contextWindowOf(session, fallback) {
  const fromHost = readContextWindow(session)
  if (fromHost) return fromHost
  const fromConfig = Number(fallback)
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig
  const fromEnv = Number(process.env.FISH_MEMORY_CONTEXT_WINDOW)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return null
}

/** 最近一个还没打 .done 的段落 */
export function latestOpenSegment(dir) {
  const { messages } = readArchive(dir)
  const { segments } = splitSegments(messages)
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!existsSync(join(dir, '40_pending', '_segments', `${segments[i].id}.done`))) return segments[i]
  }
  return null
}

/** 确保当前段有原文包；已存在就不重写 */
export function ensureSegmentPacket(dir) {
  const seg = latestOpenSegment(dir)
  if (!seg) return null
  const outDir = join(dir, '40_pending', '_segments')
  mkdirSync(outDir, { recursive: true })
  const md = join(outDir, `${seg.id}.md`)
  if (existsSync(md)) return { id: seg.id, wrote: false, path: md }
  writeFileSync(md, renderDigest(seg), 'utf8')
  return { id: seg.id, wrote: true, path: md }
}

/** 下一轮注入时贴在最前面（不占正文预算） */
export function pressureNote(ratio) {
  const pct = ratio == null ? '' : `（已用 ${Math.round(ratio * 100)}%）`
  return [
    '<!-- 上下文压力 -->',
    `这一轮上下文快满了${pct}。宿主压缩会覆盖细节。`,
    '如果这段有值得记的事，先压：`memory digest --write`，再写草稿、`ingest`。',
    '<!-- /上下文压力 -->',
  ].join('\n')
}
