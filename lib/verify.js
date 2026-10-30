// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * verify.js — 发版前自检。防的是"发出去才发现装不上"这一类事故（BOM、缺文件、JSON 坏）。
 * 只读，不改任何东西。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const REQUIRED = ['lib/index.js', 'lib/host.js', 'cordis.patch.yml', 'README.md', 'scripts/memory.mjs']
const SOURCE_EXT = /\.(js|mjs|json|yml|md)$/

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('_')) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs, base, out)
    else out.push(relative(base, abs))
  }
  return out
}

/**
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function verifyPackage(root) {
  const errors = []
  const warnings = []

  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, errors: ['缺 package.json'], warnings }

  let raw
  try {
    raw = readFileSync(pkgPath, 'utf8')
  } catch (e) {
    return { ok: false, errors: [`package.json 读不了：${e.message}`], warnings }
  }
  if (raw.charCodeAt(0) === 0xfeff) errors.push('package.json 带 UTF-8 BOM（JSON.parse 会失败）')
  try {
    JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    errors.push(`package.json 不是合法 JSON：${e.message}`)
  }

  for (const f of REQUIRED) if (!existsSync(join(root, f))) errors.push(`缺必需文件：${f}`)

  const idx = join(root, 'lib', 'index.js')
  if (existsSync(idx)) {
    const src = readFileSync(idx, 'utf8')
    if (!/export function apply/.test(src)) errors.push('lib/index.js 没有导出 apply')
    if (!/export const (name|inject)/.test(src)) errors.push('lib/index.js 缺 name/inject 声明')
  }

  for (const rel of walk(root)) {
    if (!SOURCE_EXT.test(rel)) continue
    const p = join(root, rel)
    try {
      const b = readFileSync(p)
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) errors.push(`带 BOM：${rel}`)
    } catch {
      warnings.push(`读不了：${rel}`)
    }
    if (/\.tmp-\d+|\.tmp$/.test(rel)) errors.push(`残留临时文件：${rel}`)
  }

  const patch = join(root, 'cordis.patch.yml')
  if (existsSync(patch) && !/name:\s*dsh-fish-memory/.test(readFileSync(patch, 'utf8'))) {
    errors.push('cordis.patch.yml 没有引用 dsh-fish-memory')
  }

  return { ok: errors.length === 0, errors, warnings }
}
