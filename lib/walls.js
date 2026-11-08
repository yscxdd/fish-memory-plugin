// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * walls.js — 四堵墙的**数字**（v0.75.0）。
 *
 * 起因：一份外部总结把伴侣记忆拆成四堵墙——记忆 / 触发 / 决定 / **连续**。
 * 前三堵我们有机制，第四堵我们最强，**但没有一堵有指标**。
 * 不是"墙有没有"，是"墙有多厚"。
 *
 * 四条口径（写死在这里，免得以后各说各的）：
 *
 *   记忆墙  可回溯率 = source 能在档案里找到的点 / 有 source 的点；链是否完整
 *   触发墙  静默空率 = 非门控查询里没查到东西的 / 非门控查询数（**点数 > 0 才有意义**）
 *   决定墙  推翻几条、撤销几条、**没有反面证据的推翻**几条（后一个数最该是 0）
 *   连续墙  核心层漂移、金丝雀锚点、口癖保留、注入前缀是否稳定
 *
 * 全只读：不写任何状态、不改任何点。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ANCHOR_LINES, canaryHits, coreDrift } from './guard.js'
import { checkArchive } from './integrity.js'
import { readArchive, readPointFiles } from './toolkit.js'
import { voiceMetrics } from './voicemetrics.js'

const readJsonLines = (file) => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** ① 记忆墙：记过的，能指回原文 */
export function wallMemory(dir) {
  const points = readPointFiles(dir, '30_points')
  const withSource = points.filter((p) => (p.source || []).length > 0)
  let archive = { byId: new Map(), messages: [] }
  try {
    archive = readArchive(dir)
  } catch {
    /* 空库 */
  }
  const traceable = withSource.filter((p) => (p.source || []).every((s) => archive.byId?.has?.(s) || String(s).match(/^(asset|book):/)))
  const chain = checkArchive(dir, { persist: false })
  return {
    points: points.length,
    withSource: withSource.length,
    traceable: traceable.length,
    rate: withSource.length ? traceable.length / withSource.length : null,
    chainOk: Boolean(chain.ok),
    archiveFiles: chain.checked || 0,
    // 没有 source 的点按纪律本来就不该入库——单独报出来，别混进可回溯率
    noSource: points.length - withSource.length,
  }
}

/** ② 触发墙：查了，但空的时候没人知道 */
export function wallTrigger(dir) {
  const rows = readJsonLines(join(dir, '50_log', 'retrieval.log'))
  const gated = rows.filter((r) => r.gated)
  const tried = rows.filter((r) => !r.gated)
  const empty = tried.filter((r) => !Array.isArray(r.rendered) || r.rendered.length === 0)
  const withNearMissField = rows.filter((r) => 'nearMiss' in r)
  const nearHits = rows.filter((r) => r.nearMiss)
  let points = 0
  try {
    points = readPointFiles(dir, '30_points').length
  } catch {
    /* 空库 */
  }
  return {
    turns: rows.length,
    gated: gated.length,
    tried: tried.length,
    empty: empty.length,
    // **分母**：只有点数 > 0 时，静默空率才在说检索；点数为 0 时它只是在说库是空的
    emptyRate: tried.length ? empty.length / tried.length : null,
    meaningful: points > 0,
    points,
    // nearMiss 字段覆盖率：v0.73 之后才有这个字段，老日志没有
    nearMissCoverage: rows.length ? withNearMissField.length / rows.length : null,
    nearMissHits: nearHits.length,
  }
}

/** ③ 决定墙：人决，但人自己的撤销工具要有 */
export function wallDecision(dir) {
  const points = readPointFiles(dir, '30_points')
  const superseded = points.filter((p) => p.status === 'superseded')
  const ledger = readJsonLines(join(dir, '50_log', 'erasure.log'))
  const refutes = ledger.filter((r) => r.action === 'refute')
  const unrefutes = ledger.filter((r) => r.action === 'unrefute')
  return {
    superseded: superseded.length,
    withBy: superseded.filter((p) => p.refuted_by).length,
    // 没有反面证据的推翻：这是"决定质量"的直接度量
    withoutEvidence: refutes.filter((r) => !r.by).length,
    refutes: refutes.length,
    unrefutes: unrefutes.length,
    // 撤销工具是否可用（M4 之前是 false）
    canUnrefute: unrefutes.length >= 0 && existsSync(join(dir, '..', 'fish-memory-plugin', 'lib', 'unrefute.js')),
  }
}

/** ④ 连续墙：隔了多久，她还是她吗 */
export function wallContinuity(dir) {
  const soulPath = join(dir, '00_core', 'soul.md')
  const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : ''
  // 只数**三条行为**：ANCHOR_LINES[0] 是小节标题（'## 不可能变的'），
  // 而真库里的标题是 '## 不会变的（金丝雀锚点）'——把标题算进去会让分母变成 4，
  // 于是"3/4"看起来像丢了一条锚点，其实一条没丢。
  const behaviourAnchors = ANCHOR_LINES.filter((line) => line.startsWith('- '))
  const anchors = behaviourAnchors.filter((line) => soul.includes(line))
  const hits = canaryHits(soul)

  let drift = []
  try {
    drift = coreDrift(dir).filter((d) => d.ratio !== null)
  } catch {
    /* 没有 versions 目录 */
  }
  const worst = drift.length ? Math.max(...drift.map((d) => d.ratio)) : null

  // 口癖保留：她最近说的话里，voice.md 的招牌词还剩几个
  let voice = null
  try {
    const v = voiceMetrics(dir)
    voice = {
      turns: v.turns ?? v.messages ?? null,
      rate: v.rate ?? v.retention ?? null,
    }
  } catch {
    /* 还没说过话 */
  }

  // 前缀稳定：token.log 里 core 那一档每轮是否一样（变了说明前缀在动）
  const tokens = readJsonLines(join(dir, '50_log', 'token.log')).map((r) => r.core).filter((n) => Number.isFinite(n))
  const uniqueCore = new Set(tokens).size
  return {
    anchors: anchors.length,
    anchorsTotal: anchorTotal(),
    canary: hits.length,
    driftWorst: worst,
    driftFiles: drift.length,
    voice,
    prefixSamples: tokens.length,
    prefixVariants: tokens.length ? uniqueCore : null,
    prefixStable: tokens.length ? uniqueCore === 1 : null,
  }
}

function anchorTotal() {
  return ANCHOR_LINES.filter((line) => line.startsWith('- ')).length
}

/** 四行汇总（给 status 用，短） */
export function wallsSummary(dir) {
  const m = wallMemory(dir)
  const t = wallTrigger(dir)
  const d = wallDecision(dir)
  const c = wallContinuity(dir)
  return [
    `记忆墙  可回溯 ${m.traceable}/${m.withSource}${m.rate === null ? '（没有点）' : `（${Math.round(m.rate * 100)}%）`} · 链${m.chainOk ? '完整' : '有问题'}`,
    `触发墙  静默空 ${t.empty}/${t.tried}${t.meaningful ? '' : '（点数 0，这行没有意义）'} · nearMiss 覆盖 ${t.nearMissCoverage === null ? '-' : `${Math.round(t.nearMissCoverage * 100)}%`}`,
    `决定墙  推翻 ${d.refutes} · 撤销 ${d.unrefutes} · 无反面证据 ${d.withoutEvidence}`,
    `连续墙  漂移 ${c.driftWorst === null ? '-' : c.driftWorst} · 锚点 ${c.anchors}/${c.anchorsTotal} · 前缀${c.prefixStable === null ? '（无样本）' : c.prefixStable ? '稳定' : '在动'}`,
  ]
}

/** 详细版（memory walls） */
export function wallsReport(dir) {
  return {
    memory: wallMemory(dir),
    trigger: wallTrigger(dir),
    decision: wallDecision(dir),
    continuity: wallContinuity(dir),
  }
}
