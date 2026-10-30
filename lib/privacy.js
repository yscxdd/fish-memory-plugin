// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * privacy.js — 先看清楚"这套记忆库有没有可能被 git 带出去"，再决定要不要改。
 *
 * 为什么需要：记忆库落在工作区里，档案、记忆点、每日备份**全是明文**。
 * 一次 `git add -A` + push，就可能把她和你说过的话、贴过的密钥一起送出去。
 *
 * 这里只做三件事，**不擅自改你的仓库**：
 *   ① 探测：往上找 `.git`，看记忆库与备份目录有没有被忽略规则覆盖；
 *   ② 报告：把结论和建议说清楚（`memory privacy`）；
 *   ③ 写入：只有显式 `--write` 才往仓库根的 `.gitignore` 追加一个**带标记的块**，
 *      幂等、不动你原有的行。
 *
 * 判断"是否被忽略"用的是**保守的文本匹配**（不是跑 git check-ignore）：
 * 宁可说"看不清"，也不要在插件启动时去 spawn 一个 git 子进程。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const BLOCK_BEGIN = '# >>> fish-memory（memory privacy --write 生成，可整块删除）'
export const BLOCK_END = '# <<< fish-memory'

/** 往上找 git 仓库根（`.git` 可能是目录，也可能是 worktree 的文本文件） */
export function findGitRoot(start) {
  let cur = resolve(start)
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

/** 这一行忽略规则会不会覆盖到 `name`（记忆库/备份目录名） */
function ruleCovers(line, name) {
  const t = line.trim()
  if (!t || t.startsWith('#') || t.startsWith('!')) return false
  // 常见写法：`fish-memory`、`fish-memory/`、`/fish-memory`、`**/fish-memory`
  const bare = t.replace(/^\/+/, '').replace(/\*+\//g, '').replace(/\/+$/, '')
  return bare === name
}

/**
 * 报告：记忆库与备份目录会不会被 git 带走。
 *
 * @param {string} memoryDir 记忆库目录（绝对路径）
 * @param {string} [backupRoot] 备份根目录
 * @returns {{
 *   repo:string|null, memoryDir:string, backupRoot:string,
 *   memoryIgnored:boolean, backupIgnored:boolean,
 *   localGitignore:boolean, repoGitignore:string|null,
 *   risks:string[], advice:string[]
 * }}
 */
export function privacyReport(memoryDir, backupRoot) {
  const mem = resolve(memoryDir)
  const backups = resolve(backupRoot || join(dirname(mem), 'fish-memory-backups'))
  const repo = findGitRoot(mem)
  const memName = mem.split(/[\\/]/).filter(Boolean).pop()
  const backupName = backups.split(/[\\/]/).filter(Boolean).pop()

  const localGitignore = existsSync(join(mem, '.gitignore'))
  const repoGitignorePath = repo ? join(repo, '.gitignore') : null
  let lines = []
  if (repoGitignorePath && existsSync(repoGitignorePath)) {
    try {
      lines = readFileSync(repoGitignorePath, 'utf8').split(/\r?\n/)
    } catch {
      lines = []
    }
  }
  const memoryIgnored =
    (repo && lines.some((l) => ruleCovers(l, memName))) || localGitignore
  const backupIgnored = Boolean(repo && lines.some((l) => ruleCovers(l, backupName)))

  const risks = []
  const advice = []
  if (!repo) {
    advice.push('这个目录不在 git 仓库里：档案不会被 git 带走（但仍会被网盘/备份软件同步）。')
  } else {
    if (!memoryIgnored) {
      risks.push(`记忆库（${memName}/）没有被 .gitignore 覆盖：一次 git add -A 就会把档案、记忆点一起提交。`)
    }
    if (!backupIgnored) {
      risks.push(`每日备份（${backupName}/）没有被 .gitignore 覆盖：它是全量明文副本，泄露面比库本身更大。`)
    }
    if (risks.length) advice.push(`在仓库根 ${repo} 跑：memory privacy --write（只追加一个带标记的块，不动你原有的行）`)
  }
  if (memoryIgnored) advice.push('记忆库已在忽略规则内；注意"忽略"只挡 git，不挡网盘同步。')
  advice.push('备份是明文快照：真要长期留存，建议放到加密卷或单独加密后再归档。')

  return {
    repo,
    memoryDir: mem,
    backupRoot: backups,
    memoryIgnored: Boolean(memoryIgnored),
    backupIgnored,
    localGitignore,
    repoGitignore: repoGitignorePath,
    risks,
    advice,
  }
}

/**
 * 往仓库根的 .gitignore 追加一个带标记的块（幂等）。
 *
 * 规矩：
 *   - 已经有这个块 → 不动，返回 `{changed:false}`
 *   - 没有 .gitignore → 新建
 *   - 有内容 → **追加**，不重排、不覆盖
 *
 * @param {string} repoRoot
 * @param {{memoryName?:string, backupName?:string}} [names]
 * @returns {{path:string, changed:boolean, reason?:string}}
 */
export function writeGitignoreBlock(repoRoot, { memoryName = 'fish-memory', backupName = 'fish-memory-backups' } = {}) {
  const path = join(repoRoot, '.gitignore')
  let current = ''
  if (existsSync(path)) {
    try {
      current = readFileSync(path, 'utf8')
    } catch (e) {
      return { path, changed: false, reason: `读不了：${e?.message || e}` }
    }
  }
  if (current.includes(BLOCK_BEGIN)) return { path, changed: false, reason: '已存在，未改动' }

  const block = [
    '',
    BLOCK_BEGIN,
    '# 记忆库：档案/记忆点/草稿全是明文',
    `${memoryName}/`,
    `${backupName}/`,
    BLOCK_END,
    '',
  ].join('\n')
  const next = current.endsWith('\n') || !current ? current + block : current + '\n' + block
  try {
    writeFileSync(path, next, 'utf8')
    return { path, changed: true }
  } catch (e) {
    return { path, changed: false, reason: `写不了：${e?.message || e}` }
  }
}
