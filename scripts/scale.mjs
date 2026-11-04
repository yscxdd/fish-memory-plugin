#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * scale.mjs — 把"当前规模"从手写变成生成（v0.46.1）。
 *
 * 起因：CHANGELOG 写着「102 个文件（lib 44 · test 47 · docs 9）」，实测 176+。
 * 这份仓库的可信度有一半建立在"数字可复核"上，手写的数字一定会过期。
 *
 * 用法：
 *   node scripts/scale.mjs            # 打印
 *   node scripts/scale.mjs --write    # 就地更新 CHANGELOG.md 的「当前规模」行
 *   node scripts/scale.mjs --check    # 不一致就退出码 1（CI 用）
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

const SKIP = new Set(['node_modules', '.git'])

function countFiles(rel) {
  const dir = join(ROOT, rel)
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      if (e.isDirectory()) walk(join(d, e.name))
      else n += 1
    }
  }
  try {
    walk(dir)
  } catch {
    return 0
  }
  return n
}

function topLevelFiles() {
  let n = 0
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && !SKIP.has(e.name)) n += 1
  }
  return n
}

/** 计数：lib / scripts / test / docs / skills / samples + 顶层文件 = 总文件数 */
export function counts() {
  const lib = countFiles('lib')
  const scripts = countFiles('scripts')
  const test = countFiles('test')
  const docs = countFiles('docs')
  const skills = countFiles('skills')
  const samples = countFiles('samples')
  const top = topLevelFiles()
  return { lib, scripts, test, docs, skills, samples, top, total: lib + scripts + test + docs + skills + samples + top }
}

const fmt = (c) =>
  `**当前规模**：${c.total} 个文件（\`lib\` ${c.lib} · \`scripts\` ${c.scripts} · \`test\` ${c.test} · \`skills\` ${c.skills} · \`docs\` ${c.docs} · \`samples\` ${c.samples} · 仓库根 ${c.top}）。`

const LINE_RE = /^\*\*当前规模\*\*：.*$/m

function main() {
  const args = process.argv.slice(2)
  const c = counts()
  const want = fmt(c)

  if (args.includes('--write')) {
    const text = readFileSync(CHANGELOG, 'utf8')
    if (!LINE_RE.test(text)) {
      console.error('× CHANGELOG.md 里没有「**当前规模**：」这一行')
      process.exitCode = 1
      return
    }
    writeFileSync(CHANGELOG, text.replace(LINE_RE, want), 'utf8')
    console.log('✓ 已更新 CHANGELOG.md')
    console.log('  ' + want)
    return
  }

  if (args.includes('--check')) {
    const text = readFileSync(CHANGELOG, 'utf8')
    const m = text.match(LINE_RE)
    if (!m) {
      console.error('× CHANGELOG.md 里没有「**当前规模**：」这一行')
      process.exitCode = 1
      return
    }
    if (m[0].trim() !== want) {
      console.error('× 规模数字过期了：')
      console.error('  写的：' + m[0].trim())
      console.error('  实际：' + want)
      console.error('  修：node scripts/scale.mjs --write')
      process.exitCode = 1
      return
    }
    console.log('✓ 规模数字与磁盘一致')
    console.log('  ' + want)
    return
  }

  console.log(want)
}

if (process.argv[1] && process.argv[1].endsWith('scale.mjs')) main()
