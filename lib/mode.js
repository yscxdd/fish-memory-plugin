// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * mode.js — 模式判定 + 能力记忆。
 *
 * 依据《能力记忆设计》v1.0 §4.1：宁宽勿严（该进没进 = 办不成事，比多花 800 tok 严重）。
 * 能力记忆只在任务模式注入；日常模式完全不进上下文。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bigrams, score } from './retrieve.js'
import { parseFrontMatter, stripFrontMatter, stripGuidance } from './util.js'

const ACTION = /(帮我|给我|替我|教我|查一下|查查|写个|写一个|做个|做一个|转一下|导一下|修一下|修好|修掉|修这个|装一下|删掉|删除|找一下|找找|怎么把|怎么能|怎样把|有没有办法|能不能帮|你可以帮|需要你)/
const RECALL = /(上次|之前那个|我们说好的|还记得|那次|上回|以前那)/
const SELF_UPGRADE = /(我看看|我试试|我看下|我查查|我来试试|我试一下)/

/** 她上一轮说了"我看看/我试试" → 这一轮强制任务模式 */
export function selfUpgraded(lastAssistantText) {
  return SELF_UPGRADE.test(lastAssistantText || '')
}

/**
 * @returns {{mode:'task'|'daily', reasons:string[]}}
 */
export function detectMode(text, { lastAssistantText = '' } = {}) {
  const q = String(text || '')
  const reasons = []
  if (ACTION.test(q)) reasons.push('动作动词')
  if (/```/.test(q) || /[A-Za-z]:\\/.test(q) || /\.(md|js|mjs|json|ts|py|zip|mp4|png)\b/i.test(q)) reasons.push('路径或代码')
  if (/怎么把|怎么能|怎样|有没有办法|如何/.test(q)) reasons.push('动作+疑问')
  if (selfUpgraded(lastAssistantText)) reasons.push('上一轮她说我看看/我试试')
  return { mode: reasons.length ? 'task' : 'daily', reasons }
}

/** 任务里提到"上次/之前那个" → 仍要检索关系记忆 */
export function needsRelationshipRecall(text) {
  return RECALL.test(String(text || ''))
}

// ── 能力记忆 ───────────────────────────────────────────────────

/**
 * 扫 35_ability/ 下的 S-*.md / K-*.md。
 * tools.md 是"手上有什么"的短清单，单独渲染。
 */
export function scanAbilities(dir) {
  const d = join(dir, '35_ability')
  if (!existsSync(d)) return []
  const out = []
  for (const f of readdirSync(d)) {
    if (!/^[SK]-.*\.md$/.test(f)) continue
    try {
      const raw = readFileSync(join(d, f), 'utf8')
      const { meta, body } = parseFrontMatter(raw)
      if (!meta.id) continue
      out.push({
        id: meta.id,
        type: meta.type || 'skill',
        name: meta.name || meta.id,
        trigger: Array.isArray(meta.trigger) ? meta.trigger : [],
        status: meta.status || 'active',
        version: Number(meta.version || 1),
        last_applied: meta.last_applied || null,
        delegate_to: meta.delegate_to || null,
        sections: parseSections(raw),
        body,
        raw,
      })
    } catch {
      /* 单条坏了不影响全量 */
    }
  }
  return out.filter((a) => a.status === 'active')
}

/** 按 trigger/name 打分；阈值比关系记忆低（宁宽勿严） */
export function rankAbilities(abilities, query, { threshold = 0.5, limit = 8 } = {}) {
  const qs = bigrams(query)
  if (!qs.size) return []
  return abilities
    .map((a) => ({ a, s: score(qs, { title: a.name, tags: a.trigger, cluster: a.type, summary: '' }) }))
    .filter((x) => x.s >= threshold)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
}

/** front matter 里的 sections 是行内对象数组，util 的简易解析器不认识，单独抽 */
export function parseSections(raw) {
  const block = (raw || '').match(/^sections:\s*\r?\n((?:\s+-.*\r?\n?)+)/m)
  if (!block) return []
  const out = []
  for (const line of block[1].split(/\r?\n/)) {
    const name = line.match(/name:\s*([^,}]+)/)
    if (!name) continue
    out.push({ name: name[1].trim(), must_full: /must_full:\s*true/.test(line) })
  }
  return out
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sectionText(a, name) {
  // 标题可能带后缀，如「上次错在哪（v1 → v2）」
  const re = new RegExp(`##\\s*${escapeRe(name)}[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`)
  const m = a.body.match(re)
  return m ? m[1].trim() : ''
}

/** 哪些节必须全量（must_full: true） */
export function mustFullSections(a) {
  return a.sections.filter((s) => s && s.must_full).map((s) => s.name)
}

/** 渲染一条能力点：至少给"做什么"，预算够就给 must_full 的节 */
export function renderAbility(a, depth = 'sum') {
  const head = `### ${a.name}（v${a.version}${a.last_applied ? `，上次用 ${a.last_applied}` : ''}）`
  const what = sectionText(a, '做什么') || ''
  if (depth === 'idx') return `- ${a.name}`
  const blocks = [head]
  if (what) blocks.push(what)
  if (depth === 'full') {
    for (const name of mustFullSections(a)) {
      const t = sectionText(a, name)
      if (t) blocks.push(`**${name}**\n${t.replace(/^\*\*.*\*\*\s*$/gm, '').trim()}`)
    }
  }
  return blocks.join('\n')
}

/** tools.md 的短清单（≤60 tok，任务模式里当"手上有什么"） */
export function renderTools(dir) {
  const p = join(dir, '35_ability', 'tools.md')
  if (!existsSync(p)) return ''
  const body = stripFrontMatter(readFileSync(p, 'utf8'))
  // 只要「## 现在」，不要「填法 / 什么时候该降级」这些写给维护者看的
  const m = body.match(/##\s*现在\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/)
  const text = (m ? m[1] : body)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes('暂无') && !/^-{3,}$/.test(l.trim()) && !/^-\s*_（.*）_$/.test(l.trim()))
    .join('\n')
    .trim()
  return text
}

/**
 * 装填：按分数装到预算为止（不按条数，§5.1）。
 * @returns {{text:string, picked:string[]}}
 */
export function layoutAbilities(abilities, budget = 2400) {
  const blocks = []
  const picked = []
  let used = 0
  for (const { a } of abilities) {
    let text = renderAbility(a, 'full')
    let tokens = est(text)
    if (used + tokens > budget && a.body.includes('## 做什么')) {
      text = renderAbility(a, 'sum')
      tokens = est(text)
    }
    if (used + tokens > budget) {
      text = renderAbility(a, 'idx')
      tokens = est(text)
    }
    if (used + tokens > budget) break
    blocks.push(text)
    picked.push(a.id)
    used += tokens
  }
  return { text: blocks.join('\n\n'), picked }
}

function est(s) {
  // 与 render.js 同一把尺子；这里只估预算，不追求精确
  let cjk = 0
  for (const ch of s) if (ch >= '\u4e00' && ch <= '\u9fff') cjk++
  return Math.ceil(cjk * 0.8 + (s.length - cjk) / 4)
}
