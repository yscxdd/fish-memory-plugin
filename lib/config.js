// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * config.js — 配置的运行时校验（零依赖版 schema）。
 *
 * 为什么不是 `export const Config = z.object(...)`：宿主那套是 schemastery，
 * 而本插件坚持零依赖（profile 里也解析不到 @deepseek-ai/schemastery）。
 * 所以改成运行时校验，解决同一件事：**写错键不会静默失效**。
 *
 * 认得的键留下；类型不对的丢掉并告警；不认得的键告警（拼错能立刻看见）。
 *
 * 配置形状：
 *   memoryDir   string   绝对路径优先；相对路径按会话 cwd 解析
 *   backupDir   string   每日迁移包的落点（默认 <库的父目录>/fish-memory-backups）
 *   inject      { core, index, body, work, status }  token 预算，core ≤ 0 表示不限
 *               status 是【我们现在】的独立预算（总设计 §5.4），不占 core
 *   retrieval   { threshold, recallLimit, maxEvents, weights }
 *   pressure    { contextWindow, prepareAt, switchAt }  宿主拿不到窗口时的兜底值 + 两个压力阈值（比例）
 *
 * `retrieval.weights` 只覆盖给的键，没给的由 lib/retrieve.js 的 mergeWeights 补默认值——
 * **校验层不负责"填满"**，它只负责"别写错"，两个职责不要混。
 *
 * 环境变量：FISH_MEMORY_DIR / FISH_MEMORY_BACKUP / FISH_MEMORY_CONTEXT_WINDOW
 */

const TOP_KEYS = new Set(['memoryDir', 'backupDir', 'backupKeep', 'inject', 'retrieval', 'pressure'])

/** 顶层数字键：backupKeep 保留几份备份（v0.8.0） */
const TOP_NUMBERS = { backupKeep: [1, 365] }

const NUMBER_RULES = {
  inject: { core: [0, 20000], index: [0, 20000], body: [0, 20000], work: [0, 20000], status: [0, 2000] },
  retrieval: { threshold: [0, 100], recallLimit: [1, 200], maxEvents: [1, 20] },
  pressure: { contextWindow: [1000, 4_000_000], prepareAt: [0.1, 0.95], switchAt: [0.1, 0.99] },
}

/** 二级对象：retrieval.weights.{title,tags,cluster,summary,unigram} */
const NESTED_RULES = {
  retrieval: {
    weights: { title: [0, 10], tags: [0, 10], cluster: [0, 10], summary: [0, 10], unigram: [0, 5] },
  },
}

/** 布尔开关：类型不对就丢（别让字符串 "false" 被当成真） */
const BOOLEAN_RULES = {
  retrieval: {
    rebalance: true, // 缺字段的点把权重挪给有内容的字段（v0.5.12 起默认开）
    idf: false, // 二字组 IDF 加权（量过：本库金标零增益，默认关）
  },
}

/** 枚举键：只收列出来的值 */
const ENUM_RULES = {
  retrieval: {
    idfMode: ['min', 'query'],
  },
}

const STRING_KEYS = ['memoryDir', 'backupDir']

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 单个数字键的校验：不是数字就丢，越界 clamp。返回写进配置的值（undefined = 不写） */
function numberInto(label, value, [min, max], warn) {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    warn(`${label} 不是数字，已忽略：${JSON.stringify(value)}`)
    return undefined
  }
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n))
    warn(`${label}=${n} 超出范围 [${min}, ${max}]，按 ${clamped} 算`)
    return clamped
  }
  return n
}

/**
 * @param {object} raw cordis 传进来的原始配置
 * @param {{warn?:Function}} [logger]
 * @returns {{memoryDir?:string, backupDir?:string, inject:object, retrieval:object, pressure:object}}
 */
export function normalizeConfig(raw, logger) {
  const warn = (msg) => logger?.warn?.(`fish-memory: 配置 ${msg}`)
  const config = { inject: {}, retrieval: {}, pressure: {} }
  if (!isPlainObject(raw)) return config

  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k))
  if (unknown.length) warn(`里有没有定义的键：${unknown.join(', ')}（会被忽略）`)

  for (const key of STRING_KEYS) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.trim()) {
      warn(`${key} 必须是非空字符串，已忽略：${JSON.stringify(v)}`)
      continue
    }
    config[key] = v.trim()
  }

  for (const [key, range] of Object.entries(TOP_NUMBERS)) {
    if (raw[key] === undefined) continue
    const n = numberInto(key, raw[key], range, warn)
    if (n !== undefined) config[key] = n
  }

  for (const [group, rules] of Object.entries(NUMBER_RULES)) {
    const src = raw[group]
    if (src === undefined) continue
    if (!isPlainObject(src)) {
      warn(`${group} 必须是对象，已忽略：${JSON.stringify(src)}`)
      continue
    }
    const nested = NESTED_RULES[group] || {}
    const booleans = BOOLEAN_RULES[group] || {}
    const enums = ENUM_RULES[group] || {}
    const extra = Object.keys(src).filter(
      (k) => !(k in rules) && !(k in nested) && !(k in booleans) && !(k in enums),
    )
    if (extra.length) warn(`${group} 里有不认得的键：${extra.join(', ')}（会被忽略）`)
    for (const [key, range] of Object.entries(rules)) {
      if (src[key] === undefined) continue
      const n = numberInto(`${group}.${key}`, src[key], range, warn)
      if (n !== undefined) config[group][key] = n
    }
    for (const key of Object.keys(booleans)) {
      const v = src[key]
      if (v === undefined) continue
      if (typeof v !== 'boolean') {
        warn(`${group}.${key} 必须是 true/false，已忽略：${JSON.stringify(v)}`)
        continue
      }
      config[group][key] = v
    }
    for (const [key, allowed] of Object.entries(enums)) {
      const v = src[key]
      if (v === undefined) continue
      if (!allowed.includes(v)) {
        warn(`${group}.${key} 只能是 ${allowed.join(' / ')}，已忽略：${JSON.stringify(v)}`)
        continue
      }
      config[group][key] = v
    }
    for (const [key, subRules] of Object.entries(nested)) {
      if (src[key] === undefined) continue
      const sub = parseWeights(src[key], `${group}.${key}`, subRules, warn)
      if (sub) config[group][key] = sub
    }
  }

  return config
}

/**
 * 解析二级数字对象（目前只有 retrieval.weights）。
 *
 * 只做两件事：**拼错的键要告警**、**全为 0 要拒绝**。
 * 不负责补默认值——那是 mergeWeights 的事（一个校验、一个兜底，职责分开）。
 * 全为 0 的拒绝在这里做，是因为"用户把它当成了静音开关"，而实际效果是
 * 检索永远零分、她再也想不起任何事——这种配置错误必须当场说，不能静默降级。
 */
function parseWeights(raw, label, rules, warn) {
  if (!isPlainObject(raw)) {
    warn(`${label} 必须是对象，已忽略：${JSON.stringify(raw)}`)
    return undefined
  }
  const extra = Object.keys(raw).filter((k) => !(k in rules))
  if (extra.length) warn(`${label} 里有不认得的键：${extra.join(', ')}（会被忽略）`)

  const out = {}
  for (const [key, range] of Object.entries(rules)) {
    if (raw[key] === undefined) continue
    const n = numberInto(`${label}.${key}`, raw[key], range, warn)
    if (n !== undefined) out[key] = n
  }
  if (!Object.keys(out).length) return undefined

  const fields = ['title', 'tags', 'cluster', 'summary']
  // 只有「四个字段全都显式配了、且全是 0」才拒绝。只关一个字段是合法用法。
  if (fields.every((k) => out[k] === 0)) {
    warn(`${label} 的 ${fields.join('/')} 全是 0（等于关掉检索），已忽略，按默认权重算`)
    return undefined
  }
  return out
}
