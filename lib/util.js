// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * util.js — 纯函数工具，无宿主依赖，可单测。
 *
 * 设计依据：《大肥鱼-插件接口契约》v1.0 §3.2 / §4.5 / §5.1
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * 目录指纹：把 `dir` 下所有 `*.js` 的**文件名 + 内容**按名字排序后一起 hash，取前 8 位。
 *
 * 为什么要它：`sync` 只保证磁盘一致、版本号只保证"发过版"，两者都回答不了
 * "**进程里加载的代码**和磁盘一样吗"。只 bump 版本号而不动 `lib/` 时，
 * 版本比对会说"不一样"——但跑起来的代码其实一字不差，那是假警报；
 * 反过来改了 `lib/` 忘了 bump 版本，版本比对又会说"一样"。
 * 指纹比版本号诚实：它只看代码。
 */
export function fingerprintDir(dir, ext = '.js') {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .sort()
    const h = createHash('sha256')
    for (const f of files) {
      h.update(f)
      h.update(readFileSync(join(dir, f)))
    }
    return h.digest('hex').slice(0, 8)
  } catch {
    return 'unknown'
  }
}

/** 粗估 token：中文 0.8，其余 1/4。只用于预算，不用于计费。 */
export function estTokens(s) {
  if (!s) return 0
  let cjk = 0
  for (const ch of s) if (ch >= '\u4e00' && ch <= '\u9fff') cjk++
  return Math.ceil(cjk * 0.8 + (s.length - cjk) / 4)
}

// ── 注入面净化（v0.7.0，契约 §11 新不变量）────────────────────
//
// 为什么有这一段：注入是**文本拼接**，而记忆内容逐字来自对话/网页摘要。
// ① 结构性：一条记忆点正文里带 `<!-- /记忆 -->`，就能把我们的块提前闭合，
//    后面的字看起来像系统层的话。实测渲染后出现 2 个闭合标记。
// ② 内容性：密钥/手机号会被原样注入，也会原样进每日备份。
//
// 分工（重要，别搞混）：
//   - **落盘不动**：档案与记忆点保留逐字原文（不变量：QUOTE 逐字、档案只追加）。
//   - **出口净化**：所有"要进模型上下文"的文本都过 sanitizeForPrompt()。
//   - **入口提醒**：草稿里有疑似密钥时 check 告警（validatePoint 的 warnings），不静默改写。

/** 零宽空格：让 `<!--` 在视觉上不变，但不再构成注释标记 */
const ZWSP = '\u200B'

/**
 * 疑似密钥/隐私的模式。**只做保守匹配**：宁可漏，不可把普通文本打码成乱码。
 * 每条给出可读的替换标签，方便她/他知道这里被遮过。
 */
export const REDACT_RULES = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, tag: '[已打码:API密钥]' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, tag: '[已打码:GitHub令牌]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, tag: '[已打码:GitHub令牌]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, tag: '[已打码:AWS密钥]' },
  { re: /\b(?<!\d)1[3-9]\d{9}(?!\d)\b/g, tag: '[已打码:手机号]' },
  { re: /\b(?<!\d)\d{17}[\dXx](?!\d)\b/g, tag: '[已打码:身份证号]' },
  // 只吃到标点/空白为止：`password: hunter2，她喜欢吃香菜` 不能把后半句也吞了
  { re: /((?:password|passwd|pwd|密码|口令)\s*[:：=]\s*)[^\s，。；、,;）)】\]"']+/gi, tag: '$1[已打码]' },
]

/** 有没有疑似密钥（给 check/audit 用，不改原文） */
export function findSecrets(text) {
  const t = String(text || '')
  return REDACT_RULES.filter((r) => {
    r.re.lastIndex = 0
    const hit = r.re.test(t)
    r.re.lastIndex = 0
    return hit
  }).map((r) => r.tag)
}

/** 把疑似密钥/隐私换成标记；其余逐字保留 */
export function redactSecrets(text) {
  let out = String(text || '')
  for (const { re, tag } of REDACT_RULES) {
    re.lastIndex = 0
    out = out.replace(re, tag)
  }
  return out
}

/** 让内容里伪造的 HTML 注释不再成立（我们自己的块边界也用这种标记） */
export function neutralizeDelimiters(text) {
  return String(text || '').replace(/<!--/g, `<${ZWSP}!--`)
}

/**
 * 出口净化：先打码，再拆掉伪造的注释标记。
 *
 * **只用于"要进模型上下文"或"要交给模型压缩"的文本**；磁盘上的原文不走这里。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForPrompt(text) {
  return neutralizeDelimiters(redactSecrets(text))
}

/** 本地日期 YYYY-MM-DD（档案按「事情发生的那天」分文件） */
export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 8 位十六进制摘要，用于 prev/hash 链 */
export function sha8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

/** 读 JSON；坏了返回 fallback，绝不抛 */
export function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：临时文件 + rename（契约 §6.3） */
export function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 这条记忆**还成立吗**（v0.14.0）。
 *
 * 为什么要有：偏好和事实会变（"以前喝美式，现在喝拿铁"）。以前只有 `status`，
 * 两条都 `active`，检索可能把两条都注入，等于让她同时相信两件互斥的事。
 * 现在给点一个 `invalid_at`：到了那个时间之后**不再进注入**，但**档案与点都留着**
 * ——"失效"是标记，不是删除（graphiti 的做法：invalidated edges are persisted）。
 *
 * 两条硬规则（照抄 graphiti 的语义，写进测试）：
 *   ① `boundary` / `promise` **永不失效**：承诺到期不等于承诺没说过。
 *   ② 没写 `invalid_at` 一律当"仍有效"（老点不用迁移）。
 *
 * @param {{invalid_at?: string|null, invalidAt?: string|null}} p
 * @returns {boolean} true = 已失效，不该再注入
 */
export function isInvalidated(p, now = new Date()) {
  const raw = p?.invalid_at ?? p?.invalidAt ?? null
  if (!raw) return false
  const t = Date.parse(String(raw))
  if (!Number.isFinite(t)) return false // 写坏了当"仍有效"，校验会另外报错
  return t <= now.getTime()
}

/** 原子写文本 */
export function atomicWriteText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 去掉 front matter */
export function stripFrontMatter(text) {
  return (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * 极简 front matter 解析：字符串 / 数字 / 布尔 / null / [a, b]。
 * 不引 yaml 依赖（契约 §3.1：不引入分词库，同理不引入解析库）。
 */
export function parseFrontMatter(text) {
  const m = (text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: text || '' }
  const meta = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let v = kv[2].trim()
    if (v === '' || v === 'null' || v === '~') meta[key] = null
    else if (v === 'true') meta[key] = true
    else if (v === 'false') meta[key] = false
    else if (/^-?\d+(\.\d+)?$/.test(v)) meta[key] = Number(v)
    else if (v.startsWith('[') && v.endsWith(']')) {
      meta[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else meta[key] = v.replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(m[0].length) }
}

/** 取 <!-- SUM --> 块 */
export function extractSum(body) {
  const m = (body || '').match(/<!--\s*SUM\s*-->([\s\S]*?)<!--\s*\/SUM\s*-->/)
  return m ? m[1].trim() : ''
}

/** 取某个 ## 小节（到下一个 ## 或文件尾） */
export function extractSection(body, heading) {
  const re = new RegExp(`##\\s*${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`)
  const m = (body || '').match(re)
  return m ? m[1].trim() : ''
}

/**
 * 剥掉「给填写者看的」行（契约 §14 坑 2）。
 *
 * 核心层文件是半模板，直接注入会把「❌ 例：…」「_（待填）_」当成她本人。
 * 规则：
 *   - `>` 引用块（写法说明）
 *   - 含「待填」的行（占位）
 *   - ❌ / ✅ 开头的示例行
 *   - 纯横线、纯斜体占位
 *   - 剥完变空的小节
 * 剥完只剩一个标题 → 视为空文件。
 */
export function stripGuidance(text) {
  const kept = (text || '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t.startsWith('>')) return false
      if (t.includes('待填')) return false
      if (/^[-*]\s*(\*\*)?[^：:]{1,12}(：|:)/.test(t) && /_（[^）]*）_|_\([^)]*\)_/.test(t)) return false
      if (/^❌|^✅/.test(t)) return false
      if (/^-{3,}$/.test(t)) return false
      if (/^_（.*）_$/.test(t)) return false
      if (/^_.*_$/.test(t) && t.length < 40) return false
      return true
    })
    .join('\n')

  const out = kept
    .split(/(?=^## )/m)
    .filter((block) => (block.startsWith('## ') ? block.split('\n').slice(1).join('\n').trim().length > 0 : true))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (/^#\s[^\n]*$/.test(out)) return ''
  return out
}

/**
 * 宿主注入的运行时上下文，不是人说的话。
 * 新版已经按 source.kind 挡掉了；这个函数只用来清洗历史遗留的 tail。
 */
export function isHarnessContext(text) {
  const t = String(text || '').trim()
  return /^(Current runtime context\.|Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding model-visible message)/.test(
    t,
  )
}
