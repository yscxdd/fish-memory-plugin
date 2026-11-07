// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * release-zip.mjs — 打发布包（v0.74.0，A8）。
 *
 * 以前用 PowerShell 的 `Compress-Archive`，它出来的 zip：
 *   · 路径是反斜杠（`docs\发布到GitHub.md`）→ `unzip` 告警，Linux 上解出一个怪文件；
 *   · 中文名不带 UTF-8 标志位 → 解压成 `ÕÅæ...md`。
 *
 * 现在用 `lib/zip.js`：`/` 分隔 + UTF-8 标志位 + deflate。
 *
 * 用法：
 *   node scripts/release-zip.mjs --out <路径> [--dir <插件目录>]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeZip } from '../lib/zip.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const srcDir = resolve(arg('--dir', ROOT))
const outFile = resolve(arg('--out', join(ROOT, '..', `fish-memory-plugin-v${version()}.zip`)))

function version() {
  try {
    return JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// 进包的东西：和以前一致（不含 node_modules / .git / 临时目录）
const INCLUDE = [
  'lib',
  'scripts',
  'test',
  'samples',
  'skills',
  'docs',
  '.github',
  'LICENSE',
  '.gitignore',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'package.json',
  'README.md',
  'cordis.patch.yml',
]

const SKIP_DIRS = new Set(['node_modules', '.git', '20_index', '90_snapshot'])

function walk(abs, base, out) {
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(abs, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) walk(full, rel, out)
    else if (e.isFile()) out.push({ name: rel, data: readFileSync(full) })
  }
  return out
}

const files = []
for (const top of INCLUDE) {
  const abs = join(srcDir, top)
  let st
  try {
    st = statSync(abs)
  } catch {
    continue // 缺的就不打（比如某些仓库没有 samples）
  }
  if (st.isDirectory()) walk(abs, top, files)
  else files.push({ name: top, data: readFileSync(abs) })
}

// 名字统一成 `/`（writeZip 也会做，这里先做一次以便排序稳定）
files.sort((a, b) => a.name.localeCompare(b.name, 'en'))
const r = writeZip(files, outFile)
console.log(`✓ ${outFile}`)
console.log(`  ${r.files} 个文件 · ${(r.bytes / 1024).toFixed(0)} KB`)
console.log(`  sha256 ${r.digest}`)
