#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * audit-self.mjs — 审**自己的**仓库：静态、离线、零依赖、只读。
 *
 * 它不做"自动挖洞"，也不碰任何网络或第三方目标。它只做一件事：
 * 把这个项目**用血换来的规矩**变成可执行的检查，防止下次改代码时又踩回去。
 *
 * 规矩来源：docs/ARCHITECTURE.md、SECURITY.md、契约 §11.5、CHANGELOG 里的事故。
 *
 * 用法：
 *   node scripts/audit-self.mjs                    # 审当前仓库（人读）
 *   node scripts/audit-self.mjs --dir ..\x          # 审别的目录
 *   node scripts/audit-self.mjs --json              # 机器读
 *   node scripts/audit-self.mjs --out report.md     # 写一份 markdown 报告
 *   node scripts/audit-self.mjs --strict            # 有 warn 也退 1
 *
 * 抑制：在某一行末尾加 `// audit-self:ignore`（或下一行），那一行不再报。
 * 退出码：0 没 error（warn 不影响）/ 1 有 error / 2 用法错。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}

const target = resolve(value('--dir') || pkgRoot)
const asJson = flag('--json')
const strict = flag('--strict')
const outFile = value('--out')

const SKIP_DIRS = new Set(['node_modules', '.git', '.github/ISSUE_TEMPLATE', 'dist', 'build', '.cache'])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.patch', '.crt', '.pem'])
const isDoc = (rel) => /^(docs|skills)\//.test(rel) || rel.endsWith('.md')
const isTest = (rel) => /^test\//.test(rel)
const isSample = (rel) => /^samples\//.test(rel)
const isLib = (rel) => /^lib\//.test(rel)
const isScript = (rel) => /^scripts\//.test(rel)

/** 去掉注释，只留"会被执行"的部分：避免把注释里举例的 ctx.on(...) 当成真实调用 */
function codeOnly(line) {
  return line
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/, '$1')
    .replace(/^\s*\*.*$/, ' ') // JSDoc 的续行
}

const SELF = 'scripts/audit-self.mjs'
/** 明显的占位符不算泄漏（github_pat_xxx / <你的token> / sk-test...） */
const isPlaceholder = (s) => /(xxx|\.{3}|<[^>]*>|your|example|dummy|placeholder|redacted|test[-_]?token)/i.test(s)

/** 规则表：每条都有"为什么"和"怎么修"，因为没人会去查文档 */
const RULES = [
  {
    id: 'secret-in-repo',
    severity: 'error',
    raw: true,
    why: '仓库里出现真实密钥 = 一旦公开就等于泄漏（GitHub 会缓存历史，删了也没用）',
    fix: '立刻作废该密钥、从代码里删掉、再跑一次 git filter-repo 清历史',
    test: (line) =>
      !isPlaceholder(line) &&
      (/(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})/.test(line) ||
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) ||
        /(?:password|passwd|secret|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(line)),
    scope: (rel) => !isDoc(rel) && !isTest(rel) && !isSample(rel),
  },
  {
    id: 'personal-path',
    severity: 'warn',
    raw: true,
    why: '绝对路径里有 Windows/Linux 用户名，会随日志/文档一起被云盘和公开仓库带走',
    fix: '换成 $env:USERPROFILE / ~ 或占位符（<用户名> 这种占位符不算）',
    test: (line) =>
      /[A-Za-z]:\\Users\\[A-Za-z0-9][^\\\s'"`]*/.test(line) || /\/home\/[A-Za-z0-9][A-Za-z0-9._-]*/.test(line),
  },
  {
    id: 'dynamic-code',
    severity: 'error',
    why: 'eval / new Function 会把"数据"变成"代码"，记忆内容一旦进来就是 RCE 面',
    fix: '改成显式解析（JSON.parse 白名单字段），不要执行字符串',
    test: (line) => /\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line),
    scope: (rel) => isLib(rel) || isScript(rel),
  },
  {
    id: 'unsafe-deserialize',
    severity: 'error',
    why: 'pickle / yaml.load 反序列化不可信数据 = 可执行代码（A-mem 就踩这个）',
    fix: '用 JSON；yaml 只用 safe load（safeLoad / safe_load）',
    test: (line) => /\bpickle\.loads?\s*\(/.test(line) || /(?<!safe_)(?<!safe)\byaml\.load\s*\(/.test(line),
    scope: (rel) => isLib(rel) || isScript(rel),
  },
  {
    id: 'network-in-lib',
    severity: 'error',
    why: '契约承诺"不发网络请求、无遥测"；lib/ 里出现网络调用就是违约',
    fix: '删掉；真要联网就做成用户手动触发的 CLI（scripts/），并在文档里写明连哪',
    test: (line) => /\bfetch\s*\(/.test(line) || /\bhttps?\.(request|get)\s*\(/.test(line) || /\bnew\s+WebSocket\b/.test(line),
    scope: (rel) => isLib(rel),
  },
  {
    id: 'ctx-outside-host',
    severity: 'error',
    why: '宿主口子只允许在 lib/host.js 里碰；散落在别处 = 宿主升级时静默炸',
    fix: '通过 host.js 的封装调用（hostcheck 也会查这条）',
    test: (line) => /\bctx\.[A-Za-z]/.test(line),
    scope: (rel) => isLib(rel) && basename(rel) !== 'host.js',
  },
  {
    id: 'archive-write',
    severity: 'error',
    why: '10_archive 是真相层，只追加；别的模块写它就是毁证',
    fix: '走 lib/archive.js 的 append；删除只能走 memory erase（重算链 + 同步备份 + 清单）',
    test: (line) => /['"`]10_archive/.test(line) && /(writeFileSync|appendFileSync|atomicWriteText|truncate|unlinkSync|rmSync)/.test(line),
    scope: (rel) => (isLib(rel) || isScript(rel)) && !['archive.js', 'erase.js', 'pack.js'].includes(basename(rel)),
  },
  {
    id: 'points-bypass',
    severity: 'warn',
    why: '直写 30_points = 绕过"只能写 40_pending + source 校验"的写入纪律',
    fix: '确认这是 promote/invalidate/erase 这类**有闸门**的路径；否则改成写草稿',
    test: (line) => /['"`]30_points/.test(line) && /(writeFileSync|appendFileSync|atomicWriteText|unlinkSync|rmSync)/.test(line),
    scope: (rel) => (isLib(rel) || isScript(rel)) && !['toolkit.js', 'erase.js', 'heal.js', 'bench.mjs'].includes(basename(rel)),
  },
  {
    id: 'silent-catch',
    severity: 'warn',
    why: 'catch 里静默忽略 = 故障看起来像成功（mem0 的教训：分不清"没有"和"坏了"）',
    fix: '至少写日志或计数；影响用户结论的必须抛出',
    test: (line) => /\bcatch\s*(\([^)]*\))?\s*\{\s*(\/\*|\/\/)\s*(ignore|ignore[ds]?|silent|noop|swallow)/i.test(line),
    scope: (rel) => isLib(rel),
  },
  {
    id: 'todo-left',
    severity: 'info',
    skipSelf: true,
    why: '统计用：TODO/FIXME 太多说明有未收口的改动',
    fix: '要么做，要么写进 issue',
    test: (line) => /\b(TODO|FIXME|XXX|HACK)\b/.test(line),
    scope: (rel) => isLib(rel) || isScript(rel),
    countOnly: true,
  },
  {
    id: 'agpl-text',
    severity: 'warn',
    raw: true,
    skipSelf: true,
    why: 'AGPL-3.0 有传染性：拷进 MIT 仓库就是许可证冲突（basic-memory 踩过）',
    fix: '只读思路、不拷代码；必要时隔离在不会被提交的目录里',
    test: (line) => /GNU AFFERO GENERAL PUBLIC LICENSE/i.test(line),
  },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.git') continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const findings = []
const files = walk(target)
let scanned = 0

for (const path of files) {
  const rel = relative(target, path).replaceAll('\\', '/')
  if (rel.split('/').some((s) => SKIP_DIRS.has(s))) continue
  const ext = extname(path).toLowerCase()
  const isLicenseish = /^license/i.test(basename(path)) || basename(path) === 'COPYING'
  if (!TEXT_EXT.has(ext) && !isLicenseish) continue
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  scanned++
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  for (const rule of RULES) {
    if (rule.scope && !rule.scope(rel)) continue
    if (rule.skipSelf && rel === SELF) continue
    let hitCount = 0
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 代码类规则先剥注释：注释里举例的攻击代码不是真调用
      const probe = rule.raw ? line : codeOnly(line)
      if (!rule.test(probe)) continue
      if (/audit-self:ignore/.test(line) || /audit-self:ignore/.test(lines[i + 1] || '')) continue
      hitCount++
      if (hits.length < 3) hits.push({ line: i + 1, text: line.trim().slice(0, 160) })
    }
    if (hitCount === 0) continue
    findings.push({
      rule: rule.id,
      severity: rule.severity,
      file: rel,
      count: hitCount,
      hits,
      why: rule.why,
      fix: rule.fix,
      countOnly: Boolean(rule.countOnly),
    })
  }
}

// ── 仓库级检查（不是逐行）────────────────────────────────────
const repoFindings = []
const pkgPath = join(target, 'package.json')
let pkg = null
try {
  // 必须剥 BOM：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，JSON.parse 直接炸
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
} catch (e) {
  // 不静默：读不出来本身就是问题（这条规则就是用来防"静默吞错"的）
  if (e?.code === 'ENOENT') {
    repoFindings.push({ rule: 'no-package-json', severity: 'info', file: 'package.json', count: 1, hits: [], why: '这个目录没有 package.json，可能不是插件仓库', fix: '确认 --dir 指对了' })
  } else {
    repoFindings.push({
      rule: 'package-json-unreadable',
      severity: 'error',
      file: 'package.json',
      count: 1,
      hits: [{ line: 0, text: String(e?.message || e).slice(0, 160) }],
      why: 'package.json 解析失败（最常见原因：带 BOM，或 JSON 里有注释）',
      fix: '用无 BOM 的 UTF-8 保存；JSON 不允许注释',
    })
  }
}
if (pkg) {
  const deps = Object.keys(pkg.dependencies || {})
  if (deps.length) {
    repoFindings.push({
      rule: 'zero-dependency',
      severity: 'error',
      file: 'package.json',
      count: deps.length,
      hits: [{ line: 0, text: `dependencies: ${deps.join(', ')}` }],
      why: '零依赖是契约（也是"换机器只拷一个目录"的前提）',
      fix: '改用 Node 内置模块；确实必要就先改契约并说明代价',
    })
  }
  if (!pkg.license) {
    repoFindings.push({ rule: 'license-missing', severity: 'warn', file: 'package.json', count: 1, hits: [], why: 'package.json 没写 license', fix: '加 "license": "MIT"' })
  }
}
for (const dir of ['_refs', 'vendor', 'third_party']) {
  try {
    if (statSync(join(target, dir)).isDirectory()) {
      repoFindings.push({
        rule: 'vendored-dir',
        severity: 'warn',
        file: dir + '/',
        count: 1,
        hits: [],
        why: '第三方代码目录：先确认许可证（AGPL 会传染）且没被 .gitignore 漏掉',
        fix: '确需保留就写清来源与许可证；否则移出仓库',
      })
    }
  } catch {
    /* 不存在 */
  }
}

const all = [...findings, ...repoFindings]
const bySeverity = { error: [], warn: [], info: [] }
for (const f of all) bySeverity[f.severity]?.push(f)

const result = {
  target,
  scannedFiles: scanned,
  counts: { error: bySeverity.error.length, warn: bySeverity.warn.length, info: bySeverity.info.length },
  findings: all,
}

// ── 输出 ─────────────────────────────────────────────────────
const sevMark = { error: '✗', warn: '!', info: '·' }

function renderText() {
  const lines = []
  lines.push(`审查目录：${target}`)
  lines.push(`扫了 ${scanned} 个文本文件；error ${result.counts.error} · warn ${result.counts.warn} · info ${result.counts.info}`)
  if (!all.length) {
    lines.push('')
    lines.push('✓ 没发现问题。注意这是**静态规则**，不等于"没有漏洞"——逻辑漏洞它抓不到。')
    return lines.join('\n')
  }
  for (const sev of ['error', 'warn', 'info']) {
    if (!bySeverity[sev].length) continue
    lines.push('')
    lines.push(`${sev.toUpperCase()} (${bySeverity[sev].length})`)
    for (const f of bySeverity[sev]) {
      lines.push(`  ${sevMark[sev]} [${f.rule}] ${f.file}${f.count > 1 ? ` ×${f.count}` : ''}`)
      lines.push(`     为什么：${f.why}`)
      lines.push(`     怎么修：${f.fix}`)
      if (!f.countOnly) for (const h of f.hits) lines.push(`     证据：${h.line ? `L${h.line} ` : ''}${h.text}`)
    }
  }
  return lines.join('\n')
}

function renderMarkdown() {
  const lines = [
    '# 自审报告（静态规则）',
    '',
    `- 目录：\`${target}\``,
    `- 时间：${new Date().toISOString()}`,
    `- 规模：${scanned} 个文本文件`,
    `- 结果：**${result.counts.error} 个 error · ${result.counts.warn} 个 warn · ${result.counts.info} 个 info**`,
    '',
    '> 这是**静态规则检查**，只覆盖本项目踩过的坑；逻辑漏洞、越权、状态机错误它抓不到。每条都要人复核，别把"没报"当成"安全"。',
    '',
  ]
  if (!all.length) lines.push('## 结论', '', '没发现问题。')
  for (const sev of ['error', 'warn', 'info']) {
    if (!bySeverity[sev].length) continue
    lines.push(`## ${sev.toUpperCase()}`, '', '| 规则 | 位置 | 为什么 | 怎么修 |', '|---|---|---|---|')
    for (const f of bySeverity[sev]) {
      lines.push(`| \`${f.rule}\` | \`${f.file}\`${f.count > 1 ? ` ×${f.count}` : ''} | ${f.why} | ${f.fix} |`)
    }
    lines.push('')
    for (const f of bySeverity[sev]) {
      if (f.countOnly || !f.hits.length) continue
      lines.push(`<details><summary>\`${f.rule}\` ${f.file} 的证据</summary>`, '', '```')
      for (const h of f.hits) lines.push(h.line ? `L${h.line}: ${h.text}` : h.text)
      lines.push('```', '', '</details>', '')
    }
  }
  lines.push('## 没查的部分', '', '- 运行期行为（需要真的跑起来、造数据）', '- 逻辑漏洞与越权（需要读状态机）', '- 第三方依赖（本项目零依赖，所以这条恒为空）', '')
  return lines.join('\n')
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(renderText())
  if (outFile) {
    writeFileSync(resolve(outFile), renderMarkdown(), 'utf8')
    console.log(`\n报告已写入：${resolve(outFile)}`)
  }
}

const fail = result.counts.error > 0 || (strict && result.counts.warn > 0)
process.exit(fail ? 1 : 0)
