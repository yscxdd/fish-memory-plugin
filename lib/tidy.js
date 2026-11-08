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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readArchive, readPointFiles } from './toolkit.js'
import { atomicWriteJson, localDay, readJsonSafe } from './util.js'

export const TIDY_FILE = join('20_state', 'tidy.json')
export const TIDY_EVERY = 35
export const PACK_ROOT = '90_snapshot'

export const emptyState = () => ({ rows: 0, lastTidyRows: 0, lastTidyAt: null, lastPackRows: 0 })

/**
 * 计数器（v0.75.0）：只给测试用。
 *
 * 为什么不用"耗时"来证明"没读档案"：并行测试里墙钟时间会抖，
 * 那条断言在慢机器上一定红（v0.70 写完当天就抖过一次）。
 * **能数的东西就别去测时间。**
 */
export const tidyCounters = { corrections: 0 }

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

/**
 * 账本是不是落后于档案（v0.70.0）。
 * **只 stat 两个文件**，不读内容——这是 A1 修好之后"仍然不瞎信自己"的代价上限。
 */
export function stateLooksStale(dir) {
  try {
    const statePath = join(dir, TIDY_FILE)
    if (!existsSync(statePath)) return true
    const stateAt = statSync(statePath).mtimeMs
    const msgDir = join(dir, '10_archive', 'messages')
    if (!existsSync(msgDir)) return false
    let newest = 0
    for (const f of readdirSync(msgDir)) {
      if (!f.endsWith('.jsonl')) continue
      const t = statSync(join(msgDir, f)).mtimeMs
      if (t > newest) newest = t
    }
    return newest > stateAt
  } catch {
    return true
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
 * 账本状态。
 *
 * **v0.70.0（A1 修复）**：这里原来每轮都 `Math.max(st.rows, countRows(dir))`——
 * 而 `countRows` 就是全量 `readArchive`（逐行 JSON.parse + 全量排序）。
 * 5 万条档案时每轮 +110ms，**而这个计数本来就不需要读档案**：
 * `archive.js` 每写一条已经 `noteArchived()` 累加过了。
 *
 * 现在只在三种情况下校正一次（都是 O(1) 的 stat，不是读档案）：
 *   ① 账本还是 0（第一次跑）；
 *   ② 账本文件的 mtime 早于最新一个日文件（有人在别的进程写过档案）；
 *   ③ 显式 `correct: true`。
 *
 * @returns {{rows:number,lastTidyRows:number,since:number,every:number,due:boolean,lastTidyAt:string|null}}
 */
export function tidyStatus(dir, { every = TIDY_EVERY, correct = false } = {}) {
  const st = loadTidy(dir)
  const needsCorrect = correct || st.rows === 0 || stateLooksStale(dir)
  let rows = st.rows
  if (needsCorrect) {
    tidyCounters.corrections += 1
    const real = countRows(dir)
    rows = Math.max(st.rows, real)
    // **必须写回去**：不写回去就等于每轮都校正（A1 的修复会退回 O(n)）
    if (rows !== st.rows) {
      st.rows = rows
      try {
        saveTidy(dir, st)
      } catch {
        /* 写不回就下次再校正，不影响正确性 */
      }
    }
  }
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
/** 材料包里的「最近 N 条原文」（节选，不含全文） */
function renderRecent(messages, since) {
  const body = messages
    .map(
      (m) =>
        `- [${String(m.ts || '').slice(0, 16)}] ${m.role === 'assistant' ? '她' : '你'}：${String(m.text || '').replace(/\\s+/g, ' ').slice(0, 120)}`,
    )
    .join('\\n')
  return `# 最近 ${since} 条原文（节选）\\n\\n${body}\\n`
}

/**
 * 只清理**自己命名的**材料包目录（v0.70.0，A2）。
 *
 * due 可能持续几天（等人有空 `--done`），所以必须自己收垃圾；
 * 但**只碰 `tidy-<数字>`** —— 那个目录里可能还有别人的东西。
 */
export function prunePacks(dir, { keep = 3, keepName = null } = {}) {
  const root = join(dir, PACK_ROOT)
  if (!existsSync(root)) return { removed: [] }
  const mine = readdirSync(root)
    .filter((f) => /^tidy-\d+$/.test(f))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  const removed = []
  const keepSet = new Set(mine.slice(-keep))
  if (keepName) keepSet.add(keepName)
  for (const name of mine) {
    if (keepSet.has(name)) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      /* 删不掉留着，下次再说 */
    }
  }
  return { removed }
}

export function tidyPack(dir, { every = TIDY_EVERY, now = new Date() } = {}) {
  const s = tidyStatus(dir, { every })
  if (!s.due) return { ok: false, reason: 'not-due', since: s.since }
  const st = loadTidy(dir)
  /**
   * **v0.70.0（A2 修复）**：包名用**水位起点**（lastTidyRows），不是当前条数。
   *
   * 旧写法按 `rows` 命名，而 due 期间每来一条消息 `rows` 就 +1 → **每个 turn 新建一个目录**，
   * 实测出现过 tidy-40 / tidy-41 / tidy-42 三个并存，且永不清理。
   * 一个 due 周期只该有一份材料——它描述的是"自上次整理以来"这一段。
   */
  const packName = `tidy-${s.lastTidyRows}`
  const outDir = join(dir, PACK_ROOT, packName)
  if (existsSync(join(outDir, 'index.md'))) {
    // 周期内重复调用：只用最新数据刷新 recent.md，不新建目录
    try {
      const messages = readArchive(dir).messages.slice(-s.since)
      writeFileSync(join(outDir, 'recent.md'), renderRecent(messages, s.since), 'utf8')
    } catch {
      /* 刷新失败不影响已有材料 */
    }
    return { ok: true, reused: true, at: outDir }
  }
  prunePacks(dir, { keep: 3, keepName: packName })
  mkdirSync(outDir, { recursive: true })

  // ① 这 since 条原文（只取尾巴）
  const messages = readArchive(dir).messages.slice(-s.since)

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
  writeFileSync(join(outDir, 'recent.md'), renderRecent(messages, s.since), 'utf8')
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

  // v0.70.0：这里必须把校正后的 rows 写回去——否则 st 里还是旧值（0），
  // 下一次 loadTidy 读到 rows=0，since 会被算成 1，于是 due 变 false（材料包再也不刷新）
  st.rows = s.rows
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
