// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * tidy.js — 整理机触发器（v0.68.0，T1）。
 *
 * 为什么需要：整理这条链**唯一断掉的一环是"节拍"**。
 * 她写草稿 → 人 promote，这两步都靠自觉；两周不写、一个月不 promote，
 * 库里只会越积越"生的"，而注入层毫无感知。
 *
 * 小兑那套是"每 35 条整理一次"的机器；我们**不做机器**（代码永不自动写记忆点），
 * 只做**提醒 + 备料**：
 *
 *   · 水位账 `20_state/tidy.json` 只记数字（`rows` 累积条数 / `lastTidyRows` 上次整理时多少条）；
 *   · 差 ≥ `every`（默认 **35**）→ 注入末尾追加**一行** ≤40 tok 的提醒；
 *   · 同时备料 `90_snapshot/tidy-<rows>/`（这 35 条原文摘录 + 草稿清单 + 新点清单），
 *     她整理时不用自己翻档案。
 *
 * 三条纪律：
 *   ① **只在整理动作完成时前移水位**（`memory tidy --done`）；
 *   ② 账本丢了只是回到"不提醒"，**不丢任何数据**（坏了就从现状重建）；
 *   ③ 备料是**派生数据**：`90_snapshot/` 不进 pack、不进注入、可随时删。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readArchive, readPointFiles } from './toolkit.js'
import { atomicWriteJson, localDay, readJsonSafe } from './util.js'

export const TIDY_FILE = join('20_state', 'tidy.json')
export const TIDY_EVERY = 35
export const PACK_ROOT = '90_snapshot'

export const emptyState = () => ({ rows: 0, lastTidyRows: 0, lastTidyAt: null, lastPackRows: 0 })

export function loadTidy(dir) {
  const raw = readJsonSafe(join(dir, TIDY_FILE), null)
  if (!raw || typeof raw !== 'object') return emptyState()
  return {
    rows: Number(raw.rows) || 0,
    lastTidyRows: Number(raw.lastTidyRows) || 0,
    lastTidyAt: typeof raw.lastTidyAt === 'string' ? raw.lastTidyAt : null,
    lastPackRows: Number(raw.lastPackRows) || 0,
  }
}

export function saveTidy(dir, st) {
  mkdirSync(join(dir, '20_state'), { recursive: true })
  atomicWriteJson(join(dir, TIDY_FILE), st)
}

/**
 * 档案每写进一条就 +1。
 *
 * 为什么不每次去数档案：那是 O(n) 的全量读，每轮都跑会拖慢对话。
 * 计数器丢了也不要紧——下次 `tidyStatus` 会用真实条数把它校正回来。
 */
export function noteArchived(dir, n = 1) {
  try {
    const st = loadTidy(dir)
    st.rows += Math.max(0, n | 0)
    saveTidy(dir, st)
  } catch {
    /* 记账失败不影响归档本身 */
  }
}

/** 真实档案条数（只在需要校正/备料时用） */
export function countRows(dir) {
  try {
    return readArchive(dir).messages.length
  } catch {
    return 0
  }
}

/**
 * 账本状态（顺带用真实条数校正一次）。
 * @returns {{rows:number,lastTidyRows:number,since:number,every:number,due:boolean,lastTidyAt:string|null}}
 */
export function tidyStatus(dir, { every = TIDY_EVERY } = {}) {
  const st = loadTidy(dir)
  const rows = Math.max(st.rows, countRows(dir))
  const since = Math.max(0, rows - st.lastTidyRows)
  return { rows, lastTidyRows: st.lastTidyRows, since, every, due: since >= every, lastTidyAt: st.lastTidyAt }
}

/**
 * 注入末尾那一行（≤40 tok）。不到线就返回空串。
 * 纯只读：**不建包、不动水位**——建包是 `tidyPack` 的事。
 */
export function tidyLine(dir, { every = TIDY_EVERY } = {}) {
  const s = tidyStatus(dir, { every })
  if (!s.due) return { text: '', tokens: 0, since: s.since }
  const text = `<!-- 该整理了 -->距上次整理，档案又多了 ${s.since} 条。有空翻翻 40_pending，该归仓的归仓。<!-- /该整理了 -->`
  return { text, tokens: Math.ceil(text.length / 2), since: s.since }
}

/**
 * 备料：把这批新增的原文摘录 + 草稿清单 + 新点清单落到 `90_snapshot/tidy-<rows>/`。
 * 同一水位只生成一次（`lastPackRows` 挡住重复写盘）。
 */
export function tidyPack(dir, { every = TIDY_EVERY, now = new Date() } = {}) {
  const s = tidyStatus(dir, { every })
  if (!s.due) return { ok: false, reason: 'not-due', since: s.since }
  const st = loadTidy(dir)
  if (st.lastPackRows === s.rows && existsSync(join(dir, PACK_ROOT, `tidy-${s.rows}`, 'index.md'))) {
    return { ok: true, reused: true, at: join(dir, PACK_ROOT, `tidy-${s.rows}`) }
  }

  const outDir = join(dir, PACK_ROOT, `tidy-${s.rows}`)
  mkdirSync(outDir, { recursive: true })

  // ① 这 since 条原文（只取尾巴）
  const messages = readArchive(dir).messages.slice(-s.since)
  const excerpt = messages
    .map((m) => `- [${String(m.ts || '').slice(0, 16)}] ${m.role === 'assistant' ? '她' : '你'}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n')

  // ② 草稿清单（只列文件名与标题，不复制正文）
  const pendingDir = join(dir, '40_pending')
  const drafts = existsSync(pendingDir)
    ? readdirSync(pendingDir)
        .filter((f) => f.endsWith('.md') && !/^README/i.test(f))
        .sort()
    : []

  // ③ 上次整理之后新增的点
  const points = readPointFiles(dir, '30_points').filter((p) => String(p.date || '') >= String(localDay(new Date(s.lastTidyAt || now)))
  )

  writeFileSync(
    join(outDir, 'index.md'),
    [
      `# 整理材料包 · ${localDay(now)}`,
      '',
      `- 自上次整理（${s.lastTidyRows} 条）：档案新增 **${s.since}** 条`,
      `- 上次整理时间：${s.lastTidyAt || '（还没整理过）'}`,
      `- 待审草稿：${drafts.length} 条`,
      '',
      '> 这个目录是**派生数据**：不进 pack、不进注入、可随手删。',
      '> 代码不会替她写记忆点——这里只有原料。',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(outDir, 'recent.md'), `# 最近 ${s.since} 条原文（节选）\n\n${excerpt}\n`, 'utf8')
  writeFileSync(
    join(outDir, 'pending.md'),
    `# 40_pending 草稿清单\n\n${drafts.length ? drafts.map((f) => `- ${f}`).join('\n') : '（没有草稿）'}\n`,
    'utf8',
  )
  writeFileSync(
    join(outDir, 'new-points.md'),
    `# 上次整理之后新增的点\n\n${points.length ? points.map((p) => `- ${p.date || ''} ${p.title || p.id}`).join('\n') : '（没有新点）'}\n`,
    'utf8',
  )

  st.lastPackRows = s.rows
  saveTidy(dir, st)
  return { ok: true, reused: false, at: outDir, since: s.since, drafts: drafts.length, points: points.length }
}

/** 整理完成：水位前移到当前条数（**唯一**会前移水位的地方） */
export function markTidyDone(dir, { now = new Date() } = {}) {
  const s = tidyStatus(dir)
  const st = loadTidy(dir)
  st.rows = s.rows
  st.lastTidyRows = s.rows
  st.lastTidyAt = now.toISOString()
  saveTidy(dir, st)
  mkdirSync(join(dir, '50_log'), { recursive: true })
  writeFileSync(
    join(dir, '50_log', 'tidy.log'),
    `${JSON.stringify({ at: now.toISOString(), rows: s.rows, since: s.since })}\n`,
    { flag: 'a', encoding: 'utf8' },
  )
  return { ok: true, rows: s.rows, tidiedSince: s.since }
}
