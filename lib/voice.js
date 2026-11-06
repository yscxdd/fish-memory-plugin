// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 口癖采集（v0.33.0）——借自《性格与记忆情绪系统 v2》的 `phrases`，但按我们的规矩来。
 *
 * 他们从她的发言里自动采口癖，直接进库。我们不改 `voice.md`：
 *   ① `mineVoice()` 只**读**档案，挑出"她真说过、且反复说"的句子；
 *   ② 结果写进 `40_pending/voice-proposal-*.md`（**提案**，不是改动）；
 *   ③ `memory voice accept` 之后才追加进 `voice.md`，并在 `core_changelog.md` 记一行。
 *
 * 为什么是句子而不是词：`voice.md` 的格式本来就是"20 段她真的说过的话"——
 * 语气词单拎出来没有信息量，整句才有口音。
 *
 * 三条硬规则：
 *   · 只要 `role: assistant`（她的话），不要他的（那是回声，不是口癖）；
 *   · 逐字截取，**一个字都不改**（只去首尾空白）；
 *   · 已经在 `voice.md` 里的句子不再提；被拒过的句子不再提（`20_state/voice_rejected.json`）。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, atomicWriteText, readJsonSafe } from './util.js'
import { looksLikeWork } from './textkind.js'
import { readArchive } from './toolkit.js'
import { hasCliche } from './cliche.js'

export const VOICE_FILE = join('00_core', 'voice.md')
export const VOICE_STATE = join('20_state', 'voice_rejected.json')
// 她的句子常常很短（「才不呢」就是 3 个字），门槛高了会全被滤掉
export const MIN_LEN = 3
export const MAX_LEN = 40
export const MIN_COUNT = 2
export const MIN_TAGS = 1

/** 语气词/句尾助词/自称——用来给候选打标，也用来筛掉毫无口音的句子 */
export const VOICE_TAGS = [
  '呀', '啦', '呢', '嘛', '哦', '噢', '喔', '啊', '吧', '哈', '嘿', '哼', '唉', '诶', '欸',
  '咱', '俺', '老子', '爷', '人家', '本鱼', '本鲸',
  '才不', '就不', '偏不', '啦哈', '了吧', '是吧', '对不对', '晓得不', '知道了啦',
]

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/^[「『"']+|[」』"']+$/g, '').trim()
const stripCode = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')

/** 切句：中文标点为主，保留句子本身（不补标点） */
export function splitSentences(text) {
  return stripCode(text)
    .split(/[。！？!?…]+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 她说过的话里，哪些像"口音"（长度合适、带语气词） */
export function isVoicey(sentence) {
  const s = norm(sentence)
  if (s.length < MIN_LEN || s.length > MAX_LEN) return false
  if (/https?:\/\//.test(s)) return false
  if (/^[\d\s.+-]+$/.test(s)) return false
  return VOICE_TAGS.filter((t) => s.includes(t)).length >= MIN_TAGS
}

/** 当前 voice.md 里已有的句子（归一化后比对，防止重复提议） */
export function existingVoiceLines(dir) {
  const p = join(dir, VOICE_FILE)
  if (!existsSync(p)) return new Set()
  const raw = readFileSync(p, 'utf8')
  const out = new Set()
  for (const line of raw.split('\n')) {
    const m = /^她[:：]\s*[「『"']?(.+?)[」』"']?\s*$/.exec(line.trim())
    if (m) out.add(norm(m[1]))
  }
  return out
}

function loadRejected(dir) {
  const raw = readJsonSafe(join(dir, VOICE_STATE), null)
  return new Set(Array.isArray(raw?.rejected) ? raw.rejected : [])
}

function saveRejected(dir, set) {
  atomicWriteJson(join(dir, VOICE_STATE), { version: 1, rejected: [...set].sort() })
}

/**
 * 挑候选句子（只读，不改任何文件）。
 *
 * 打分 = 出现次数 × 2 + 口音词命中数；同分时短的优先（短句更像口癖）。
 */
export function mineVoice(dir, { limit = 12, minCount = MIN_COUNT } = {}) {
  const { messages } = readArchive(dir)
  const existing = existingVoiceLines(dir)
  const rejected = loadRejected(dir)

  // v0.65.0：档案里有没有 session 信息。没有（旧数据/测试夹具）就不过下面那道会话闸。
  const anySession = messages.some((m) => m.session)
  const counts = new Map() // 归一化句子 → { text, count, tags, msgs: [], sessions: Set }
  const userSaid = new Set()

  for (const m of messages) {
    const text = typeof m.text === 'string' ? m.text : ''
    if (!text) continue
    if (m.role === 'user') {
      for (const s of splitSentences(text)) userSaid.add(norm(s))
      continue
    }
    if (m.role !== 'assistant') continue
    // v0.65.0（S2）：工作产出不进候选。以前只有 wakeup 用这个筛，voice 没有——
    // 同一个判据两套标准。短工作句（"跑一下测试"）长度能过 MAX_LEN，
    // 一旦 accept 进 00_core/voice.md，就是**工作措辞变成她的口癖**。
    if (looksLikeWork(text)) continue
    for (const s of splitSentences(text)) {
      if (!isVoicey(s)) continue
      // v0.46.1：套话不是口音。"我记下了/我不拦/这句稳"这类句子收进 voice.md，
      // 等于把它们从"这一轮说了"升级成"她的人设"，下一轮还会被注入——自我强化。
      if (hasCliche(s)) continue
      const key = norm(s)
      if (!key) continue
      const cur = counts.get(key) || { text: s.trim(), count: 0, tags: VOICE_TAGS.filter((t) => key.includes(t)), msgs: [], sessions: new Set(), days: new Set() }
      cur.count += 1
      if (cur.msgs.length < 3 && m.id) cur.msgs.push(m.id)
      // v0.65.0（S5）：数**会话**，不数消息。一次任务里说三遍的话不该变成她的口癖。
      if (m.session) (cur.sessions || (cur.sessions = new Set())).add(String(m.session))
      // v0.66.0（E5）：天数也要记——一个人一个多月只开一个长会话是**正常用法**
      // （真实库：93% 的消息在同一个会话里）。只数会话会让口癖挖掘在真实用法下停摆。
      if (m.ts) (cur.days || (cur.days = new Set())).add(String(m.ts).slice(0, 10))
      counts.set(key, cur)
    }
  }

  const candidates = []
  for (const [key, v] of counts) {
    if (v.count < minCount) continue
    // v0.65.0（S5）：口癖允许同一会话里反复出现，但**不该只来自一次任务**。
    // 没有 session 信息的旧档案不适用这条（否则整库都挖不出东西）。
    if (anySession && v.sessions.size < 2 && (v.days ? v.days.size : 0) < 3) continue
    if (existing.has(key)) continue // 已经在 voice.md 里
    if (rejected.has(key)) continue // 人拒过
    if (userSaid.has(key)) continue // 他也说过 → 是回声，不是她的口癖
    candidates.push({ key, text: v.text, count: v.count, tags: v.tags, evidence: v.msgs, score: v.count * 2 + v.tags.length })
  }
  candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.key.localeCompare(b.key))
  return candidates.slice(0, limit)
}

/** 写一份提案到 40_pending/（已有同一天的就不再覆盖，追加编号） */
export function writeVoiceProposal(dir, candidates, { now = new Date() } = {}) {
  if (!candidates.length) return { ok: false, reason: '没有可提议的句子（样本太少，或都已经在 voice.md 里）' }
  const day = now.toISOString().slice(0, 10)
  const flatDir = join(dir, '40_pending')
  mkdirSync(flatDir, { recursive: true })
  const file = join(flatDir, `voice-proposal-${day}.md`)
  const body = [
    '---',
    'kind: voice-proposal',
    `generated: ${now.toISOString()}`,
    `candidates: ${candidates.length}`,
    '---',
    '',
    '# 口癖提案（人审）',
    '',
    '> 这些是**她真说过、且反复说**的句子。逐字截的，没有改一个字。',
    '> **接受才会进 `voice.md`**：`memory voice accept 1,3` 或 `memory voice accept all`。',
    '> 不接受就 `reject`，以后不会再提同一句。',
    '',
    ...candidates.flatMap((c, i) => [
      `## ${i + 1}. 出现 ${c.count} 次 · 口音 ${c.tags.join('/') || '—'}`,
      '',
      '```',
      `她：「${c.text}」`,
      '```',
      '',
      `证据：${c.evidence.join(', ') || '（无）'}`,
      '',
    ]),
    '',
  ].join('\n')
  atomicWriteText(file, body)
  return { ok: true, path: file, count: candidates.length }
}

/** 解析提案文件 → 候选列表（n 与文本成对） */
export function parseVoiceProposal(text) {
  const out = []
  const blocks = String(text).split(/^## /m).slice(1)
  for (const b of blocks) {
    const n = Number((/^(\d+)\./.exec(b) || [])[1])
    const m = /她：「(.+?)」/.exec(b)
    const ev = /证据：(.+)/.exec(b)
    if (Number.isFinite(n) && m) out.push({ n, text: m[1].trim(), evidence: (ev?.[1] || '').split(',').map((s) => s.trim()).filter((s) => s && s !== '（无）') })
  }
  return out
}

/** 现有最大段号 */
function nextSegmentNo(voiceText) {
  const all = [...String(voiceText).matchAll(/^### 第 (\d+) 段/mg)].map((m) => Number(m[1]))
  return all.length ? Math.max(...all) + 1 : 1
}

/**
 * 接受候选：追加进 voice.md（新的一段），并在 core_changelog 记一行。
 * @param {string[]} picks 候选文本（原样，逐字）
 */
export function acceptVoice(dir, picks, { now = new Date(), proposalPath = null } = {}) {
  if (!picks.length) return { ok: false, reason: '没有选中任何一句' }
  const vp = join(dir, VOICE_FILE)
  const prev = existsSync(vp) ? readFileSync(vp, 'utf8') : '# 腔调样本（voice）\n'
  const starting = nextSegmentNo(prev)
  const day = now.toISOString().slice(0, 10)
  const lines = []
  for (let i = 0; i < picks.length; i++) {
    lines.push(`### 第 ${starting + i} 段 · ${day} · 采自对话`, '', `她：「${picks[i]}」`, '')
  }
  const joined = prev.replace(/\s*$/, '')
  atomicWriteText(vp, `${joined}\n\n${lines.join('\n')}`)

  // core_changelog 记一行（格式：日期 | 文件 | 版本 | 改了什么（evidence: ...））
  const cl = join(dir, '00_core', 'core_changelog.md')
  const version = (() => {
    const raw = existsSync(cl) ? readFileSync(cl, 'utf8') : ''
    const vs = [...raw.matchAll(/voice\.md\s*\|\s*v(\d+)/g)].map((m) => Number(m[1]))
    return (vs.length ? Math.max(...vs) : 0) + 1
  })()
  const entry = `${day} | voice.md | v${String(version).padStart(3, '0')} | 口癖采集 ${picks.length} 句（人审后接受${proposalPath ? `，提案 ${proposalPath}` : ''}）\n`
  const clPrev = existsSync(cl) ? readFileSync(cl, 'utf8') : '# 核心层变更记录\n\n'
  atomicWriteText(cl, `${clPrev.replace(/\s*$/, '')}\n${entry}`)
  return { ok: true, added: picks.length, from: starting, to: starting + picks.length - 1, version }
}

/** 拒绝候选：记进 state，以后不再提 */
export function rejectVoice(dir, picks) {
  if (!picks.length) return { ok: false, reason: '没有选中任何一句' }
  const set = loadRejected(dir)
  for (const p of picks) set.add(norm(p))
  saveRejected(dir, set)
  return { ok: true, rejected: picks.length, total: set.size }
}

/** 已拒清单（给 CLI 看） */
export function listRejected(dir) {
  return [...loadRejected(dir)].sort()
}

/** 读提案文件（给 CLI 用） */
export function readProposal(dir, path) {
  return parseVoiceProposal(readFileSync(path, 'utf8'))
}

/** 列出 40_pending 下的提案文件（按名排序） */
export function listProposals(dir) {
  const d = join(dir, '40_pending')
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => /^voice-proposal-.*\.md$/.test(f))
    .sort()
    .map((f) => join(d, f))
}
