#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * upload-release.mjs — 把打包好的 zip 传到 GitHub Release 的附件里。
 *
 * 为什么要单独一个脚本：Release 附件**只能走 HTTPS API**，`git push` 推不上去。
 * 而且上传地址是 uploads.github.com（不是 github.com），部分网络环境下要单独验证。
 *
 * 用法：
 *   $env:GH_TOKEN = "github_pat_xxx"       # 细粒度 token，权限只要 Contents: Read and write
 *   node scripts/upload-release.mjs v0.14.1 ..\fish-memory-plugin-v0.14.1.zip
 *
 * 可选：
 *   --repo owner/name   默认从 git remote 里解析
 *   --clobber           同名附件已存在时先删掉再传
 *   --dry               只打印要做什么，不发请求
 *
 * 退出码：0 成功 / 1 失败，失败时打印 GitHub 返回的原始错误。
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const pos = argv.filter((a) => !a.startsWith('--'))
const [tag, file] = pos

const die = (msg) => {
  console.error('✗ ' + msg)
  process.exit(1)
}

if (!tag || !file) {
  die('用法：node scripts/upload-release.mjs <tag> <文件> [--repo owner/name] [--clobber] [--dry]')
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token && !flags.has('--dry')) {
  die('没有 token。先设环境变量：$env:GH_TOKEN = "github_pat_xxx"（细粒度，权限只需 Contents: Read and write）')
}

function resolveRepo() {
  const i = pos.indexOf('--repo')
  if (i >= 0 && pos[i + 1]) return pos[i + 1]
  const j = argv.indexOf('--repo')
  if (j >= 0 && argv[j + 1]) return argv[j + 1]
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
    if (m) return `${m[1]}/${m[2]}`
  } catch {
    /* 没有 git 或没有 remote */
  }
  die('拿不到仓库名，请显式传 --repo owner/name')
}

const repo = resolveRepo()
const path = resolve(file)
const name = basename(path)
const API = 'https://api.github.com'
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'fish-memory-upload-release',
}

let size
try {
  size = statSync(path).size
} catch {
  die(`文件不存在：${path}`)
}
const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')

console.log(`仓库   : ${repo}`)
console.log(`标签   : ${tag}`)
console.log(`文件   : ${name} (${(size / 1024).toFixed(0)} KB)`)
console.log(`SHA256 : ${sha256}`)

if (flags.has('--dry')) {
  console.log('\n（--dry：只检查，不真正上传。）如果这一步能读到最后一行，说明文件和仓库名都对。')
  process.exit(0)
}

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON */
  }
  return { res, text, json }
}

// ① 找到 release
const got = await api(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
if (got.res.status === 404) die(`这个仓库没有 ${tag} 的 release。先在网页上 Draft a new release，或先推 tag。`)
if (!got.res.ok) die(`查 release 失败：HTTP ${got.res.status} ${got.text.slice(0, 200)}`)
const release = got.json
console.log(`release: id=${release.id} · ${release.tag_name} · 已有附件 ${release.assets.length} 个`)

// ② 同名附件已存在？
const same = release.assets.find((a) => a.name === name)
if (same) {
  if (!flags.has('--clobber')) {
    console.log(`\n· 已经有同名附件：${same.browser_download_url}`)
    console.log('  要覆盖就加 --clobber')
    process.exit(0)
  }
  console.log(`· 删除旧附件 ${same.name} …`)
  const del = await api(`${API}/repos/${repo}/releases/assets/${same.id}`, { method: 'DELETE' })
  if (!del.res.ok && del.res.status !== 404) die(`删旧附件失败：HTTP ${del.res.status} ${del.text.slice(0, 200)}`)
}

// ③ 上传（注意：走 uploads.github.com，不是 api.github.com）
console.log('· 上传中 …')
const uploaded = await api(
  `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size) },
    body: readFileSync(path),
  },
)
if (!uploaded.res.ok) die(`上传失败：HTTP ${uploaded.res.status}\n${uploaded.text.slice(0, 400)}`)

const a = uploaded.json
console.log('\n✓ 上传成功')
console.log(`  大小: ${a.size} 字节（本地 ${size} 字节）`)
console.log(`  下载: ${a.browser_download_url}`)
console.log(`  指纹: ${sha256}`)
console.log('\n（提醒：传完可以去 GitHub 上把 token 删掉/过期，它只在这次上传时有用。）')
