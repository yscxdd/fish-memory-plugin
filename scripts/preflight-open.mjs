#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * preflight-open.mjs — 上传到 GitHub 之前的自检（给"不想靠眼"的人）。
 *
 * 它查五件事，任何一件不对就退 1，并告诉你怎么修：
 *   ① 必需的文件在不在（LICENSE / README / package.json / CONTRIBUTING …）
 *   ② 有没有把**记忆库**带进仓库（fish-memory/、fish-memory-backups/、50_log/、20_index/）
 *   ③ 有没有打包产物 / 临时文件（*.zip、.inject-baseline.json、node_modules/）
 *   ④ 文本文件里有没有**个人路径或用户名**（C:\Users\<你>、D:\Users、Administrator、/home/<user>）
 *   ⑤ 有没有大文件（>5 MB，GitHub 会拒；也说明放错了东西）
 *
 * 用法（在 fish-memory-plugin 目录里）：
 *   node scripts/preflight-open.mjs
 *   node scripts/preflight-open.mjs --json
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  '.gitignore',
  'cordis.patch.yml',
  'lib/index.js',
  'scripts/memory.mjs',
  'test',
  'docs/ARCHITECTURE.md',
  'docs/MAINTAINING.md',
  'docs/DESCRIPTION.md',
  '.github/workflows/ci.yml',
]

const FORBIDDEN_TOP = ['fish-memory', 'fish-memory-backups', '20_index', '50_log', 'node_modules', '_refs', '_debug']
const FORBIDDEN_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz']
const FORBIDDEN_NAMES = ['.inject-baseline.json', 'Thumbs.db', '.DS_Store']
const TEXT_EXT = ['.md', '.js', '.mjs', '.json', '.yml', '.yaml', '.txt', '.patch']
// 只认"真正的用户名"：`C:\Users\<用户名>`、`/home/<user>` 这类**占位符不算**（文档里就写着它们）
// 判据：Users/ 后面必须紧跟字母数字，不能是 `<` 或 `%`。
const PII = [
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9][^\\\s'"`]*/i, why: '绝对路径（会暴露用户名）' },
  { re: /\/home\/[A-Za-z0-9][A-Za-z0-9._-]*/i, why: 'Linux 家目录绝对路径' },
  { re: /\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*/i, why: 'macOS 家目录绝对路径' },
]
// 自检脚本自己含这些正则，跳过它
const SELF = fileURLToPath(import.meta.url)
const MAX_BYTES = 5 * 1024 * 1024

const problems = []
const notes = []

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push({ path: p, name, bytes: st.size })
  }
  return out
}

// ① 必需文件
for (const rel of REQUIRED) {
  if (!existsSync(join(pkgRoot, rel))) problems.push(`缺必需文件：${rel}（参考 CONTRIBUTING.md）`)
}

// ② 记忆库绝不许进仓库
for (const name of FORBIDDEN_TOP) {
  if (existsSync(join(pkgRoot, name))) problems.push(`仓库里出现了 ${name}/ —— 那是记忆库或依赖，不能上传（.gitignore 已挡，但说明你在错误目录建仓库）`)
}

const files = existsSync(pkgRoot) ? walk(pkgRoot) : []

// ③ 打包产物 / 临时文件
for (const f of files) {
  if (FORBIDDEN_EXT.includes(f.path.slice(f.path.lastIndexOf('.')).toLowerCase())) problems.push(`打包产物：${relative(pkgRoot, f.path)}`)
  if (FORBIDDEN_NAMES.includes(f.name)) problems.push(`临时文件：${relative(pkgRoot, f.path)}`)
}

// ④ 个人路径 / 用户名
for (const f of files) {
  const ext = f.path.slice(f.path.lastIndexOf('.')).toLowerCase()
  if (!TEXT_EXT.includes(ext)) continue
  if (f.path === SELF) continue
  let text = ''
  try {
    text = readFileSync(f.path, 'utf8')
  } catch {
    continue
  }
  for (const { re, why } of PII) {
    const m = text.match(re)
    if (m) problems.push(`${why}：${relative(pkgRoot, f.path)} → 命中「${m[0]}」`)
  }
}

// ⑤ 大文件
for (const f of files) {
  if (f.bytes > MAX_BYTES) problems.push(`大文件（${Math.round(f.bytes / 1024 / 1024)} MB）：${relative(pkgRoot, f.path)}`)
}

// 提醒（不是错误）
if (existsSync(join(pkgRoot, 'samples'))) notes.push('samples/ 是**合成**演示记忆点，不是任何人的真实经历（README 已注明）')
if (!existsSync(join(pkgRoot, '.github/workflows/ci.yml'))) notes.push('没有 CI：PR 不会自动跑测试（建议补 .github/workflows/ci.yml）')

const ok = problems.length === 0
if (asJson) {
  console.log(JSON.stringify({ ok, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), problems, notes }, null, 2))
} else {
  console.log(`仓库目录：${pkgRoot}`)
  console.log(`文件数：${files.length} · 合计 ${(files.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024).toFixed(2)} MB\n`)
  if (ok) {
    console.log('✓ 可以上传：没有记忆库、没有打包产物、文本里没有个人路径')
  } else {
    for (const p of problems) console.error(`✗ ${p}`)
    console.error(`\n✗ 有 ${problems.length} 项要先处理（上面每一条都写了怎么修）`)
  }
  for (const n of notes) console.log(`· ${n}`)
}
process.exit(ok ? 0 : 1)
