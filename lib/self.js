// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * self.js — 自我叙事（15_self/，总设计 §5.6）。
 *
 * 不是日记：每月一篇、≤400 字、五节固定，且**必须人工过目**。
 * 记忆点记"发生过什么"，它记"她变成了谁"。
 * 不进每轮注入：只在话题涉及情绪/关系/变化时带最近一篇。
 *
 * v0.13.0「自述改造」（方案 S：分开 —— 归她 + 人审闸门，漂移检测用既有数据）：
 *
 *   ① **事件驱动，不看日历**：提醒判据从"本月有 active 点"改成"本月有值得写自述的**素材**"
 *      （`type ∈ {boundary, conflict, promise}` 或 `salience >= 5`）。日常素材不够就**不催**，
 *      允许"这个月没什么可说的"——以前文案例这么写、代码却按日历催，自相矛盾。
 *
 *   ② **要求尽量挂来源**（方案 S 不强制、不校验）：模板里写清"能对上就写（见 M-…）"，
 *      挂不上的那条先别写；由人审时看。漂移检测不靠自述，靠 `canary.log` / `core_changelog.md` / 点类型分布。
 *
 *   ③ **人审闸门**：她写 `40_pending/_self/<month>.draft.md`，`memory self-promote <month>`
 *      校验（非空 / ≤400 字 / 五节都在）通过才移进 `15_self/<month>.md`，并记 `50_log/self.log`。
 *      "让他过目"从此是闸门，不是口头约定。
 *
 *   ④ **多一节「和核心层对照」**：这次我做的、想的，和 `00_core` 里写的我哪里不一样；
 *      不一样才提核心层变更，且要有证据、走 `soul_guard`（7 天 ≤2 条 + evidence）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPointFiles } from './toolkit.js'
import { atomicWriteText, sanitizeForPrompt, sha8 } from './util.js'

export const SELF_TOPIC = /(你最近|你变了|你最近怎么|我们|心情|感觉|最近过得|你在想什么|你还好吗)/
const MONTH = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

/** 值得写自述的素材：关系/边界/承诺/冲突，或高显著度（⑤）的事件 */
export const SELF_MATERIAL_TYPES = new Set(['boundary', 'conflict', 'promise'])

/** 五节固定结构（promote 时按小标题校验） */
export const SELF_SECTIONS = ['我注意到', '我在变', '我还没想清楚', '这个月最重要的一件事', '和核心层对照']

/** 字数上限（按去掉空白后的字符数算） */
export const SELF_MAX_CHARS = 400

export const SELF_LOG = join('50_log', 'self.log')

export function selfPath(dir, now = new Date()) {
  return join(dir, '15_self', `${MONTH(now)}.md`)
}

/** 草稿位置：她写这里，人审通过才进 15_self/ */
export function selfDraftPath(dir, month) {
  return join(dir, '40_pending', '_self', `${String(month)}.draft.md`)
}

export function hasSelf(dir, now = new Date()) {
  return existsSync(selfPath(dir, now))
}

/** 这条记忆点算不算"值得写自述"的素材 */
export function isSelfMaterial(p) {
  if (!p) return false
  if (SELF_MATERIAL_TYPES.has(String(p.type))) return true
  return Number(p.salience) >= 5
}

/**
 * 该不该提醒她写自述。
 *
 * v0.13.0：判据是"本月有**值得写**的素材"，不是"本月有点"。
 * 只有日常（event/preference/habit，salience ≤4）的月份**不催**。
 */
export function dueForSelf(dir, now = new Date()) {
  if (hasSelf(dir, now)) return false
  const m = MONTH(now)
  return readPointFiles(dir, '30_points').some(
    (p) => p.status === 'active' && String(p.date).startsWith(m) && isSelfMaterial(p),
  )
}

/** 最近一篇自述（原文） */
export function latestSelf(dir) {
  const d = join(dir, '15_self')
  if (!existsSync(d)) return null
  const files = readdirSync(d).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort()
  if (!files.length) return null
  return readFileSync(join(d, files[files.length - 1]), 'utf8')
}

/**
 * 自述块（要进模型上下文）。
 *
 * v0.12.1：**内容必须过 sanitizeForPrompt**。这里是第 6 条注入路径——
 * 自述是她自己写的、素材来自记忆点（可能逐字引他的话），以前直接 `String(text)` 拼进块，
 * 于是里面有 `<!-- /记忆 -->` 就能闭合我们的围栏、有密钥就不会打码。
 * 放在这个函数里而不是调用处，是为了以后谁再调它都自动安全。
 */
export function renderSelfBlock(text) {
  return ['<!-- 我最近在想什么 -->', sanitizeForPrompt(String(text).trim()), '<!-- /我最近在想什么 -->'].join('\n')
}

/** 字数：去掉所有空白后的字符数（中文按字算，标点也算） */
export function selfCharCount(text) {
  return [...String(text ?? '').replace(/\s+/gu, '')].length
}

/** 一节的小标题：`## 我在变` / `**我在变**` / `我在变：` 都算，但这一行不能有别的正文 */
function sectionLabelRe(name) {
  return new RegExp(`^[\\s>]*(?:#{1,6}[ \\t]*|\\*\\*|__)[ \\t]*${name}[ \\t]*(?:\\*\\*|__)?[ \\t]*[：:]?[ \\t]*$`, 'm')
}

/** 校验自述稿：非空 / ≤400 字 / 五节都在 */
export function validateSelf(text) {
  const body = String(text ?? '').trim()
  const errors = []
  const chars = selfCharCount(body)
  const missing = SELF_SECTIONS.filter((name) => !sectionLabelRe(name).test(body))
  if (!body) errors.push({ field: 'text', message: '草稿是空的' })
  else {
    if (chars > SELF_MAX_CHARS) errors.push({ field: 'text', message: `超长：${chars} 字，上限 ${SELF_MAX_CHARS}` })
    if (missing.length) errors.push({ field: 'sections', message: `缺节：${missing.join('、')}（五节都要有小标题）` })
  }
  return { ok: errors.length === 0, chars, missing, errors }
}

/** 记一行闸门日志：通过记 promote，被拦记 reject（闸门在工作，要看得见） */
function logSelf(dir, rec) {
  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(join(dir, SELF_LOG), JSON.stringify(rec) + '\n', 'utf8')
}

/**
 * 人审闸门：把 `40_pending/_self/<month>.draft.md` 提升为 `15_self/<month>.md`。
 *
 * 三件事：校验 → 移过去 → 记 `50_log/self.log`。
 * 不合格就**不动 15_self/**，只留一行 reject 日志。目标已存在时默认拒绝（要覆盖加 force）。
 */
export function promoteSelf(dir, month, { force = false } = {}) {
  const m = String(month ?? '').trim()
  if (!/^\d{4}-\d{2}$/.test(m)) {
    return { ok: false, errors: [{ field: 'month', message: '月份要写成 YYYY-MM，例如 2026-10' }] }
  }
  const draftPath = selfDraftPath(dir, m)
  if (!existsSync(draftPath)) {
    return { ok: false, errors: [{ field: 'draft', message: `没有草稿：${draftPath}` }] }
  }
  const text = readFileSync(draftPath, 'utf8')
  const v = validateSelf(text)
  if (!v.ok) {
    logSelf(dir, {
      at: new Date().toISOString(),
      action: 'reject',
      month: m,
      chars: v.chars,
      reason: v.errors.map((e) => e.field).join(','),
      missing: v.missing,
    })
    return { ok: false, chars: v.chars, missing: v.missing, errors: v.errors }
  }

  const dest = join(dir, '15_self', `${m}.md`)
  if (existsSync(dest) && !force) {
    return { ok: false, chars: v.chars, errors: [{ field: 'dest', message: `15_self/${m}.md 已存在（要覆盖加 --force）` }] }
  }
  const body = `${text.trim()}\n`
  atomicWriteText(dest, body)
  unlinkSync(draftPath)

  const rec = {
    at: new Date().toISOString(),
    action: 'promote',
    month: m,
    chars: v.chars,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha8: sha8(body),
    from: `40_pending/_self/${m}.draft.md`,
  }
  logSelf(dir, rec)
  return { ok: true, dest, chars: v.chars, record: rec }
}

/**
 * 素材包：这个月的高显著度点 + 原话 + 时间线，给"她"写自述用。
 *
 * v0.13.0：① 素材里**列全**本月 active 点（日常事也要，串起来才看得出"我在变"），
 * 但另记一个 `material` 计数——它就是 `dueForSelf` 的判据，为 0 说明这个月没什么可写的；
 * ② 文案要求尽量挂来源、要求「和核心层对照」；③ 写草稿不写正文，人审后才进 15_self/。
 */
export function buildSelfPack(dir, now = new Date()) {
  const m = MONTH(now)
  const points = readPointFiles(dir, '30_points')
    .filter((p) => p.status === 'active' && String(p.date).startsWith(m))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const material = points.filter(isSelfMaterial).length

  const lines = [
    '---',
    `month: ${m}`,
    `points: ${points.length}`,
    `material: ${material}`,
    '---',
    '',
    `# ${m} · 自述素材包（不是让你抄的答案）`,
    '',
    '> **什么时候写**：等这个月过完、或这轮对话结束后的空闲时间再写。',
    '> **不要中途打断他现在说的话**；这不是任务，是收工后的事。',
    '> 写进 `40_pending/_self/' + m + '.draft.md`（**不是** `15_self/`）。写 `memory self-promote ' + m + '` 提上来，他过目后才算数。',
    '> 一篇 ≤400 字，五节小标题：我注意到 / 我在变 / 我还没想清楚 / 这个月最重要的一件事 / 和核心层对照。',
    '> **只写你自己的观察**，不要把下面的材料改写成"事实"；旁白不算事实。',
    '> **每条观察尽量挂来源**：能对上就写 `（见 M-2026-10-30-001）`，对不上就不写那条——挂不上来源的"感觉"最容易滑成编。',
    '> **和核心层对照**：这次我做的、想的，和 `00_core`（soul / user / rules）里写的我，哪里不一样？',
    '> 不一样才提核心层变更，而且要有证据、走 `soul_guard`（7 天 ≤2 条）；别因为一次情绪就改她是谁。',
    '',
    `## 这个月发生过（有来源，可核对）`,
    '',
  ]
  if (!points.length) {
    lines.push('（这个月还没有记下来的事。没有就写"这个月没什么可说的"，不要编。）')
  }
  for (const p of points) {
    lines.push(`### ${p.date} ${p.title}`)
    if (p.summary) lines.push(p.summary)
    if (p.quote) lines.push(`原话（${p.quote_by === 'her' ? '她' : '他'}）："${p.quote}"`)
    lines.push('')
  }
  lines.push('---', '', '写完自检四条：① ≤400 字 ② 没编（每条能对回上面的材料） ③ 不是写给他看的漂亮话 ④ 和核心层对照过。')

  const outDir = join(dir, '40_pending', '_self')
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, `${m}.md`)
  writeFileSync(path, lines.join('\n'), 'utf8')
  return { path, month: m, points: points.length, material }
}
