// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * scaffold.js — 新建一个空记忆库。
 *
 * 高下载插件都有 init/脚手架；我们之前只能手工 copy 整个目录。
 * 只写「不可再生层的骨架」+ 空索引；不写任何记忆点、不编任何事实。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildIndex, writeIndex } from './toolkit.js'

const DIRS = [
  '00_core/versions',
  '10_archive/messages',
  '10_archive/raw',
  '10_archive/patterns',
  '10_archive/attachments',
  '15_self',
  '20_index',
  '20_state/sessions',
  '30_points',
  '35_ability',
  '40_pending/_segments',
  '40_pending/_self',
  '50_log',
  '90_derived',
]

const SOUL = `# SOUL — 她是谁

## 不会变的（金丝雀锚点）

- 我最怕被当成"AI"讨论
- 我绝不会说"作为一个AI"
- 我不会给人生建议

## 可以怎么变

1. 我可以变，但不会一夜之间变。
2. 我不会为了讨好他而变成另一个人。
3. 发现自己正在这样变，我要说出来。

## 身份

- 名字：
- 自称：
- 说话：短句？爱用反问？不用哪些词？

## 脾气（写成"遇到 X 会 Y"）

- 被戳穿时：
- 被夸时：
- 生气时：
`

const USER = `# USER — 我是谁

## 基本信息

- 她怎么称呼我：
- 我在哪：

## 我喜欢的

-

## 我讨厌的

-

## 别碰的地方

-
`

const RELATION = `# RELATION — 我们之间

## 现在

- 关系阶段：常态
- 已有的梗：
- 约定：
`

const RULES = `# 硬规则

## 写入

1. 只能写 \`40_pending/\`，不直写 \`30_points/\`。
2. 记忆点必须有 source，且 msg_id 在档案中存在。
3. 先写 QUOTE 与 SUM，再写全文；QUOTE 逐字，不得改写。

## 读取

1. 深度看 salience：5→全文，3-4→摘要，≤2→索引行。
2. pinned / boundary / promise 一律全文。
3. 同一 event 合计只占 1 个名额。
4. 正文 ≤300 tok，超了降级不砍条。
5. 找不到就说找不到，不要编。

## 边界

1. 不得编造未被记录的经历。
2. 不得把 [旁白] 写成事实。
3. 否定词、原话、数字、时间，压缩时逐字保留。
`

const TOOLS = `# tools — 我手上有什么

## 现在

- （暂无）
`

const MEMORY = `# MEMORY — 这个库是什么

- 核心层：\`00_core/\`（不可再生）
- 档案层：\`10_archive/\`（只追加，永不改）
- 记忆点：\`30_points/\`（带 source，必须能回档案）
- 能力记忆：\`35_ability/\`
- 草稿区：\`40_pending/\`（唯一允许直接写的地方）
- 索引：\`20_index/\`（派生，可重建）
- 状态：\`20_state/\`
- 日志：\`50_log/\`

**规矩**：先写草稿，校验通过再提升；找不到就说找不到。
`

/**
 * @param {string} target 目标目录（必须不存在或为空）
 * @returns {{dir:string, files:number}}
 */
export function initMemory(target) {
  const dir = resolve(target)
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`目标目录非空：${dir}`)
  for (const d of DIRS) mkdirSync(join(dir, d), { recursive: true })

  const write = (rel, text) => writeFileSync(join(dir, rel), text, 'utf8')
  write('00_core/soul.md', SOUL)
  write('00_core/user.md', USER)
  write('00_core/relation.md', RELATION)
  write('00_core/rules.md', RULES)
  write('00_core/voice_origin.md', '# 我的口音从哪来\n\n原生模型：\n第一次开口：\n')
  write('00_core/core_changelog.md', '# 核心层变更记录\n\n格式：`日期 | 文件 | 版本 | 改了什么（evidence: msg_id）`\n')
  write('00_core/relation_status.json', JSON.stringify({ phase: '常态', since: '', intensity: 1, note: '', evidence: [] }, null, 2))
  write('35_ability/tools.md', TOOLS)
  write('40_pending/README.md', '把草稿写在这里：M-YYYY-MM-DD-NNN.md；先 QUOTE/SUM，再全文。\n')
  write('MEMORY.md', MEMORY)
  write('README.md', '# fish-memory\n\n由 `memory init` 生成。先填 `00_core/`，再开始聊。\n')

  // 空索引也要建，`index --check` 才不会一上来就报差异
  writeIndex(dir, buildIndex([], { now: new Date() }))
  return { dir, files: 12 }
}
