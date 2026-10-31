// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * reset.js — 开养前清空（`memory reset --all`）。
 *
 * 为什么单独的模块：这不是"遗忘"，也不是 `erase`。它只做一件事——
 * **把搭库期留下的所有痕迹清掉，让库里只剩"配置"，没有"经历"**。
 *
 * 和别的清理的区别：
 *   - `reset --fix` 只清 `fixture: true` 的验证素材（记忆点 + 段包）；
 *   - `erase` 是**有授权、有墓碑、有前后指纹**的定点删除；
 *   - `reset --all` 是**一次性的开养前清零**：档案、状态、日志、快照、技能、草稿一起清。
 *     它**违反"档案只追加"**，所以只在"还没开养"这个窗口里允许，用完就关。
 *
 * 三条约束：
 *   ① **不动 `00_core/`**（那是她的配置，不是经历）——只把 `core_changelog.md` 清回表头；
 *   ② **不动文档与模板**（MEMORY / COMPRESS / FIXTURES / README / `TEMPLATE.md` / `tools.md`）；
 *   ③ **先算后删**：`apply:false` 只出清单（删什么、多少字节），`apply:true` 才真动。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildIndex, writeIndex } from './toolkit.js'

/** 这些文件在所有清理里都不动（文档与模板） */
const KEEP_NAMES = new Set(['README.md', 'TEMPLATE.md', 'tools.md'])
/** 技能层只保留模板（`S-*` / `K-*` 是搭库期造的） */
const ABILITY_KEEP = new Set(['TEMPLATE.md', 'tools.md', 'README.md'])

function listFiles(dir, { recursive = true } = {}) {
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (recursive) out.push(...listFiles(p, { recursive }))
      continue
    }
    out.push({ path: p, name: e.name, bytes: statSync(p).size })
  }
  return out
}

function countJsonl(dir) {
  const base = join(dir, '10_archive', 'messages')
  if (!existsSync(base)) return 0
  let n = 0
  for (const f of readdirSync(base).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(base, f), 'utf8').split(/\r?\n/)) if (line.trim()) n += 1
  }
  return n
}

/**
 * 清单一：删什么、留什么。
 * @returns {{counts: object, targets: {area:string, kind:'file'|'dir', path:string, bytes?:number}[], kept: string[]}}
 */
export function planResetAll(dir) {
  const targets = []
  const add = (area, path, kind = 'file') => {
    if (!existsSync(path)) return
    targets.push({ area, kind, path, bytes: kind === 'file' ? statSync(path).size : undefined })
  }

  // ① 档案（搭库期的对话，一条不留）
  for (const f of listFiles(join(dir, '10_archive', 'messages')).filter((x) => x.name.endsWith('.jsonl'))) add('archive', f.path)
  for (const f of listFiles(join(dir, '10_archive', 'raw'))) add('archive-raw', f.path)

  // ② 状态（游标/会话/注入计数/档案基线/首启快照）
  for (const f of listFiles(join(dir, '20_state'))) add('state', f.path)

  // ③ 日志（检索/宿主/金丝雀/兼容/隐私/完整性……）
  // `reset.log` 不列：它是"清过"的流水（只有数量与时间），不是搭库期的印记；
  // 每次 apply 会重写它，列进来只会让"清零后应该剩 0"这句话不成立。
  for (const f of listFiles(join(dir, '50_log'))) if (f.name !== 'reset.log') add('log', f.path)

  // ④ 唤醒包（v0.17 生成过的那份也是搭库期产物）
  for (const e of existsSync(join(dir, '90_snapshot')) ? readdirSync(join(dir, '90_snapshot'), { withFileTypes: true }) : []) {
    if (e.isDirectory()) add('snapshot', join(dir, '90_snapshot', e.name), 'dir')
  }

  // ⑤ 自述 / 草稿 / 调试
  for (const f of listFiles(join(dir, '15_self'))) if (!KEEP_NAMES.has(f.name)) add('self', f.path)
  for (const f of listFiles(join(dir, '40_pending'))) if (!KEEP_NAMES.has(f.name)) add('pending', f.path)
  for (const f of listFiles(join(dir, '_debug'))) add('debug', f.path)

  // ⑥ 技能（只留模板）
  for (const f of listFiles(join(dir, '35_ability'))) if (!ABILITY_KEEP.has(f.name)) add('ability', f.path)

  // ⑦ 记忆点（只留 TEMPLATE）
  for (const f of listFiles(join(dir, '30_points'), { recursive: false })) if (!KEEP_NAMES.has(f.name)) add('points', f.path)

  // ⑧ 派生索引不列进清单：它在 apply 里**重建为空**（列进来只会让"清零后剩 0"不成立）。

  const counts = targets.reduce((m, t) => ({ ...m, [t.area]: (m[t.area] || 0) + 1 }), {})
  const bytes = targets.reduce((n, t) => n + (t.bytes || 0), 0)

  // 派生索引单独判：它们**不进 targets**（apply 时整个 20_index 重建），
  // 但要能回答"库里还有没有旧投影"——否则只剩一堆旧 vault 视图时，
  // 预览会说"已经干净了"，而那些日笔记里全是逐条对话原文。
  const idxDir = join(dir, '20_index')
  const empty = (f) => !existsSync(join(idxDir, f)) || readFileSync(join(idxDir, f), 'utf8').trim() === ''
  const indexStale =
    !empty('all.idx.jsonl') ||
    !empty('all.sum.jsonl') ||
    !empty('recent.idx.jsonl') ||
    existsSync(join(idxDir, 'views')) ||
    existsSync(join(idxDir, 'index.md')) ||
    existsSync(join(idxDir, 'links.md'))

  return {
    counts,
    bytes,
    targets,
    index_stale: indexStale,
    archive_messages: countJsonl(dir),
    kept: ['00_core/（灵魂/规则/关系/状态/版本）', 'MEMORY.md / COMPRESS.md / FIXTURES.md / README.md', '30_points/TEMPLATE.md', '35_ability/TEMPLATE.md + tools.md'],
  }
}

/**
 * 真清。顺序有讲究：**先删档案，再清状态**——否则中间崩了会留下
 * "档案没了、游标还指着旧 seq"的半截状态（下一个会话会从错误的位置接着记）。
 */
export function applyResetAll(dir, { now = new Date() } = {}) {
  const plan = planResetAll(dir)

  // 先删文件/目录
  for (const t of plan.targets) {
    try {
      rmSync(t.path, { recursive: t.kind === 'dir', force: true })
    } catch {
      /* 单个删不掉不阻塞整体：最后会重算计划，剩下的下次还能删 */
    }
  }

  // 重建空索引：**整个 20_index 先删掉再建**。
  // 只重写 all.idx 不够——`views/YYYY-MM-DD.md`（vault 日笔记）里是逐条对话原文，
  // 那是搭库期最像"经历"的东西，留一份就等于没清。
  try {
    rmSync(join(dir, '20_index'), { recursive: true, force: true })
    mkdirSync(join(dir, '20_index'), { recursive: true })
    writeIndex(dir, buildIndex([], { now }))
  } catch {
    /* 索引可重建，失败不影响"清零"这个事实 */
  }

  // 核心层变更记录清回表头（它是"谁改过她的身份"的账，搭库期的改动不该带进开养）
  const changelog = join(dir, '00_core', 'core_changelog.md')
  if (existsSync(changelog)) {
    writeFileSync(
      changelog,
      [
        '# 核心层变更记录（core_changelog）',
        '',
        '> 格式：`日期 | 文件 | 版本 | 改了什么（evidence: msg_id）`',
        '> 规矩（契约 §7.5）：7 天内 ≤2 条改动；单次改动 ≤20% 字数；无 evidence 不许改。',
        '> 每次改动前，先把旧版本存进 `00_core/versions/`。',
        '',
        `> ${now.toISOString().slice(0, 10)}：开养前清零（\`memory reset --all\`）。之前的改动记录属于搭库期，已清空。`,
        '',
      ].join('\n'),
      'utf8',
    )
  }

  // 留一行流水：只记数量与时间，不含任何原话。
  // **追加**而不是覆盖（v0.20.1）：第二次清零不该抹掉第一次的记录——
  // "清过几次"本身就是要能对账的事实。
  const log = {
    at: now.toISOString(),
    op: 'reset-all',
    removed: plan.counts,
    archive_messages: plan.archive_messages,
    bytes: plan.bytes,
    note: '开养前清零：档案/状态/日志/快照/技能/草稿。00_core 与文档未动。',
  }
  try {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, '50_log', 'reset.log'), JSON.stringify(log) + '\n', 'utf8')
  } catch {
    /* 日志写不进去也不影响清零 */
  }

  // 删完**重算一遍**：删不掉的东西（被占用/权限）必须报出来。
  // 以前日志记的是"计划删多少"，于是一次失败的中途崩掉也会显示 removed N——
  // 那是自述为真、事实为假（同一个毛病在 erase 那边也有过）。
  let residual = { counts: {}, total: 0, index_stale: false }
  try {
    const after = planResetAll(dir)
    residual = {
      counts: after.counts,
      total: Object.values(after.counts).reduce((a, b) => a + b, 0),
      index_stale: after.index_stale,
    }
  } catch {
    residual = { counts: {}, total: -1, index_stale: false, unreadable: true }
  }

  return { ...log, plan, residual }
}
