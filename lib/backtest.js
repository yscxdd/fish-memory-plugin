// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * backtest.js — 技能回测（借 mnemon 的思路，但只测我们能测的）。
 *
 * 能测：**触发覆盖**（这条技能会不会在它该出现的任务里被选中）+ **结构不变量**
 *      （版本>1 必须有「上次错在哪」；must_full 的节必须在正文里；trigger 非空）。
 * 不能测：她用了这条技能之后**做得对不对**——那需要真实重放和人工评分。
 *
 * 用例来源：35_ability/_cases/<id>.json（字符串数组）；没有就取档案里最近 50 条用户消息。
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontMatter } from './util.js'
import { parseSections, rankAbilities, scanAbilities } from './mode.js'
import { readArchive } from './toolkit.js'

const THRESHOLD = 0.5

export function parseSkill(raw) {
  const { meta, body } = parseFrontMatter(raw)
  return {
    id: String(meta.id || ''),
    name: meta.name || '',
    trigger: Array.isArray(meta.trigger) ? meta.trigger : [],
    version: Number(meta.version || 1),
    status: meta.status || 'active',
    sections: parseSections(raw),
    body,
  }
}

/** 结构不变量 + 触发覆盖，纯函数 */
export function checkSkill(skill, cases) {
  const hits = cases.filter((q) => rankAbilities([skill], q, { threshold: THRESHOLD }).length)
  const invariants = []
  if (!skill.trigger.length) invariants.push('trigger 为空')
  if (skill.version > 1 && !/##\s*上次错在哪/.test(skill.body)) invariants.push('version>1 但缺「上次错在哪」')
  for (const s of skill.sections.filter((x) => x.must_full)) {
    if (!new RegExp(`##\\s*${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(skill.body)) {
      invariants.push(`must_full 的节缺失：${s.name}`)
    }
  }
  const rate = cases.length ? hits.length / cases.length : 0
  return {
    ok: invariants.length === 0 && rate >= 0.6,
    id: skill.id,
    version: skill.version,
    queries: cases.length,
    hits: hits.length,
    rate: +rate.toFixed(2),
    invariants,
  }
}

/**
 * 技能升版闸门：草稿回测通过才落盘；旧版进 35_ability/versions/。
 */
export function promoteSkill(dir, draftPath) {
  if (!existsSync(draftPath)) return { ok: false, error: `草稿不存在：${draftPath}` }
  const raw = readFileSync(draftPath, 'utf8')
  const skill = parseSkill(raw)
  if (!skill.id) return { ok: false, error: '草稿缺 id' }
  const r = checkSkill(skill, loadCases(dir, skill.id))
  if (!r.ok) return { ...r, applied: false }

  const dest = join(dir, '35_ability', `${skill.id}.md`)
  const vdir = join(dir, '35_ability', 'versions')
  mkdirSync(vdir, { recursive: true })
  if (existsSync(dest)) {
    const old = parseSkill(readFileSync(dest, 'utf8'))
    copyFileSync(dest, join(vdir, `${skill.id}.v${old.version}.md`))
  }
  writeFileSync(dest, raw, 'utf8')

  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'ability.log'),
    JSON.stringify({ at: new Date().toISOString(), event: 'skill-promote', id: skill.id, version: skill.version }) + '\n',
    'utf8',
  )
  return { ...r, applied: true, dest }
}

export function loadCases(dir, id) {
  const p = join(dir, '35_ability', '_cases', `${id}.json`)
  if (existsSync(p)) {
    try {
      const arr = JSON.parse(readFileSync(p, 'utf8'))
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string')
    } catch {
      /* 坏文件当没有 */
    }
  }
  return readArchive(dir)
    .messages.filter((m) => m.role === 'user' && m.source_kind === 'user')
    .slice(-50)
    .map((m) => String(m.text).slice(0, 200))
}

export function backtestSkill(dir, id) {
  const skill = scanAbilities(dir).find((a) => a.id === id || a.name === id)
  if (!skill) return { ok: false, error: `没有这条技能：${id}` }

  const queries = loadCases(dir, skill.id)
  const hits = []
  for (const q of queries) {
    const ranked = rankAbilities([skill], q, { threshold: THRESHOLD })
    if (ranked.length) hits.push(q)
  }

  const body = skill.body
  const invariants = []
  if (!skill.trigger.length) invariants.push('trigger 为空')
  if (skill.version > 1 && !/##\s*上次错在哪/.test(body)) invariants.push('version>1 但缺「上次错在哪」')
  for (const s of skill.sections.filter((x) => x.must_full)) {
    if (!new RegExp(`##\\s*${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(body)) {
      invariants.push(`must_full 的节缺失：${s.name}`)
    }
  }

  const rate = queries.length ? hits.length / queries.length : 0
  return {
    ok: invariants.length === 0 && rate >= 0.6,
    id: skill.id,
    version: skill.version,
    queries: queries.length,
    hits: hits.length,
    rate: +rate.toFixed(2),
    invariants,
  }
}
