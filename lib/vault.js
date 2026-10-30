// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * vault.js — 把记忆库变成"能用 Obsidian / LogSeq 打开"的 vault（v0.12.0）。
 *
 * 为什么是这条：我们的库本来就有 front matter、`links`、`cluster`、`tags`，
 * 差的是两样——① `10_archive/*.jsonl` 不是 markdown，Obsidian 看不见；
 * ② 点的关系在前言数组里，图谱认不出来（它只认 `[[wikilink]]`）。
 *
 * 所以这里只生成**派生文件**，一个字节都不改真相层：
 *   20_index/views/YYYY-MM-DD.md   每天的档案 → 可读的日笔记
 *   20_index/index.md              入口：核心层/簇/最近/当天链接
 *   20_index/links.md              点与点的关系 → `[[wikilink]]`，喂给图谱
 *
 * 三条自我约束：
 *   ① **只写 20_index/**——那个目录本来就被 pack 排除、且可重建；
 *   ② 消息正文里的 `[[` 要拆开（插零宽空格），否则聊天里随手一个 `[[xx]]`
 *      就会在 Obsidian 里凭空长出一条图谱边；
 *   ③ **不打码**：vault 是给人看原文的镜像，打码只作用于"进模型"的路径。
 *      文件头会写明这一点，避免把它当成可外发的东西。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localDay } from './util.js'

const ZWSP = '\u200B'

/** 消息里伪造的 wikilink 要拆掉，不然图谱会多出边 */
export function neutralizeWikilinks(text) {
  return String(text || '').replace(/\[\[/g, `[${ZWSP}[`).replace(/\]\]/g, `]${ZWSP}]`)
}

function hhmm(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 一天的档案 → markdown。正文按引用块缩进，内容不改。 */
export function renderDayNote(day, messages) {
  const lines = [
    '---',
    `date: ${day}`,
    `messages: ${messages.length}`,
    'derived: true',
    '---',
    '',
    `# ${day} · ${messages.length} 条`,
    '',
    '> 这是**原文镜像**（由 `memory vault` 生成，可随时重建）。',
    '> 里面是逐字原文；要发给模型前请注意：这一段没有打码。',
    '',
  ]
  for (const m of messages) {
    const who = m.role === 'assistant' ? '她' : '他'
    lines.push(`## ${hhmm(m.ts)} ${who}`, '')
    const body = neutralizeWikilinks(String(m.text || '')).trim()
    for (const line of body.split(/\r?\n/)) lines.push(`> ${line}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 点与点的关系 → wikilink，给图谱用 */
export function renderLinksNote(points) {
  const lines = ['---', 'derived: true', '---', '', '# 记忆点的关系', '']
  const has = points.length > 0
  if (!has) lines.push('（还没有记忆点）')
  for (const p of points) {
    const mine = `[[${p.id}]]`
    for (const l of p.links || []) lines.push(`- ${mine} → [[${l}]]`)
    for (const c of p.contradicts || []) lines.push(`- ${mine} ↔ [[${c}]]（冲突）`)
    if (p.merged_into) lines.push(`- ${mine} → ${p.merged_into}（已升级进核心层）`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 入口页：让人（和 Obsidian 的 graph）有个起点 */
export function renderIndexNote({ dir, points, days, clusters, archiveCount, now = new Date() }) {
  const active = points.filter((p) => p.status === 'active')
  const lines = [
    '---',
    'derived: true',
    '---',
    '',
    '# 大肥鱼记忆库',
    '',
    `> 由 \`memory vault\` 生成于 ${now.toISOString().slice(0, 16).replace('T', ' ')}；本页与 views/ 都可重建，别手改。`,
    '',
    `- 记忆点：**${points.length}**（active ${active.length}）`,
    `- 档案：**${archiveCount}** 条，跨 ${days.length} 天`,
    '',
    '## 每天的原文',
    '',
    ...days.map((d) => `- [[${d}]]`),
    '',
    '## 核心层',
    '',
    ...['soul', 'user', 'relation', 'rules']
      .filter((f) => existsSync(join(dir, '00_core', `${f}.md`)))
      .map((f) => `- ${f}：\`00_core/${f}.md\``),
    '',
    '## 主题簇',
    '',
    ...(clusters.length ? clusters.map((c) => `- ${c}`) : ['（还没建索引）']),
    '',
    '## 关系',
    '',
    '- [[记忆点的关系]]',
    '',
    '## 怎么用',
    '',
    '1. 用 Obsidian **打开文件夹** → 选这个库的根目录（`fish-memory/`）；',
    '2. 首页设成 `20_index/index.md`（它在 `20_index/` 里，不在库根）；',
    '3. `Ctrl/Cmd+G` 看图谱——点之间的关系来自 `links.md`；',
    '4. 档案日笔记在 `20_index/views/`，每次跑 `memory vault` 刷新。',
    '',
    '**只读提醒**：这些是派生视图。要改记忆，走 `40_pending/` + `promote`，不要改这里。',
    '',
    '库根只放真相层（`00_core` / `10_archive` / `30_points` / `40_pending` / `50_log`）；入口页是生成物，下次会被覆盖。',
  ]
  return lines.join('\n')
}

/**
 * 生成整个 vault。
 *
 * @param {string} dir 记忆库根目录
 * @param {{days?:number, now?:Date, archive?:object[], points?:object[]}} [opts]
 *   `archive` / `points` 可注入（测试用）；不给就自己读。
 * @returns {{views:string[], index:string, links:string, days:number, messages:number}}
 */
export function writeVault(dir, { days: limitDays, now = new Date(), archive, points } = {}) {
  const outDir = join(dir, '20_index')
  const viewDir = join(outDir, 'views')
  mkdirSync(viewDir, { recursive: true })

  const messages = archive || readArchiveAll(dir)
  const pts = points || readPoints(dir)

  // 按天分组
  const byDay = new Map()
  for (const m of messages) {
    if (!m?.ts) continue
    const day = localDay(new Date(m.ts))
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(m)
  }
  let dayKeys = [...byDay.keys()].sort()
  if (Number.isFinite(limitDays) && limitDays > 0) dayKeys = dayKeys.slice(-limitDays)

  const views = []
  for (const day of dayKeys) {
    const file = join(viewDir, `${day}.md`)
    writeFileSync(file, renderDayNote(day, byDay.get(day)), 'utf8')
    views.push(file)
  }

  const clusters = readClusters(dir)
  const indexFile = join(outDir, 'index.md')
  writeFileSync(
    indexFile,
    renderIndexNote({ dir, points: pts, days: dayKeys, clusters, archiveCount: messages.length, now }),
    'utf8',
  )
  const linksFile = join(outDir, 'links.md')
  writeFileSync(linksFile, renderLinksNote(pts), 'utf8')

  return { views, index: indexFile, links: linksFile, days: dayKeys.length, messages: messages.length }
}

/** 读全部档案（原始 JSONL） */
export function readArchiveAll(dir) {
  const base = join(dir, '10_archive', 'messages')
  if (!existsSync(base)) return []
  const out = []
  for (const f of readdirSync(base).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(base, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 坏行跳过：vault 只是视图，不负责校验 */
      }
    }
  }
  return out
}

/** 读记忆点（只取做视图要用的字段）。
 *  排除规则与 `readPointFiles` 一致：`TEMPLATE*` 和 id 不合格式的都不算记忆点——
 *  否则模板会以"1 个记忆点"的身份出现在 index 和关系图里。
 */
export function readPoints(dir) {
  const out = []
  const ID_RE = /^M-\d{4}-\d{2}-\d{2}-\d{3}$/
  for (const sub of ['30_points', '40_pending']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((x) => x.endsWith('.md') && !/^TEMPLATE/i.test(x))) {
      const raw = readFileSync(join(d, f), 'utf8')
      const meta = {}
      const fm = raw.match(/^---\n([\s\S]*?)\n---/)
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const m = line.match(/^(\w+):\s*(.*)$/)
          if (m) meta[m[1]] = m[2]
        }
      }
      if (!meta.id || !ID_RE.test(meta.id.trim())) continue
      const arr = (v) => (v ? v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [])
      out.push({
        id: meta.id.trim(),
        status: meta.status || 'active',
        links: arr(meta.links),
        contradicts: arr(meta.contradicts),
        merged_into: meta.merged_into || null,
        cluster: meta.cluster || '',
        file: `${sub}/${f}`,
      })
    }
  }
  return out
}

function readClusters(dir) {
  const f = join(dir, '20_index', 'clusters.md')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .slice(1)
    .map((l) => l.split('|')[1]?.trim())
    .filter(Boolean)
}
