// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 「她的今天」页面（v0.63.0）—— serve 的 /today 与 /dashboard。
 *
 * 为什么放在 serve 里而不是新开一个服务：**只绑 127.0.0.1** 已经是既有约定，
 * 再开一个端口就多一处要记得关的东西。
 *
 * 为什么在 scripts/ 而不是 lib/：页面里的脚本要请求 /today，
 * 而 lib/ 的契约是「不发网络请求、无遥测」（audit-self 会拦，拦得对）。
 * 这份是给人看的渲染件，不是运行时逻辑。
 *
 * 页面是**薄薄一层**：拿 /today 的 JSON 渲染，2 秒轮一次。
 * 不做客户端插件（那要维护前端构建），也不画情绪曲线（那是把人当仪表盘）。
 */

/** 页面用到的数据接口（纯函数，方便测试） */
export function dashboardPaths() {
  return { data: '/today', html: '/dashboard' }
}

/** 自包含 HTML：无外链、无构建、无依赖 */
export function renderDashboardHtml({ refreshMs = 2000 } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她今天</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e7e9ee;--dim:#9aa3b2;--ok:#7bd88f;--warn:#e0b25e}
  @media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ec;--fg:#1c2026;--dim:#6b7280}}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 18px 40px;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  h1{font-size:16px;margin:0 0 4px;font-weight:600}
  .sub{color:var(--dim);font-size:12px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:12px;color:var(--dim);margin:0 0 10px;font-weight:600;letter-spacing:.04em}
  .big{font-size:18px;margin:0}
  .detail{color:var(--dim);font-size:12px;margin-top:6px}
  .tags{margin:8px 0 0;padding:0;list-style:none}
  .tags li{display:inline-block;margin:0 6px 6px 0;padding:2px 9px;border:1px solid var(--line);border-radius:999px;font-size:12px}
  footer{color:var(--dim);font-size:11px;margin-top:18px;line-height:1.8}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;vertical-align:middle}
  .dot.off{background:var(--warn)}
</style>
</head>
<body>
  <h1><span class="dot" id="dot"></span>她今天</h1>
  <div class="sub" id="sub">载入中…</div>

  <div class="card"><h2>心情</h2><p class="big" id="mood">—</p><div class="detail" id="moodDetail"></div></div>
  <div class="card"><h2>聊了</h2><p class="big" id="talk">—</p></div>
  <div class="card"><h2>记住</h2><p class="big" id="remembered">—</p><ul class="tags" id="rememberedTags"></ul></div>
  <div class="card"><h2>写了</h2><p class="big" id="drafts">—</p></div>
  <div class="card"><h2>悬着</h2><p class="big" id="hanging">—</p></div>
  <div class="card"><h2>到期</h2><p class="big" id="due">—</p><ul class="tags" id="dueTags"></ul></div>

  <footer>
    只读页面：不补算、不写入。<br>
    仅绑定 127.0.0.1，别把端口转发出去。<br>
    每 ${Math.round(refreshMs / 1000)} 秒刷新一次。
  </footer>

<script>
const $ = (id) => document.getElementById(id)
const tags = (el, list) => { el.innerHTML = ''; (list || []).forEach((t) => { const li = document.createElement('li'); li.textContent = t; el.appendChild(li) }) }
async function tick() {
  try {
    const r = await fetch('/today', { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const v = await r.json()
    $('dot').className = 'dot'
    $('sub').textContent = v.day + ' 周' + v.weekday + ' · ' + new Date(v.at).toLocaleTimeString()
    $('mood').textContent = v.mood.ok ? v.mood.text : '（无数据）'
    $('moodDetail').textContent = v.mood.detail || ''
    $('talk').textContent = v.talk.text
    $('remembered').textContent = v.remembered.text
    tags($('rememberedTags'), v.remembered.titles)
    $('drafts').textContent = v.drafts.text
    $('hanging').textContent = v.hanging.text + (v.hanging.tension ? '（张力 ' + v.hanging.tension + '）' : '')
    $('due').textContent = v.due.text
    tags($('dueTags'), v.due.titles)
  } catch (e) {
    $('dot').className = 'dot off'
    $('sub').textContent = '连不上记忆服务（' + e.message + '）'
  }
}
tick()
setInterval(tick, ${Number(refreshMs) || 2000})
</script>
</body>
</html>`
}
