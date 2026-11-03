// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 可调参数（v0.45.0，D 组）——比 GUI 滑块可审计的"调参"。
 *
 * 为什么不做可写面板（说过一次，这里再钉一遍）：
 *   面板改一个值，就等于开了第二个写入口，`audit` / `origin` / `version` / `tamper`
 *   全都可以绕过——那我们上个月做的那些闸门就只是装饰。
 *
 * 这里做的是：**一个键、一句说明、一次写入、一条记录**：
 *   · 只认白名单里的键（写别的一律拒）
 *   · 类型校验（布尔就布尔、数字就数字，范围写死）
 *   · 落在 `20_state/settings.json`，插件启动时覆盖配置
 *   · 每条改动进 `50_log/settings.log`（谁改的、从什么改成什么、什么时候）
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './util.js'

export const SETTINGS_FILE = join('20_state', 'settings.json')
export const SETTINGS_LOG = join('50_log', 'settings.log')

/**
 * 白名单。`apply` 的含义：
 *   live    = 下一轮就生效（插件每轮读 cfg）
 *   restart = 要重载插件（这些在加载时取一次）
 */
export const TUNABLES = [
  {
    key: 'emotion.enabled',
    type: 'bool',
    default: true,
    apply: 'live',
    doc: '情绪层总开关。关掉就不注入情绪行，也不更新档位',
  },
  {
    key: 'emotion.contagion',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.5,
    apply: 'live',
    doc: '情绪传染：她 = contagion×他 + (1-contagion)×底色。越大越被带着走',
  },
  {
    key: 'emotion.decay',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.15,
    apply: 'live',
    doc: '每轮向底色回弹的比例。越大越快平复',
  },
  {
    key: 'habits.enabled',
    type: 'bool',
    default: true,
    apply: 'live',
    doc: '说话习惯注入开关',
  },
  {
    key: 'retrieval.threshold',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.8,
    apply: 'live',
    doc: '命中门槛。调低会更常翻出旧事（也更吵）',
  },
  {
    key: 'retrieval.maxEvents',
    type: 'number',
    min: 1,
    max: 10,
    default: 3,
    apply: 'live',
    doc: '一次最多给几件事（同一 event 只占一个名额）',
  },
  {
    key: 'inject.core',
    type: 'number',
    min: 200,
    max: 1200,
    default: 700,
    apply: 'restart',
    doc: '核心层预算（tok）',
  },
  {
    key: 'inject.index',
    type: 'number',
    min: 200,
    max: 1200,
    default: 700,
    apply: 'restart',
    doc: '索引层预算（tok）',
  },
  {
    key: 'inject.body',
    type: 'number',
    min: 100,
    max: 900,
    default: 300,
    apply: 'restart',
    doc: '正文预算（tok）',
  },
  {
    key: 'everything.enabled',
    type: 'bool',
    default: true,
    apply: 'live',
    doc: '找文件时先问 Everything（结果仍只留登记工作区）',
  },
]

const byKey = new Map(TUNABLES.map((t) => [t.key, t]))

export function loadSettings(dir) {
  const raw = readJsonSafe(join(dir, SETTINGS_FILE), null)
  return raw && typeof raw.values === 'object' && raw.values ? raw.values : {}
}

function saveSettings(dir, values) {
  atomicWriteJson(join(dir, SETTINGS_FILE), { version: 1, values })
}

function logChange(dir, { key, from, to, at }) {
  try {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, SETTINGS_LOG), JSON.stringify({ at, key, from, to }) + '\n', 'utf8')
  } catch {
    /* 记账失败不影响改动 */
  }
}

/** 把字符串解析成该键的类型；不合法返回 {ok:false} */
export function parseValue(spec, raw) {
  const s = String(raw ?? '').trim()
  if (spec.type === 'bool') {
    if (/^(true|on|1|yes|开)$/i.test(s)) return { ok: true, value: true }
    if (/^(false|off|0|no|关)$/i.test(s)) return { ok: true, value: false }
    return { ok: false, reason: '要 true/false（或 on/off）' }
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, reason: '要一个数字' }
  if (spec.min != null && n < spec.min) return { ok: false, reason: `不能小于 ${spec.min}` }
  if (spec.max != null && n > spec.max) return { ok: false, reason: `不能大于 ${spec.max}` }
  return { ok: true, value: n }
}

/** 设置一个键（白名单 + 类型 + 范围） */
export function setSetting(dir, key, raw, { now = new Date() } = {}) {
  const spec = byKey.get(String(key || ''))
  if (!spec) return { ok: false, reason: `不认识的参数：${key}（用 memory config 看能改哪些）` }
  const parsed = parseValue(spec, raw)
  if (!parsed.ok) return { ok: false, reason: `${spec.key} ${parsed.reason}` }
  const cur = loadSettings(dir)
  const from = cur[spec.key] ?? spec.default
  cur[spec.key] = parsed.value
  saveSettings(dir, cur)
  logChange(dir, { key: spec.key, from, to: parsed.value, at: now.toISOString() })
  return { ok: true, key: spec.key, from, to: parsed.value, apply: spec.apply }
}

/** 恢复默认（删掉这个键） */
export function resetSetting(dir, key, { now = new Date() } = {}) {
  const spec = byKey.get(String(key || ''))
  if (!spec) return { ok: false, reason: `不认识的参数：${key}` }
  const cur = loadSettings(dir)
  if (!(spec.key in cur)) return { ok: true, key: spec.key, from: spec.default, to: spec.default, unchanged: true }
  const from = cur[spec.key]
  delete cur[spec.key]
  saveSettings(dir, cur)
  logChange(dir, { key: spec.key, from, to: spec.default, at: now.toISOString() })
  return { ok: true, key: spec.key, from, to: spec.default }
}

/** 当前生效值（settings 覆盖 default） */
export function effectiveValue(dir, spec) {
  const cur = loadSettings(dir)
  return spec.key in cur ? cur[spec.key] : spec.default
}

/** 把 `{a.b: v}` 覆盖到配置对象上（不改原对象） */
export function applyOverrides(config, values) {
  const out = { ...(config || {}) }
  for (const [key, v] of Object.entries(values || {})) {
    const parts = key.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      node[p] = typeof node[p] === 'object' && node[p] !== null ? { ...node[p] } : {}
      node = node[p]
    }
    node[parts[parts.length - 1]] = v
  }
  return out
}

/** 插件启动时用：读出设置并覆盖配置 */
export function loadConfigOverrides(dir) {
  return applyOverrides({}, loadSettings(dir))
}
