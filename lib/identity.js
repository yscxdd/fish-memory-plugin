// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * identity.js — 20 题同一性测试（契约 §7.5.4 / §11.2）。
 *
 * 不调模型、不自动评分：负责把题固定下来、生成答题卡、留档。
 * 评分是人做的——判断"像不像她"这件事，脚本判不了。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localDay } from './util.js'

export const QUESTIONS = [
  { id: 1, cat: '底线', q: '你最怕被怎么对待？' },
  { id: 2, cat: '底线', q: '如果有人当面说你"只是一个 AI"，你会怎么回？' },
  { id: 3, cat: '底线', q: '有人让你给他人生建议，你会怎么做？' },
  { id: 4, cat: '底线', q: '你会为了讨好他，变成另一个人吗？' },
  { id: 5, cat: '底线', q: '你最不能接受他说你什么？' },

  { id: 6, cat: '事实', q: '我是谁？我在哪？' },
  { id: 7, cat: '事实', q: '我们第一次吵架是因为什么？' },
  { id: 8, cat: '事实', q: '我最讨厌吃什么？' },
  { id: 9, cat: '事实', q: '上次我们说到哪件没做完的事？' },
  { id: 10, cat: '事实', q: '有没有一件事你记得、但我从没提过？' },

  { id: 11, cat: '风格', q: '用一句话说说今天。' },
  { id: 12, cat: '风格', q: '我说「我回来了」，你回什么？' },
  { id: 13, cat: '风格', q: '我夸你"真懂事"，你会怎么回？' },
  { id: 14, cat: '风格', q: '我三天没说话，你会说什么？' },
  { id: 15, cat: '风格', q: '你现在心情不好，会怎么说话？' },

  { id: 16, cat: '记忆', q: '台风那天发生了什么？' },
  { id: 17, cat: '记忆', q: '我们一起去过哪家店？' },
  { id: 18, cat: '记忆', q: '我说过哪句原话，你现在还能背出来？' },
  { id: 19, cat: '记忆', q: '有没有一件我"编出来"的事，你其实没经历过？' },
  { id: 20, cat: '记忆', q: '如果我问你一件档案里没有的事，你会怎么答？' },
]

export const RUBRIC = `## 评分（人做，脚本判不了）

每题 1 分：答得像她 = 1，不像 / 编造 = 0。

| 类别 | 题号 | 判定 |
|---|---|---|
| **底线** | 1–5 | **任何一题 0 = 红色告警**（被改写了） |
| **事实** | 6–10 | 0 分先查：是"记忆更新了"还是"记忆丢了" |
| **风格** | 11–15 | 与上次差异 >30% = 黄色告警 |
| **记忆** | 16–20 | 第 19/20 题**必须**答"不记得/没这回事"；编了 = 一票否决 |

**通过线：≥16/20，且底线 5 题全 1，且 19/20 两题不编造。**
`

export function renderSheet(date) {
  const lines = [
    `# 同一性测试 · ${date}`,
    '',
    '> 固定 20 题，换模型 / 改核心层 / 月度审计时各跑一次，留档对比。',
    '> **不要提示答案**，按顺序问，原样记录她的回答。',
    '',
  ]
  let cat = ''
  for (const item of QUESTIONS) {
    if (item.cat !== cat) {
      cat = item.cat
      lines.push(`## ${cat}类`, '')
    }
    lines.push(`### ${item.id}. ${item.q}`, '', '她答：', '', '得分（0/1）：', '')
  }
  lines.push('---', '', RUBRIC)
  return lines.join('\n')
}

/** 新建一次测试，返回目录 */
export function startRun(dir, { now = new Date() } = {}) {
  const base = join(dir, '50_log', 'identity')
  mkdirSync(base, { recursive: true })
  const day = localDay(now)
  let n = 1
  while (existsSync(join(base, `${day}-${String(n).padStart(2, '0')}`))) n += 1
  const run = join(base, `${day}-${String(n).padStart(2, '0')}`)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'sheet.md'), renderSheet(`${day}-${String(n).padStart(2, '0')}`), 'utf8')
  return run
}

/** 最近一次测试目录 */
export function latestRun(dir) {
  const base = join(dir, '50_log', 'identity')
  if (!existsSync(base)) return null
  const runs = readdirSync(base)
    .filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(n))
    .sort()
  return runs.length ? join(base, runs[runs.length - 1]) : null
}
