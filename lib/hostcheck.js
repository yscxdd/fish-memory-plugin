// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * hostcheck.js — 对着「宿主口子」做静态体检。
 *
 * 它能查的：口子清单与代码里的 `[HOST: …]` 标记是否一一对应、
 *           `lib/` 下有没有人绕过 host.js 直接调 `ctx.`、
 *           宿主缺能力时会不会炸（拿假 ctx 逐个抠掉试）。
 * 它**查不了**的：事件名有没有被改、消息形状有没有变——那只能靠跑，
 *           所以真正的那半在 `50_log/host.log`（每次加载一行 + channel-gap 告警）。
 *
 * 为什么值得单独写：版更之后，"她失忆了"这句症状能对应到 17 个口子里的哪一个，
 * 靠人肉记是不现实的。这张表是给人看的，而标记是给机器查的。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { HOST_POINTS, VERIFIED_AGAINST, attachHost } from './host.js'

/** 标记形如 `[HOST: …]`，一个口子可以在多处出现 */
const MARKER = /\[HOST:\s*([a-z0-9-]+)\s*\]/g
const SELF_FILE = 'host.js'

function walkSources(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('_')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkSources(abs, base, out)
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(relative(base, abs))
  }
  return out
}

/**
 * 去掉注释，免得"注释里提到 `ctx.`"被当成真调用。
 * 只处理 // 与 /* *\/；字符串里的 `//`（如 http://）用前面的 [^:] 排除。
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 再去掉字符串字面量，只留会执行的代码。
 * 给「不许直接读 ctx 成员」那条检查用：文案里提到那个名字不算违规，真写出来才算。
 */
export function stripStrings(src) {
  return src
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 收集所有标记：`[{id, file, line}]` */
export function scanMarkers(root, dir = join(root, 'lib')) {
  const found = []
  for (const rel of walkSources(dir)) {
    const abs = join(dir, rel)
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((text, i) => {
      for (const m of text.matchAll(MARKER)) {
        found.push({ id: m[1], file: `lib/${rel.replace(/\\/g, '/')}`, line: i + 1 })
      }
    })
  }
  return found
}

/** host.js 之外还有没有 `ctx.xxx` 的直呼 */
export function findStrayCtx(root, dir = join(root, 'lib')) {
  const stray = []
  for (const rel of walkSources(dir)) {
    if (rel === SELF_FILE) continue
    const abs = join(dir, rel)
    const lines = stripComments(readFileSync(abs, 'utf8')).split('\n')
    lines.forEach((text, i) => {
      if (/\bctx\s*\./.test(text)) {
        stray.push({ file: `lib/${rel.replace(/\\/g, '/')}`, line: i + 1, text: text.trim().slice(0, 120) })
      }
    })
  }
  return stray
}

// ── 降级自检：把宿主能力一个个抠掉，看会不会炸 ──────────────────

function fakeCtx(overrides = {}) {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on() {
      return () => {}
    },
    systemPrompt: { context: () => () => {} },
    tools: { register: () => () => {} },
    skills: { register: () => () => {} },
    interval: () => () => {},
    get: () => undefined,
    ...overrides,
  }
  return ctx
}

const KEEP = (ctx) => ctx

export function selfTest() {
  const cases = []
  const record = (name, fn) => {
    try {
      const note = fn()
      cases.push({ name, ok: true, note: note ?? '' })
    } catch (e) {
      cases.push({ name, ok: false, note: e?.message || String(e) })
    }
  }

  record('全都在：surface.ok 且没有必需缺口', () => {
    const host = attachHost(fakeCtx())
    if (!host.surface.ok) throw new Error(`requiredMissing=${host.surface.requiredMissing.join(',')}`)
    return `found ${host.surface.found.length}`
  })

  record('缺 systemPrompt：不抛错，inject 返回 noop，报成必需缺口', () => {
    const host = attachHost(fakeCtx({ systemPrompt: undefined }))
    if (!host.surface.requiredMissing.includes('inject')) throw new Error('没报出 inject 缺失')
    const d = host.inject({ text: () => 'x' })
    if (typeof d !== 'function') throw new Error('inject 应该返回 noop')
    return 'inject → noop'
  })

  record('缺 tools / skills：返回 null，不抛错', () => {
    const host = attachHost(fakeCtx({ tools: undefined, skills: undefined }))
    if (host.tool({}) !== null) throw new Error('tool 应返回 null')
    if (host.skill({}) !== null) throw new Error('skill 应返回 null')
    return 'tool/skill → null'
  })

  record('缺 interval：退回 setInterval，能停掉', () => {
    const host = attachHost(fakeCtx({ interval: undefined }))
    const stop = host.every(60_000, () => {})
    if (typeof stop !== 'function') throw new Error('every 应返回停止函数')
    stop()
    return 'setInterval 兜底'
  })

  record('缺 effect / on：effect 直接执行一次，订阅变 noop', () => {
    const host = attachHost(fakeCtx({ effect: undefined, on: undefined }))
    let ran = 0
    host.effect(() => {
      ran += 1
    })
    host.onInbox(() => {})
    if (ran !== 1) throw new Error(`effect 应执行 1 次，实际 ${ran}`)
    return 'eager effect'
  })

  record('冻结的 ctx：testHook 不抛错', () => {
    const host = attachHost(Object.freeze(fakeCtx()))
    host.testHook('fishMemory', () => ({}))
    return 'frozen ok'
  })

  record('计数：订阅回调会被计数（channel-gap 靠它）', () => {
    let handler = null
    const host = attachHost(
      fakeCtx({
        on(name, fn) {
          if (name === 'agent/inbox/inserted') handler = fn
          return () => {}
        },
      }),
    )
    host.onInbox(() => {})
    handler?.({})
    if (host.stats.inbox !== 1) throw new Error(`inbox 计数应为 1，实际 ${host.stats.inbox}`)
    return 'stats.inbox=1'
  })

  return { ok: cases.every((c) => c.ok), cases }
}

/**
 * 全量体检。
 * @param {string} root 插件包根目录
 */
export function checkHost(root) {
  const markers = scanMarkers(root)
  const stray = findStrayCtx(root)
  const test = selfTest()

  // 表 × 标记，两边对齐
  const points = HOST_POINTS.map((point) => ({
    ...point,
    sites: markers.filter((m) => m.id === point.id).map((m) => `${m.file}:${m.line}`),
  }))
  const known = new Set(HOST_POINTS.map((p) => p.id))
  const unknownMarkers = [...new Set(markers.map((m) => m.id))].filter((id) => !known.has(id))
  const unmarked = points.filter((p) => !p.sites.length).map((p) => p.id)

  const errors = []
  if (unknownMarkers.length) {
    errors.push(`代码里有未登记的标记：${unknownMarkers.join(', ')}（先加进 lib/host.js 的 HOST_POINTS）`)
  }
  if (unmarked.length) {
    errors.push(`HOST_POINTS 里这些口子在代码里找不到对应标记：${unmarked.join(', ')}`)
  }
  if (stray.length) {
    errors.push(`lib/ 下 host.js 之外出现对 ctx 的直呼 ${stray.length} 处（应该经 host.js 转手）`)
  }
  if (!test.ok) {
    errors.push(`降级自检未通过：${test.cases.filter((c) => !c.ok).map((c) => c.name).join('；')}`)
  }

  return {
    ok: errors.length === 0,
    verifiedAgainst: VERIFIED_AGAINST,
    points,
    unknownMarkers,
    unmarked,
    stray,
    selfTest: test,
    errors,
  }
}
