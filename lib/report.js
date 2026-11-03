// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 静态报告（v0.45.0，A 组）——一页 HTML，双击就开，**只读**。
 *
 * 为什么用静态文件而不是面板：
 *   · 面板（client 插件）要维护第二套宿主口子，hostcheck 盖不到；
 *   · 可写面板 = 第二个写入口，会绕过 audit / origin / version / tamper；
 *   · 报告是**快照**，文件里写着生成时间——不会像面板那样看起来"实时"其实过期。
 *
 * 三条规矩：
 *   ① 不联网、不引用外部资源（单文件，内联 CSS）；
 *   ② 只读：生成报告不改任何状态（连索引都不重建）；
 *   ③ 数据出界一律转义（文件名、原话里可能有 `</script>` 之类）。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TIER_TEXT, emotionLine, loadEmotion, specialsLine } from './emotion.js'
import { gapHours, loadPresence } from './presence.js'
import { loadSleep } from './sleep.js'
import { indexStats, listAll } from './workspaces.js'
import { everythingStatus } from './everything.js'
import { recentTamper } from './tamper.js'
import { openQuestions, tensionOf } from './questions.js'
import { readPointFiles } from './toolkit.js'
import { computeStats, maturity } from './stats.js'
import { habitsSummary } from './habits.js'
import { DEFAULT_BUDGET, INJECT_HARD_CAP } from './render.js'

/**
 * HTML 转义。文件名、原话里可能有 `<`、`</script>` 之类——报告是给人用浏览器打开的，
 * 不转义就等于让数据变成标记。
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const fmtTime = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—')

/** 收集报告数据（只读） */
export function collectReport(dir, { now = new Date() } = {}) {
  const points = readPointFiles(dir, '30_points')
  const pending = readPointFiles(dir, '40_pending')
  const st = loadEmotion(dir)
  const presence = loadPresence(dir)
  const sleep = loadSleep(dir)
  const qs = openQuestions(dir)
  const topQ = qs
    .map((q) => ({ ...q, tension: Math.round(tensionOf(q, now)) }))
    .sort((a, b) => b.tension - a.tension)
    .slice(0, 5)
  const ws = indexStats(dir)
  const es = everythingStatus(dir)
  const tamper = recentTamper(dir, 5)
  const m = maturity(dir, { now })
  let stats = null
  try {
    stats = computeStats(dir, { now })
  } catch {
    stats = null
  }
  let habits = null
  try {
    habits = habitsSummary(dir)
  } catch {
    habits = null
  }

  return {
    at: now.toISOString(),
    maturity: m,
    counts: {
      points: points.length,
      pending: pending.length,
      questions: qs.length,
    },
    emotion: {
      tier: Number(st?.tier ?? 3),
      label: TIER_TEXT[Number(st?.tier ?? 3)] || '',
      line: emotionLine(st, now)?.text || '',
      specials: specialsLine(st) || '',
      valence: st?.ai?.valence,
      arousal: st?.ai?.arousal,
    },
    presence: { gapHours: gapHours(presence, now), lastSeen: presence?.lastSeen || null },
    sleep: { lastSleepAt: sleep?.lastSleepAt || null, nights: sleep?.nights || 0 },
    questions: topQ,
    workspaces: { ...ws, roots: listAll(dir) },
    everything: es,
    tamper,
    habits,
    stats,
    budget: { ...DEFAULT_BUDGET, hardCap: INJECT_HARD_CAP },
    recentPoints: points
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 10),
    recentPending: pending.slice(-10),
  }
}

const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`
/** 值是我们自己拼的标记（红/绿徽标），不能再转义一次 */
const rowHtml = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`

/** 生成 HTML（自包含） */
export function renderReport(data) {
  const d = data
  const m = d.maturity || {}
  const emo = d.emotion
  const ws = d.workspaces
  const es = d.everything
  const pendingList = d.recentPending.length
    ? d.recentPending.map((p) => `<li><code>${esc(p.id)}</code> ${esc(p.title || '')}</li>`).join('')
    : '<li class="none">（空）</li>'
  const pointList = d.recentPoints.length
    ? d.recentPoints
        .map((p) => `<li><code>${esc(p.id)}</code> ${esc(p.date || '')} ${esc(p.title || '')} <span class="dim">${esc(p.cluster || '')}</span></li>`)
        .join('')
    : '<li class="none">（还没有记忆点——她还没开始被养）</li>'
  const qList = d.questions.length
    ? d.questions.map((q) => `<li>张力 ${q.tension} · ${esc(q.text)}</li>`).join('')
    : '<li class="none">（没有悬着的问题）</li>'
  const tamperList = d.tamper.length
    ? d.tamper
        .map((t) => `<li>${fmtTime(t.at)} · ${esc([...(t.changed || []), ...(t.added || []), ...(t.removed || [])].join(' / '))}</li>`)
        .join('')
    : '<li class="none">（没有）</li>'
  const rootList = (ws?.roots || [])
    .map((r) => `<li>${esc(r.path)} <span class="dim">${r.files} 个文件${r.exists ? '' : '（目录不在了）'}</span></li>`)
    .join('') || '<li class="none">（没有登记目录）</li>'

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>大肥鱼 · 状态报告 ${esc(fmtTime(d.at))}</title>
<style>
:root{--fg:#1c1c1e;--dim:#7a7a80;--line:#e6e6ea;--bg:#fbfbfd;--warn:#b4442e;--ok:#2e7d4f}
*{box-sizing:border-box}
body{margin:0;padding:28px;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--dim);font-size:12px;margin-bottom:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h2{font-size:13px;margin:0 0 10px;color:var(--dim);font-weight:600;letter-spacing:.02em}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--dim);padding:3px 8px 3px 0;white-space:nowrap;vertical-align:top;width:38%}
td{padding:3px 0}
ul{margin:0;padding-left:18px}
li{margin:2px 0}
code{font:12px ui-monospace,Consolas,monospace;background:#f1f1f4;padding:1px 4px;border-radius:4px}
.dim,.none{color:var(--dim)}
.warn{color:var(--warn);font-weight:600}
.ok{color:var(--ok);font-weight:600}
.tier{font-size:22px;font-weight:600;margin:0 0 4px}
footer{margin-top:22px;color:var(--dim);font-size:12px}
</style></head><body>
<h1>大肥鱼 · 状态报告</h1>
<div class="sub">生成于 ${esc(fmtTime(d.at))} · 只读快照 · 这个页面不会自己更新</div>

<div class="grid">
  <div class="card">
    <h2>她现在的状态</h2>
    <p class="tier">tier ${esc(String(emo.tier))} ${esc(emo.label)}</p>
    <table>
      ${row('情绪行', emo.line || '（不注入）')}
      ${row('挂着的', emo.specials || '无')}
      ${row('效价 / 唤醒', `${emo.valence ?? '—'} / ${emo.arousal ?? '—'}`)}
      ${row('上次睡醒', d.sleep.lastSleepAt ? `${fmtTime(d.sleep.lastSleepAt)}（累计 ${d.sleep.nights} 次）` : '还没睡过')}
      ${row('隔了多久', d.presence.gapHours == null ? '—' : `${Math.round(d.presence.gapHours * 10) / 10} 小时`)}
    </table>
  </div>

  <div class="card">
    <h2>规模</h2>
    <table>
      ${row('成熟度', `${m.level || '—'} ${m.label || ''}`)}
      ${row('记忆点', String(d.counts.points))}
      ${row('待审草稿', String(d.counts.pending))}
      ${row('悬着的问题', String(d.counts.questions))}
      ${row('自述', String(m.selfEssays ?? m.essays ?? 0))}
      ${row('习惯', d.habits ? `${d.habits.items?.length ?? 0} 条` : '—')}
    </table>
  </div>

  <div class="card">
    <h2>注入预算（tok）</h2>
    <table>
      ${row('核心', String(d.budget.core))}
      ${row('索引', String(d.budget.index))}
      ${row('正文', String(d.budget.body))}
      ${row('工作记忆', String(d.budget.work))}
      ${row('硬上限', String(d.budget.hardCap))}
      ${row('上轮实测', d.stats?.lastInjectionTokens != null ? String(d.stats.lastInjectionTokens) : '—')}
    </table>
  </div>

  <div class="card">
      ${rowHtml('篡改告警', d.tamper.length ? `<span class="warn">${d.tamper.length} 次（见下）</span>` : '<span class="ok">没有</span>')}
    <table>
      ${rowHtml('审计', d.stats?.audit === 'fail' ? '<span class="warn">有阻塞项</span>' : '<span class="ok">通过</span>')}
      ${row('脱敏待处理', d.stats?.redactionPending != null ? String(d.stats.redactionPending) : '—')}
      ${row('审计', d.stats?.audit === 'fail' ? '<span class="warn">有阻塞项</span>' : '<span class="ok">通过</span>')}
    </table>
  </div>

  <div class="card">
    <h2>文件索引</h2>
    <table>
      ${row('登记目录', String(ws?.roots?.length ?? 0))}
      ${rowHtml('Everything', es?.available ? `<span class="ok">可用</span>（${esc(es.source)}）` : '不可用')}
      ${row('上次索引', ws?.at ? fmtTime(ws.at) : '未建')}
      ${row('Everything', es?.available ? `<span class="ok">可用</span>（${esc(es.source)}）` : '不可用')}
    </table>
    <ul>${rootList}</ul>
  </div>

  <div class="card">
    <h2>悬着的问题</h2>
    <ul>${qList}</ul>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>最近的记忆点</h2>
    <ul>${pointList}</ul>
  </div>
  <div class="card">
    <h2>待审草稿（40_pending）</h2>
    <ul>${pendingList}</ul>
  </div>
  <div class="card">
    <h2>核心层改动</h2>
    <ul>${tamperList}</ul>
  </div>
</div>

<footer>大肥鱼记忆插件 · 由 <code>memory report --html</code> 生成 · 数据全部在本机</footer>
</body></html>`
}

/** 写报告文件；返回路径 */
export function writeReport(dir, { now = new Date(), out = null } = {}) {
  const data = collectReport(dir, { now })
  const html = renderReport(data)
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = out || join(dir, '90_snapshot', `report-${stamp}.html`)
  writeFileSync(path, html, 'utf8')
  return { path, bytes: Buffer.byteLength(html, 'utf8'), data }
}
