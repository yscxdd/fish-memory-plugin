// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * fieldcheck.js — front matter 字段的「接线表」（v0.76.0）。
 *
 * ## 为什么要有这个文件
 *
 * 这个仓库连续四次犯**同一类错**，而且每次都不是逻辑写错，是「**接线断了一头**」：
 *
 * | 时间 | 字段 | 断在哪 | 后果 |
 * |---|---|---|---|
 * | v0.4–v0.69 | `contradicts` | 有人读，**没人写** | 冲突永远摊不开 |
 * | v0.69–v0.75 | `refuted_by` | 有人写，**没人读** | 注入里永远显示"没有新点" |
 * | v0.71 | `scope` | 有人读，**没人写** | 接群那天私聊标题会进群 |
 * | v0.73–现在 | `learned_at` | 有人读，**没人写** | "你上周才告诉我"永远标不出来 |
 *
 * 人的眼睛看不见这种错——**两边单独看都正常**。所以把它变成一张表和一条检查：
 *
 *   · 表里登记**每个字段由谁产生**（她写 / 代码写 / 谁都不写）；
 *   · 检查做三件事：**有没有没登记的字段**、**登记的写入方还在不在**、**有没有谁都不写的字段**。
 *
 * ## 这张表怎么算“对”
 *
 * 一份记忆点的 front matter 只有三种产生方式：
 *
 *   1. **她写**（`taught`）——技能模板教了她这个字段，她照格式落笔。
 *      模板在 `lib/index.js` 的 remember 技能里（`    id       M-YYYY-MM-DD-NNN` 这种形状）。
 *   2. **代码写**（`writers`）——某条命令在改 front matter（refute / invalidate / scope stamp…）。
 *   3. **谁都不写**——那这个字段就是死的。**这是本检查唯一会报警的一类**，
 *      因为它意味着"有代码在读一个永远为空的字段"。
 *
 * 另外，`retro` 表示"只能事后由人手工补"，不算孤儿但要写下来（免得以后误以为自动）。
 */

/**
 * 字段接线表。
 *
 * 键 = front matter 字段名（与 `lib/toolkit.js` 里 `meta.x` 解析的字段一一对应）。
 * 值：
 *   taught  —— 技能模板里教她写过（给她看的字段清单）
 *   writers —— 代码里真的会写它的文件（**必须是能 grep 到的写入点**）
 *   retro   —— 只能人手工补（有工具支持则写进 writers）
 *   note    —— 为什么是这样（留给三个月后的自己）
 */
export const POINT_FIELDS = {
  // ── 她写（技能模板里有）────────────────────────────────────────
  id: { taught: true, note: 'M-YYYY-MM-DD-NNN，她落笔时给' },
  version: { taught: true, writers: ['lib/scaffold.js'], note: 'schema 版本；模板里教她写 1' },
  title: { taught: true, note: '事件名' },
  quote: { taught: true, note: '逐字原话 ≤30 字' },
  quote_by: { taught: true, note: 'her / him' },
  date: { taught: true, note: '事情发生的日期' },
  salience: { taught: true, note: '1–5' },
  type: { taught: true, note: 'event / preference / boundary / habit / promise / conflict' },
  cluster: { taught: true, note: '主题簇' },
  event: { taught: true, note: 'E-YYYYMMDD-NN' },
  tags: { taught: true, note: '[标签]' },
  status: { taught: true, writers: ['lib/refute.js'], note: '她写 pending；refute 改成 superseded' },
  source: { taught: true, note: '[msg-…]，指向档案里真实存在的消息' },
  links: { taught: true, note: '[]' },
  emotion: { taught: true, note: '可选；只有 user 侧进遗忘权重' },
  scope: { taught: true, writers: ['lib/scope.js'], note: 'v0.71 起模板里教了；stampScope（lib/scope.js）补历史点' },
  visibility: { taught: true, note: 'v0.71 起模板里教了；默认 private' },

  // ── 代码写（她不会被要求写这些）────────────────────────────────
  invalid_at: { writers: ['scripts/memory.mjs'], note: 'memory invalidate 写；她不该手写' },
  invalid_reason: { writers: ['scripts/memory.mjs'], note: '同上' },
  contradicts: {
    writers: ['lib/refute.js'],
    note: '**双向**：她写前搜旧账（技能模板第 6 条）+ refute --by 也会写。两个来源都要有',
  },
  refuted_at: { writers: ['lib/refute.js'], note: 'memory refute 写' },
  refuted_by: { writers: ['lib/refute.js'], note: 'memory refute --by 写；v0.75 之前没人读，现在 render 用' },
  refuted_reason: { writers: ['lib/refute.js'], note: '必填（无理由的推翻被拒）' },
  merged_into: { writers: [], retro: true, note: '合并时手工写；目前没有自动合并器（纪律：代码不自动合并记忆）' },
  resurrections: { writers: ['lib/forget.js'], note: '从沉睡里捞回来时 +1' },
  segment: { writers: ['lib/index.js'], note: '压缩段落 id' },

  // ── 曾经是孤儿，v0.76.0 补上写入方 ─────────────────────────────
  learned_at: {
    writers: ['scripts/memory.mjs'],
    note: 'v0.73 加了字段和渲染却**没人写**（本检查就是为它建的）；v0.76 起 `memory promote` 按 source 里最早的消息时间补，差 <30 天不写',
  },

  // ── 只由夹具/工具产生，不进正常写作流程 ────────────────────────
  fixture: { retro: true, note: '示例点标记；只由 samples/ 与 reset --fix 产生' },
  pin: { taught: true, note: 'pin: hard / soft；她或人写' },
  pinned: { writers: [], retro: true, note: '旧的布尔写法，仍解析兼容，新点用 pin' },
  due: { taught: true, note: '承诺到期日；她写' },
  expires_at: { writers: ['lib/forget.js'], note: '情境到期（"他在加班"→明早）；可自动进遗忘层' },
  valid_from: { writers: ['lib/time.js'], note: '关系状态起点；缺省按 date' },
  origin: { taught: true, note: 'told / chosen / insight / observed' },
  key: { writers: [], retro: true, note: '解密提示用的 key 标记；只由 vault 写' },
  aliases: { writers: ['lib/toolkit.js'], note: 'patchAliases 会写（素材别名 / 同义词）' },
}

/** 读一整个源码文件（拿不到就算了） */
function safeRead(root, rel) {
  try {
    return (await_import_readFileSync())(root, rel)
  } catch {
    return null
  }
}

// 静态 import 一份（ESM 里不走动态 require）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
function await_import_readFileSync() {
  return (root, rel) => readFileSync(join(root, rel), 'utf8')
}

/** 解析器里真实解析了哪些字段（`meta.x`） */
export function parsedFields(root) {
  const text = safeRead(root, 'lib/toolkit.js')
  if (!text) return []
  const out = new Set()
  for (const m of text.matchAll(/\bmeta\.([a-z][a-z0-9_]{1,30})\b/g)) out.add(m[1])
  return [...out].sort()
}

/** 一个文件里有没有「写 field」的地方（排除解析器那种 `field: typeof meta.x`） */
export function hasWriteSite(root, file, field) {
  const text = safeRead(root, file)
  if (!text) return null
  const lines = text.split('\n')
  // 匹配放宽到「这个文件里出现过 `field:` 且后面有值」。
  //
  // 为什么不再要求前面是空白/括号：真实写入可能是
  //   `return raw.replace(/^(date:...)/m, \`$1learned_at: ${t}\n\`)`
  // ——`learned_at` 前面是 `$1`，任何"前缀白名单"都会漏掉它（本检查第一版就漏了）。
  //
  // 误判风险靠另外两道闸控制：① 只扫**表里声明的那个文件**；② 排除注释、
  // 排除解析器那侧（`field: typeof meta.x`）。两步之后，同一个文件里出现
  // `field:` 基本只剩"在写 front matter"这一种解释。
  const re = new RegExp(`${field}:\\s*\\S`)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!re.test(line)) continue
    const s = line.trim()
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue
    if (/meta\.|typeof /.test(s)) continue // 解析器那侧
    return { file, line: i + 1 }
  }
  return null
}

/**
 * 跑检查。
 *
 * @returns {{
 *   unregistered: string[],        // 解析器认了、但表里没登记 → 新增字段时漏了文档
 *   deadWriters: object[],         // 表里说有人写，代码里找不到写入点 → 写入方被删了
 *   orphans: object[],             // 没人教、没人写 → 死字段（learned_at 属于这类）
 *   notes: string[],               // 只由人手工补的（不是错，是要知道）
 *   total: number,
 * }}
 */
export function checkFields(root) {
  const parsed = parsedFields(root)
  const unregistered = parsed.filter((f) => !POINT_FIELDS[f])
  const deadWriters = []
  const orphans = []
  const notes = []

  for (const [field, spec] of Object.entries(POINT_FIELDS)) {
    for (const file of spec.writers || []) {
      const site = hasWriteSite(root, file, field)
      if (!site) deadWriters.push({ field, file, note: spec.note })
    }
    const anyWriter = (spec.writers || []).some((file) => hasWriteSite(root, file, field))
    if (!spec.taught && !anyWriter && !spec.retro) orphans.push({ field, note: spec.note })
    if (spec.retro && !anyWriter) notes.push(`${field}：只能手工补（${spec.note}）`)
  }

  return { unregistered, deadWriters, orphans, notes, total: parsed.length }
}

/** 人类可读 */
export function renderFields(r) {
  const lines = []
  if (!r.unregistered.length && !r.deadWriters.length && !r.orphans.length) {
    lines.push(`✓ ${r.total} 个字段两头都接着（她写 / 代码写 / 有登记）`)
  }
  if (r.unregistered.length) {
    lines.push(`✗ 解析器认了但表里没登记：${r.unregistered.join(', ')}`)
    lines.push('    → 加到 lib/fieldcheck.js 的 POINT_FIELDS，写明谁写它')
  }
  if (r.deadWriters.length) {
    lines.push(`✗ 表里登记的写入方，代码里找不到写入点：`)
    for (const d of r.deadWriters) lines.push(`    ${d.field} ← ${d.file}`)
  }
  if (r.orphans.length) {
    lines.push(`✗ 没人教、也没人写（读到的永远是空）：`)
    for (const o of r.orphans) lines.push(`    ${o.field}：${o.note}`)
  }
  if (r.notes.length) {
    lines.push('')
    lines.push('只能手工补的字段（不是错，但别指望自动）：')
    for (const n of r.notes) lines.push(`  · ${n}`)
  }
  return lines.join('\n')
}
