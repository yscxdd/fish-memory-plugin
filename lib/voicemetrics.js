// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * voicemetrics.js — "她说话的样子"八个可量化的维度（v0.60.0）。
 *
 * 为什么补这一格：我们已经有
 *   · `cliche.js`  测**套话**（7 族：破折号总结、模板安慰…）
 *   · `voice.js`   挖**口癖**（从她自己的话里采候选，人挑）
 *   · `gold` / `fidelity` 测**检索与保真**
 * 唯独没有"她说话像不像她"的**度量**——而这类指标恰好只能从她的原话里算，
 * 档案里已经有了（实测 165 条消息，其中她 98 条）。
 *
 * 八个维度借自 `性格与记忆系统-最终文件` 的验收清单（**那是别人的设计，我们没有抄代码，
 * 也没有抄它的人格卡结构**；只取"该量哪几样"这个问题本身，具体口径按我们的 soul/voice 重写）：
 *
 *   ① 句数分布       soul 说"每句 ≤2 句"
 *   ② 字数           中位/最长
 *   ③ 感叹号率       "语气词的密度比感叹号重要"（我们的 voice.md 原话）
 *   ④ 语气词密度     嗯 / …… / 啊
 *   ⑤ 动作描写率     "每 3 轮至少一次动作"
 *   ⑥ 自称率         "每句都有自称"
 *   ⑦ 禁用词命中     设定 / 提示词 / 你假装 / 你必须 / 本质上
 *   ⑧ 总结句命中     总的来说 / 其实我想说的是…
 *
 * 三条硬约束：
 *   · **只读**——不写任何文件，不改任何点；
 *   · **只统计她的消息**（role === 'assistant'），他的不算（那是"她学得像不像"，不是"他像不像"）；
 *   · **空档案要明说"没有数据"**，不许把 0 条算成 0% 好看。
 */

import { readArchive } from './toolkit.js'
import { splitSentences } from './voice.js'

/** 我们的 soul/voice 口径 */
export const TARGETS = Object.freeze({
  maxSentences: 2, // 每句 ≤2 句
  actionEveryTurns: 3, // 每 3 轮至少一次动作描写
  selfRefRate: 1, // 每句都有自称
  exclaimMax: 0.1, // 感叹号率（每句）
})

export const BANNED = ['设定', '提示词', '你假装', '你必须', '本质上', '作为一个AI', '作为 AI']
export const SUMMARY_PHRASES = ['总的来说', '总而言之', '其实我想说的是', '希望这些建议', '希望能帮到你']
export const PARTICLES = ['嗯', '……', '啊', '呢', '吧', '嘛']
export const ACTIONS = ['看', '放', '推', '点头', '低头', '笑', '叹', '伸手', '转', '站', '坐', '走']

const SELF_REF = /(我|咱)/

/**
 * 这条算"她说话"，还是"她的工作产出"？（v0.60.0 实测踩到的坑）
 *
 * 第一次跑出来：句数 ≥3 占 70%、自称率 19%、中位 1612 字——**全是红的**。
 * 原因不是她说话变味，是**档案里 99 条"她"的消息几乎全是开发报告**（markdown、代码块、表格）。
 * 拿工作产出量"说话的样子"，量出来的只能是"报告写得长"。
 *
 * 所以先分流：带代码块 / 表格 / 大标题 / 超长的，算 work，不计入语音度量。
 * **被排除多少条要说出来**——不然"样本 3 条"和"样本 99 条"看起来一样可信。
 */
export function isCompanionSpeech(text, { maxChars = 240 } = {}) {
  const s = String(text || '')
  if (!s.trim()) return false
  if (s.length > maxChars) return false
  if (s.includes('```')) return false
  if (/^\s*\|/m.test(s)) return false
  if (/^\s*#{2,}\s/m.test(s)) return false
  if (/^\s*[-*]\s+\S+/m.test(s) && s.length > 120) return false
  return true
}

/** 从一条消息里数出八维需要的原始计数 */
export function inspectMessage(text) {
  const raw = String(text || '').trim()
  if (!raw) {
    return { sentences: 0, chars: 0, exclaim: 0, particles: 0, actions: 0, selfRef: 0, banned: 0, summary: 0 }
  }
  const sentences = splitSentences(raw).filter(Boolean)
  const n = Math.max(1, sentences.length)
  return {
    sentences: sentences.length,
    chars: raw.length,
    exclaim: (raw.match(/[！!]/g) || []).length,
    // 语气词按"每句出现一次"计，不按字数（否则"嗯嗯嗯"会把密度刷爆）
    particles: sentences.filter((s) => PARTICLES.some((p) => s.includes(p))).length,
    actions: sentences.filter((s) => ACTIONS.some((a) => s.includes(a))).length,
    selfRef: sentences.filter((s) => SELF_REF.test(s)).length,
    banned: BANNED.filter((b) => raw.includes(b)).length,
    summary: SUMMARY_PHRASES.filter((p) => raw.includes(p)).length,
  }
}

const pct = (a, b) => (b > 0 ? a / b : 0)

/**
 * 跑一次度量。
 * @param {string} dir 记忆库
 * @param {{limit?:number, sample?:object[]}} [opts] sample 可直接喂消息（测试用）
 */
export function voiceMetrics(dir, { sample = null } = {}) {
  const all = sample || (() => {
    try {
      return readArchive(dir).messages.filter((m) => m.role === 'assistant')
    } catch {
      return []
    }
  })()
  // 只量"说话"，不量"工作产出"（见 isCompanionSpeech 的理由）
  const msgs = sample ? sample : all.filter((m) => isCompanionSpeech(m.text))
  const excluded = all.length - msgs.length

  if (!msgs.length) {
    return {
      ok: false,
      empty: true,
      total: 0,
      excluded: all.length,
      reason: all.length
        ? `她的 ${all.length} 条消息全是工作产出（长文/代码/表格），没有可量的"说话"——不是 0 分，是没有样本`
        : '档案里还没有她的消息——这份度量没有数据可算（不是 0 分）',
    }
  }

  const acc = { sentences: 0, chars: 0, exclaim: 0, particles: 0, actions: 0, selfRef: 0, banned: 0, summary: 0 }
  const sentenceHist = { 1: 0, 2: 0, more: 0 }
  let longest = 0

  for (const m of msgs) {
    const r = inspectMessage(m.text)
    for (const k of Object.keys(acc)) acc[k] += r[k]
    if (r.sentences <= 1) sentenceHist[1] += 1
    else if (r.sentences === 2) sentenceHist[2] += 1
    else sentenceHist.more += 1
    longest = Math.max(longest, r.chars)
  }

  const n = msgs.length
  const s = Math.max(1, acc.sentences)

  const rows = [
    {
      key: 'sentences',
      name: '句数分布',
      value: `1 句 ${Math.round(pct(sentenceHist[1], n) * 100)}% · 2 句 ${Math.round(pct(sentenceHist[2], n) * 100)}% · ≥3 句 ${Math.round(pct(sentenceHist.more, n) * 100)}%`,
      ok: pct(sentenceHist.more, n) <= 0.15,
      hint: `soul：「每句 ≤${TARGETS.maxSentences} 句」；≥3 句的比例应很低`,
    },
    {
      key: 'chars',
      name: '字数',
      value: `中位 ${median(msgs.map((m) => String(m.text || '').length))} 字 · 最长 ${longest} 字`,
      ok: true, // 字数只做参考，不判红
      hint: '只做参考：太长会挤掉别人的话',
    },
    {
      key: 'exclaim',
      name: '感叹号率',
      value: `${(pct(acc.exclaim, s)).toFixed(2)} / 句`,
      ok: pct(acc.exclaim, s) <= TARGETS.exclaimMax,
      hint: `voice：「语气词的密度比感叹号重要」；≤${TARGETS.exclaimMax} 算稳`,
    },
    {
      key: 'particles',
      name: '语气词密度',
      value: `${(pct(acc.particles, s)).toFixed(2)} / 句`,
      ok: true,
      hint: '只做参考：太低会显得不像她，太高会腻',
    },
    {
      key: 'actions',
      name: '动作描写',
      value: `每 3 轮 ${(pct(acc.actions, s) * TARGETS.actionEveryTurns).toFixed(1)} 次`,
      ok: pct(acc.actions, s) >= 0.25,
      hint: 'voice：「每 3 轮至少一次动作」→ 每句 ≥0.33 就达标，这里放宽到 0.25',
    },
    {
      key: 'selfRef',
      name: '自称率',
      value: `${Math.round(pct(acc.selfRef, s) * 100)}%`,
      ok: pct(acc.selfRef, s) >= 0.8,
      hint: '「每句都有自称」——低于 80% 说明她在说"没有主语的话"',
    },
    {
      key: 'banned',
      name: '禁用词',
      value: `${acc.banned} 次`,
      ok: acc.banned === 0,
      hint: `出现即红：${BANNED.join(' / ')}`,
    },
    {
      key: 'summary',
      name: '总结句',
      value: `${acc.summary} 次`,
      ok: acc.summary === 0,
      hint: `出现即红：${SUMMARY_PHRASES.join(' / ')}`,
    },
  ]

  return {
    ok: rows.every((r) => r.ok),
    empty: false,
    total: n,
    excluded,
    sentences: acc.sentences,
    rows,
  }
}

function median(nums) {
  const a = nums.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return 0
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}
