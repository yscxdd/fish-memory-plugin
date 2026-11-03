// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 实体表（v0.40.0，② 组）——补"关于某个人的所有事"。
 *
 * 我们有 `aliases`（书名外号）、`links`（1 跳）、`cluster`（主题），但没有**实体**：
 * 所以"我妈"、"老张"、"广州"这三类东西只能靠词面碰运气。
 *
 * 极简版（不做图数据库）：
 *   · `20_state/entities.json` —— 人写的登记表：`{name, kind, aliases[]}`
 *   · `20_state/entities.index.json` —— 派生索引：`{name: [pointId...]}`（可随时重建）
 *   · 检索时：query 里出现实体名/别名 → 把该实体的点**并进候选池**
 *
 * 三条规矩：
 *   ① 登记表人写（`memory entity add`），代码不自动从对话里抓名字——抓错比漏抓更糟；
 *   ② 索引是派生的，`rebuild` 随时可重来，删了不丢东西；
 *   ③ 命中实体只**加候选**，不硬塞进注入（还是要过分数门槛）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'
import { readPointFiles } from './toolkit.js'

export const ENTITIES_FILE = join('20_state', 'entities.json')
export const ENTITY_INDEX = join('20_state', 'entities.index.json')
export const ENTITY_KINDS = ['person', 'place', 'thing', 'topic']

export function loadEntityRegistry(dir) {
  const raw = readJsonSafe(join(dir, ENTITIES_FILE), null)
  if (!raw || !Array.isArray(raw.entities)) return { version: 1, entities: [] }
  return {
    version: 1,
    entities: raw.entities
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => ({
        name: e.name.trim(),
        kind: ENTITY_KINDS.includes(e.kind) ? e.kind : 'thing',
        aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string' && a.trim()) : [],
      })),
  }
}

export function saveEntityRegistry(dir, reg) {
  atomicWriteJson(join(dir, ENTITIES_FILE), { version: 1, entities: reg.entities })
}

/** 加一个实体（重名就并别名） */
export function addEntity(dir, { name, kind = 'thing', aliases = [] }, { now = new Date() } = {}) {
  const n = String(name || '').trim()
  if (!n) return { ok: false, reason: '实体名不能为空' }
  const reg = loadEntityRegistry(dir)
  const exist = reg.entities.find((e) => e.name === n)
  const clean = aliases.map((a) => String(a).trim()).filter(Boolean)
  if (exist) {
    for (const a of clean) if (!exist.aliases.includes(a)) exist.aliases.push(a)
    if (kind && ENTITY_KINDS.includes(kind)) exist.kind = kind
    saveEntityRegistry(dir, reg)
    return { ok: true, merged: true, entity: exist }
  }
  const entity = { name: n, kind: ENTITY_KINDS.includes(kind) ? kind : 'thing', aliases: clean }
  reg.entities.push(entity)
  saveEntityRegistry(dir, reg)
  void now
  return { ok: true, merged: false, entity }
}

export function removeEntity(dir, name) {
  const reg = loadEntityRegistry(dir)
  const before = reg.entities.length
  reg.entities = reg.entities.filter((e) => e.name !== name)
  saveEntityRegistry(dir, reg)
  return { ok: before !== reg.entities.length }
}

/** 这些实体名/别名里，哪些出现在这段文字里 */
export function entitiesIn(dir, text) {
  const reg = loadEntityRegistry(dir)
  const t = String(text || '')
  if (!t.trim()) return []
  const hits = []
  for (const e of reg.entities) {
    const names = [e.name, ...e.aliases]
    if (names.some((n) => n && t.includes(n))) hits.push(e)
  }
  return hits
}

/** 重建派生索引：{实体名: [点 id]} */
export function rebuildEntityIndex(dir) {
  const reg = loadEntityRegistry(dir)
  const points = readPointFiles(dir, '30_points')
  const index = {}
  for (const e of reg.entities) {
    const names = [e.name, ...e.aliases].filter(Boolean)
    const ids = []
    for (const p of points) {
      const hay = [p.title || '', p.summary || '', p.quote || '', (p.tags || []).join(' '), (p.aliases || []).join(' ')].join(' ')
      if (names.some((n) => hay.includes(n))) ids.push(p.id)
    }
    if (ids.length) index[e.name] = ids
  }
  atomicWriteJson(join(dir, ENTITY_INDEX), { version: 1, at: new Date().toISOString(), index })
  return { entities: reg.entities.length, matched: Object.keys(index).length, points: points.length }
}

export function loadEntityIndex(dir) {
  const raw = readJsonSafe(join(dir, ENTITY_INDEX), null)
  if (!raw || typeof raw.index !== 'object' || raw.index === null) return {}
  return raw.index
}

/**
 * query 里提到的实体 → 相关点 id（先去重，按提到几个实体排）
 * @returns {{entities:string[], ids:string[]}}
 */
export function entityCandidates(dir, query) {
  const hits = entitiesIn(dir, query)
  if (!hits.length) return { entities: [], ids: [] }
  let index = loadEntityIndex(dir)
  if (!existsSync(join(dir, ENTITY_INDEX))) {
    rebuildEntityIndex(dir)
    index = loadEntityIndex(dir)
  }
  const ids = []
  for (const e of hits) for (const id of index[e.name] || []) if (!ids.includes(id)) ids.push(id)
  return { entities: hits.map((e) => e.name), ids }
}
