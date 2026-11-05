// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * today.js — 「她的今天」一屏（v0.63.0）。
 *
 * 为什么是这几行：人想看的不是运维指标，是**"她今天过得怎么样"**。
 * 所以只回答六个问题：
 *
 *   心情   —— 档位用**句子**（"有点生气（他让我降温）"），不用刻度盘。
 *             数字摆出来人就会想调一格，那是把人当仪表盘。
 *   聊了   —— 今天几轮、谁说的多。
 *   记住   —— 今天进库的点（按 salience 取前几条）。
 *   写了   —— 今天待审的草稿**条数**（内容留在 40_pending，不上首页）。
 *   悬着   —— 她放不下的事，只给 tension 最高的一条。
 *   到期   —— 今天到期的承诺/事件。
 *
 * 三条纪律：
 *   ① **只读**——不改任何状态（连 emotion 的 drift 都不补算）；
 *   ② **某一块读不到不拖垮整屏**——该块显示"无数据"，其余照常；
 *   ③ 每条都给"为什么"，光给结论等于没给。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { EMOTION_FILE, TIER_TEXT, loadEmotion } from './emotion.js'
import { rankedQuestions } from './questions.js'
import { readArchive, readPointFiles } from './toolkit.js'
import { localDay } from './util.js'

const clip = (s, n = 28) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const safe = (fn, fallback) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** 心情：档位 + 原因 + 解冻时间 */
export function moodOf(dir, now = new Date()) {
  const st = safe(() => loadEmotion(dir), null)
  if (!existsSync(join(dir, EMOTION_FILE)) || !st) return { ok: false, text: '无数据', detail: '' }
  const tier = Number.isFinite(Number(st.tier)) ? Number(st.tier) : 3
  const label = TIER_TEXT[tier] || '平静'
  const cause = st.tierCause ? `（${clip(st.tierCause, 20)}）` : ''
  const frozen = Number(st.frozenUntil) || 0
  let freezeText = ''
  if (frozen > now.getTime()) {
    const mins = Math.max(1, Math.round((frozen - now.getTime()) / 60000))
    const until = new Date(frozen)
    freezeText = `· 到 ${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')} 解冻（还有 ${mins} 分钟）`
  }
  return {
    ok: true,
    tier,
    label,
    cause: st.tierCause || '',
    text: `${label}${cause}`,
    detail: freezeText,
    // 数值只放进 JSON（给人核对），不上屏
    valence: st.ai?.valence ?? null,
    arousal: st.ai?.arousal ?? null,
    turns: st.turns ?? 0,
  }
}

/** 今天聊了多少：按角色数消息 */
export function talkOf(dir, now = new Date()) {
  const today = localDay(now)
  const msgs = safe(() => readArchive(dir).messages, [])
  const mine = msgs.filter((m) => String(m.ts || '').slice(0, 10) === today)
  const user = mine.filter((m) => m.role === 'user').length
  const assistant = mine.filter((m) => m.role === 'assistant').length
  return {
    ok: mine.length > 0,
    total: mine.length,
    user,
    assistant,
    text: mine.length ? `${mine.length} 句（你说 ${user} 句，她说 ${assistant} 句）` : '今天还没说话',
  }
}

/** 今天进库的点（按 salience） */
export function rememberedOf(dir, now = new Date(), { limit = 4 } = {}) {
  const today = localDay(now)
  const points = safe(() => readPointFiles(dir, '30_points'), [])
  const todays = points
    .filter((p) => String(p.date || '') === today)
    .sort((a, b) => (b.salience || 0) - (a.salience || 0))
  return {
    ok: todays.length > 0,
    count: todays.length,
    titles: todays.slice(0, limit).map((p) => clip(p.title, 16)),
    text: todays.length ? `${todays.length} 件` : '今天还没记住什么',
  }
}

/** 待审草稿：只给条数，内容留在线下 */
export function draftsOf(dir) {
  const dirPath = join(dir, '40_pending')
  if (!existsSync(dirPath)) return { ok: false, count: 0, text: '无目录' }
  // 口径必须和 scanPointFiles 一致：README / TEMPLATE / 没有 front matter 的都**不是草稿**。
  // （第一版数成了"1 条待审"，其实是 40_pending/README.md —— 那种错会让人白跑一趟。）
  const files = safe(
    () =>
      readdirSync(dirPath).filter((f) => {
        if (!f.endsWith('.md')) return false
        if (/^(README|TEMPLATE)/i.test(f)) return false
        try {
          return /^---\r?\n/.test(readFileSync(join(dirPath, f), 'utf8'))
        } catch {
          return false
        }
      }),
    [],
  )
  return {
    ok: true,
    count: files.length,
    text: files.length ? `${files.length} 条待你过闸` : '没有待审的',
  }
}

/** 她放不下的事：只给 tension 最高的一条 */
export function hangingOf(dir, now = new Date()) {
  const open = safe(() => rankedQuestions(dir, now), [])
  const top = open[0]
  if (!top) return { ok: false, count: 0, text: '没有悬着的', tension: 0 }
  return {
    ok: true,
    count: open.length,
    text: clip(top.text, 24),
    tension: Math.round(top.now_tension ?? 0),
  }
}

/** 今天到期 **以及已经逾期** 的承诺/事件 */
export function dueTodayOf(dir, now = new Date()) {
  const today = localDay(now)
  const points = safe(() => readPointFiles(dir, '30_points'), [])
  const dated = points
    .filter((p) => (p.type === 'promise' || p.type === 'event') && typeof p.due === 'string' && p.due)
    .filter((p) => p.status === 'active')
  const todayDue = dated.filter((p) => p.due === today)
  const overdue = dated.filter((p) => p.due < today).sort((a, b) => String(a.due).localeCompare(String(b.due)))
  const parts = []
  if (overdue.length) parts.push(`${overdue.length} 件逾期`)
  if (todayDue.length) parts.push(`${todayDue.length} 件今天`)
  return {
    ok: todayDue.length + overdue.length > 0,
    count: todayDue.length + overdue.length,
    today: todayDue.length,
    overdue: overdue.length,
    // 逾期排前面：那是最该被看见的
    titles: [...overdue, ...todayDue].slice(0, 3).map((p) => (p.due < today ? `逾期 ${p.due.slice(5)} ${clip(p.title, 12)}` : clip(p.title, 16))),
    text: parts.length ? parts.join('、') : '今天没有到期的，也没有逾期的',
  }
}

/**
 * 一屏数据。**纯只读**：不补算 drift、不 touch 问题、不写任何文件。
 */
export function todayView(dir, now = new Date()) {
  const day = localDay(now)
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  return {
    at: now.toISOString(),
    day,
    weekday,
    mood: moodOf(dir, now),
    talk: talkOf(dir, now),
    remembered: rememberedOf(dir, now),
    drafts: draftsOf(dir),
    hanging: hangingOf(dir, now),
    due: dueTodayOf(dir, now),
  }
}

/** 终端一屏 */
export function renderToday(v) {
  const lines = [`她今天 · ${v.day.slice(5)} 周${v.weekday}`, '']
  const row = (label, text, detail = '') => lines.push(`  ${label}　　${text}${detail ? ` ${detail}` : ''}`)
  row('心情', v.mood.text, v.mood.detail)
  row('聊了', v.talk.text)
  row('记住', v.remembered.text + (v.remembered.titles.length ? `「${v.remembered.titles.join('」「')}」` : ''))
  row('写了', v.drafts.text)
  row('悬着', v.hanging.text + (v.hanging.tension ? `（张力 ${v.hanging.tension}）` : ''))
  row('到期', v.due.text + (v.due.titles.length ? `「${v.due.titles.join('」「')}」` : ''))
  return lines.join('\n')
}
