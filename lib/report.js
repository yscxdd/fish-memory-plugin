// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 静态报告（v0.45.0，A 组；v0.46.0 补新鲜度与运行时三态）。一页 HTML，双击就开，**只读**。
 *
 * 为什么用静态文件而不是面板：
 *   · 面板（client 插件）要维护第二套宿主口子，hostcheck 盖不到；
 *   · 可写面板 = 第二个写入口，会绕过 audit / origin / version / tamper；
 *   · 报告是**快照**，文件里写着生成时间——不会像面板那样看起来"实时"其实过期。
 *
 * 四条规矩：
 *   ① 不联网、不引用外部资源（单文件，内联 CSS）；
 *   ② 只读：生成报告不改任何状态（连索引都不重建）；
 *   ③ 数据出界一律转义（文件名、原话里可能有 `</script>` 之类）；
 *   ④ **某一块读不到不该拖垮整页**——该块显示"无数据"，其余照常（借自《状态面板》第 5 步）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { readJsonSafe } from './util.js'

const fmtTime = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—')

/** 某一块读失败不该拖垮整页 */
function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

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

/**
 * 数据新鲜度（v0.46.0，借自《状态面板·构建说明书》3.6）。
 *
 * 为什么值得做：**一眼看出哪块数据是死的**。
 * "点数 0"和"点数 0 但三天没变过"是两件事——后者说明她这段时间根本没被推动过。
 * @returns {{exists:boolean, ageMin:number|null, at:string|null}}
 */
export function freshness(dir, rel, now = new Date()) {
  const abs = join(dir, rel)
  if (!existsSync(abs)) return { exists: false, ageMin: null, at: null }
  try {
    const st = statSync(abs)
    return {
      exists: true,
      ageMin: Math.max(0, Math.round((now.getTime() - st.mtimeMs) / 60000)),
      at: new Date(st.mtimeMs).toISOString(),
    }
  } catch {
    return { exists: false, ageMin: null, at: null }
  }
}

/**
 * 运行时三态（v0.46.0，借自同一份文档的顶部条）。
 *
 * 我们反复踩的坑是"插件其实没加载"（v0.42 那次：profile bundles 里没有它，
 * 重启也白搭，而界面看起来一切正常）。所以报告第一行必须回答：
 * **现在跑的是哪一版、和磁盘一不一致、什么时候启动的。**
 */
export function runtimeInfo(dir) {
  // 插件自己的 package.json（相对本文件，而不是相对记忆库——记忆库可能在别处）
  const own = safe(() => readJsonSafe(fileURLToPath(new URL('../package.json', import.meta.url)), null), null)
  const boot = safe(() => readJsonSafe(join(dir, '20_state', 'boot.json'), null), null)
  let last = null
  try {
    const lines = readFileSync(join(dir, '50_log', 'host.log'), 'utf8').trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i])
        if (row.plugin) {
          last = row
          break
        }
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    last = null
  }
  return {
    running: !!boot,
    bootAt: boot?.at || null,
    plugin: last?.plugin || null,
    lib: last?.lib || null,
    startedAt: last?.at || null,
    disk: own?.version || null,
    match: !!(last?.plugin && own?.version && last.plugin === own.version),
  }
}

/** 收集报告数据（只读；每块都兜住） */
export function collectReport(dir, { now = new Date() } = {}) {
  const points = safe(() => readPointFiles(dir, '30_points'), [])
  const pending = safe(() => readPointFiles(dir, '40_pending'), [])
  const st = safe(() => loadEmotion(dir), null)
  const presence = safe(() => loadPresence(dir), null)
  const sleep = safe(() => loadSleep(dir), null)
  const qs = safe(() => openQuestions(dir), [])
  const topQ = qs
    .map((q) => ({ ...q, tension: Math.round(safe(() => tensionOf(q, now), 0)) }))
    .sort((a, b) => b.tension - a.tension)
    .slice(0, 5)
  const ws = safe(() => indexStats(dir), { exists: false, roots: 0, count: 0, at: null, truncated: false })
  const roots = safe(() => listAll(dir), [])
  const es = safe(() => everythingStatus(dir), { enabled: false, available: false, source: 'none', reason: '读不到' })
  const tamper = safe(() => recentTamper(dir, 5), [])
  const m = safe(() => maturity(dir, { now }), { level: null, label: '' })
  const stats = safe(() => computeStats(dir, { now }), null)
  const habits = safe(() => habitsSummary(dir), null)

  return {
    at: now.toISOString(),
    runtime: safe(() => runtimeInfo(dir), { running: false, match: false }),
    fresh: {
      emotion: freshness(dir, join('20_state', 'emotion.json'), now),
      presence: freshness(dir, join('20_state', 'presence.json'), now),
      points: freshness(dir, '30_points', now),
      pending: freshness(dir, '40_pending', now),
      questions: freshness(dir, join('20_state', 'questions.json'), now),
      workspaces: freshness(dir, join('20_state', 'file-index.json'), now),
      tamper: freshness(dir, join('50_log', 'tamper.log'), now),
      habits: freshness(dir, join('20_state', 'habits.json'), now),
    },
    maturity: m,
    counts: {
      points: points.length,
      pending: pending.length,
      questions: qs.length,
    },
    emotion: {
      tier: Number(st?.tier ?? 3),
      label: TIER_TEXT[Number(st?.tier ?? 3)] || '',
      line: safe(() => emotionLine(st, now)?.text || '', ''),
      specials: safe(() => specialsLine(st) || '', ''),
      valence: st?.ai?.valence,
      arousal: st?.ai?.arousal,
    },
    presence: { gapHours: safe(() => gapHours(presence, now), null), lastSeen: presence?.lastSeen || null },
    sleep: { lastSleepAt: sleep?.lastSleepAt || null, nights: sleep?.nights || 0 },
    questions: topQ,
    workspaces: { ...ws, roots },
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
  const rt = d.runtime || {}

  const ageText = (f) => {
    if (!f || !f.exists) return '无数据'
    if (f.ageMin == null) return '—'
    if (f.ageMin < 1) return '刚刚'
    if (f.ageMin < 60) return `${f.ageMin} 分钟前`
    if (f.ageMin < 1440) return `${Math.round(f.ageMin / 60)} 小时前`
    return `${Math.round(f.ageMin / 1440)} 天前`
  }
  const fresh = (key, file) => `<div class="fresh">来源 ${esc(file)} · ${ageText(d.fresh?.[key])}</div>`

  const pendingList = d.recentPending.length
    ? d.recentPending.map((p) => `<li><code>${esc(p.id)}</code> ${esc(p.title || '')}</li>`).join('')
    : '<li class="none">（空）</li>'
  const pointList = d.recentPoints.length
    ? d.recentPoints
        .map(
          (p) =>
            `<li><code>${esc(p.id)}</code> ${esc(p.date || '')} ${esc(p.title || '')} <span class="dim">${esc(p.cluster || '')}</span></li>`,
        )
        .join('')
    : '<li class="none">（还没有记忆点——她还没开始被养）</li>'
  const qList = d.questions.length
    ? d.questions.map((q) => `<li>张力 ${q.tension} · ${esc(q.text)}</li>`).join('')
    : '<li class="none">（没有悬着的问题）</li>'
  const tamperList = d.tamper.length
    ? d.tamper
        .map(
          (t) =>
            `<li>${fmtTime(t.at)} · ${esc(
              [...(t.changed || []), ...(t.added || []), ...(t.removed || [])].join(' / '),
            )}</li>`,
        )
        .join('')
    : '<li class="none">（没有）</li>'
  const rootList =
    (ws?.roots || [])
      .map((r) => `<li>${esc(r.path)} <span class="dim">${r.files} 个文件${r.exists ? '' : '（目录不在了）'}</span></li>`)
      .join('') || '<li class="none">（没有登记目录）</li>'

  const runtimeBar = rt.running
    ? `<div class="topbar ${rt.match ? 'ok' : 'warn'}">
  插件在跑 · 运行时 <b>${esc(rt.plugin || '未知')}</b>${rt.lib ? `（lib ${esc(rt.lib)}）` : ''} ·
  磁盘 <b>${esc(rt.disk || '未知')}</b> · ${rt.match ? '一致' : '<b>与磁盘不一致——要重载插件</b>'} ·
  启动于 ${esc(fmtTime(rt.startedAt || rt.bootAt))}
</div>`
    : `<div class="topbar warn">
  <b>插件没在跑</b>（没有 <code>boot.json</code>） · 上次加载 ${esc(fmtTime(rt.startedAt))} · 磁盘 ${esc(rt.disk || '未知')}
  <div class="hint">界面上看起来一切正常也可能没加载——v0.42 踩过这个坑：profile 的 bundles 里少了插件名，重启也不生效。</div>
</div>`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>大肥鱼 · 状态报告 ${esc(fmtTime(d.at))}</title>
<style>
:root{--fg:#1c1c1e;--dim:#7a7a80;--line:#e6e6ea;--bg:#fbfbfd;--warn:#b4442e;--ok:#2e7d4f}
*{box-sizing:border-box}
body{margin:0;padding:28px;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--dim);font-size:12px;margin-bottom:14px}
.topbar{border-radius:8px;padding:9px 12px;margin:0 0 16px;font-size:12.5px;border:1px solid var(--line);background:#fff}
.topbar.ok{border-color:#bfe0cb;color:#22643f}
.topbar.warn{border-color:#f0cfc7;color:#8f3a25}
.hint{margin-top:4px;font-size:11.5px;opacity:.85}
.fresh{margin-top:9px;font-size:11.5px;color:var(--dim)}
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
${runtimeBar}

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
    ${fresh('emotion', '20_state/emotion.json')}
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
    ${fresh('points', '30_points/')}
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
    <div class="fresh">来自配置与上一轮拼装结果</div>
  </div>

  <div class="card">
    <h2>安全</h2>
    <table>
      ${rowHtml('篡改告警', d.tamper.length ? `<span class="warn">${d.tamper.length} 次（见下）</span>` : '<span class="ok">没有</span>')}
      ${row('脱敏待处理', d.stats?.redactionPending != null ? String(d.stats.redactionPending) : '—')}
      ${rowHtml('审计', d.stats?.audit === 'fail' ? '<span class="warn">有阻塞项</span>' : '<span class="ok">通过</span>')}
    </table>
    ${fresh('tamper', '50_log/tamper.log')}
  </div>

  <div class="card">
    <h2>文件索引</h2>
    <table>
      ${row('登记目录', String(ws?.roots?.length ?? 0))}
      ${row('索引文件', String(ws?.count ?? 0))}
      ${row('上次索引', ws?.at ? fmtTime(ws.at) : '未建')}
      ${rowHtml('Everything', es?.available ? `<span class="ok">可用</span>（${esc(es.source)}）` : '不可用')}
    </table>
    <ul>${rootList}</ul>
    ${fresh('workspaces', '20_state/file-index.json')}
  </div>

  <div class="card">
    <h2>悬着的问题</h2>
    <ul>${qList}</ul>
    ${fresh('questions', '20_state/questions.json')}
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
    ${fresh('pending', '40_pending/')}
  </div>
  <div class="card">
    <h2>核心层改动</h2>
    <ul>${tamperList}</ul>
  </div>
</div>

<footer>大肥鱼记忆插件 · 由 <code>memory report</code> 生成 · 数据全部在本机</footer>
</body></html>`
}

/** 写报告文件；返回路径（目录不存在会先建——新库第一次跑就在这儿栽过） */
export function writeReport(dir, { now = new Date(), out = null } = {}) {
  const data = collectReport(dir, { now })
  const html = renderReport(data)
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = out || join(dir, '90_snapshot', `report-${stamp}.html`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html, 'utf8')
  return { path, bytes: Buffer.byteLength(html, 'utf8'), data }
}
