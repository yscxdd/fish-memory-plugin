// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * doctor.mjs — 体检（v0.86.0）。
 *
 * ## 为什么需要它，以及为什么在**插件外面**
 *
 * 这件事最可能的失败形态不是"数据丢了"，是 **"没人加载插件"**：
 * 对话照常、她什么都不记得、没有任何报错。
 *
 * 你机器上有实证：`profiles/desktop/package.json.bak-fish-missing-20261103-235500`
 * —— 11 月 3 日那天，profile 里的 `dsh-fish-memory` 声明**曾经缺失过**。
 * 而它现在也不在 `dsh.profile.bundles` 清单里，只靠 `dependencies` 里的一行 `link:` 挂着。
 *
 * 所以体检不能写在插件里：插件没加载时，它自己跑不了。
 * 这个脚本只依赖 node 与文件系统，**DSH 好不好、插件在不在，它都能查**。
 *
 * ## 查什么
 *
 *   ① profile 里还有那条 `link:` 声明吗
 *   ② 装进去的那份（junction）读得到吗
 *   ③ 库在吗、core 齐吗、档案链断没断
 *   ④ 最近一份备份还在 48 小时内吗、能不能解开
 *
 * 任何一条不过 → 在**工作区根**写一个显眼的 `⚠️-fish-memory-体检失败.md`。
 *
 * ## 用法
 *
 *   node scripts/doctor.mjs                       # 体检（默认库 ../fish-memory）
 *   node scripts/doctor.mjs --drill               # 顺手做一次恢复演练
 *   node scripts/doctor.mjs --fix                 # 缺 profile 声明就补回去（先备份原文件）
 *   node scripts/doctor.mjs --quiet --json        # 给定时任务用
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { checkArchive } from '../lib/integrity.js'
import { unpackMemory } from '../lib/pack.js'

const PLUGIN_DIR = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const DEFAULT_PROFILE = resolve(process.env.DSH_PROFILE_DIR || join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop'))
const BACKUP_STALE_MS = 48 * 3600_000

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, dflt) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

/** 读 profile 的 package.json（不抛） */
function readProfile(profileDir) {
  const p = join(profileDir, 'package.json')
  if (!existsSync(p)) return { ok: false, path: p, reason: 'profile 里没有 package.json' }
  try {
    return { ok: true, path: p, json: JSON.parse(readFileSync(p, 'utf8')), raw: readFileSync(p, 'utf8') }
  } catch (e) {
    return { ok: false, path: p, reason: `package.json 读不出来：${e?.message || e}` }
  }
}

/**
 * ① profile 声明还在吗
 * @returns {{ok:boolean, detail:string, declared?:string}}
 */
export function checkDeclared(profileDir, pluginDir = PLUGIN_DIR) {
  const prof = readProfile(profileDir)
  if (!prof.ok) return { ok: false, detail: prof.reason }
  const declared = prof.json?.dependencies?.['dsh-fish-memory']
  if (!declared) return { ok: false, detail: 'dependencies 里没有 dsh-fish-memory（插件不会加载，且不报错）' }
  if (!String(declared).startsWith('link:')) {
    return { ok: true, detail: `声明是 ${declared}（不是 link:，仍可能装的是旧拷贝）`, declared }
  }
  const target = String(declared).slice('link:'.length).replace(/\\/g, '/')
  const same = resolve(target).toLowerCase() === resolve(pluginDir).toLowerCase()
  return {
    ok: same,
    detail: same ? `link: 指向本仓库（${target}）` : `link: 指向别处：${target}（不是 ${pluginDir}）`,
    declared,
  }
}

/** ② 装进去的那份读得到吗（junction 断没断） */
export function checkInstalled(profileDir) {
  const base = join(profileDir, 'node_modules', 'dsh-fish-memory')
  if (!existsSync(base)) return { ok: false, detail: `没装：${base}` }
  const entry = join(base, 'lib', 'index.js')
  if (!existsSync(entry)) return { ok: false, detail: `装了但入口不在：${entry}（junction 可能断了）` }
  try {
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
    return { ok: true, detail: `v${pkg.version} · ${entry}` }
  } catch {
    return { ok: true, detail: entry }
  }
}

/** ③ 库在吗、core 齐吗、链断没断 */
export function checkLibrary(dir) {
  if (!existsSync(dir)) return { ok: false, detail: `库不存在：${dir}` }
  const core = join(dir, '00_core')
  const coreFiles = existsSync(core) ? readdirSync(core).filter((f) => f.endsWith('.md') && !f.includes('.draft')) : []
  const soul = join(core, 'soul.md')
  if (!existsSync(soul)) return { ok: false, detail: `核心层缺 soul.md：${soul}` }
  try {
    const chk = checkArchive(dir, { persist: false })
    if (!chk.ok) {
      const why = [...(chk.broken || []).map((b) => b.reason), ...(chk.badLines || []).map((b) => `${b.count} 行坏`)].slice(0, 2)
      return { ok: false, detail: `档案链有问题：${why.join('；') || '原因不明'}` }
    }
    return { ok: true, detail: `core ${coreFiles.length} 个 · 档案 ${chk.checked ?? 0} 条 · 链完整`, coreFiles: coreFiles.length }
  } catch (e) {
    return { ok: false, detail: `档案检查失败：${e?.message || e}` }
  }
}

/** ④ 最近一份备份新鲜吗、能解开吗 */
export function checkBackup(backupRoot, { now = Date.now() } = {}) {
  if (!existsSync(backupRoot)) return { ok: false, detail: `备份目录不存在：${backupRoot}` }
  const dirs = readdirSync(backupRoot)
    .filter((n) => n.startsWith('fish-memory-'))
    .map((n) => ({ name: n, path: join(backupRoot, n) }))
    .filter((x) => statSync(x.path).isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
  if (!dirs.length) return { ok: false, detail: '一份备份都没有' }
  const latest = dirs[0]
  const ageMs = now - statSync(latest.path).mtimeMs
  const hours = Math.round(ageMs / 3600_000)
  const manifest = join(latest.path, 'MANIFEST.json')
  if (!existsSync(manifest)) return { ok: false, detail: `最近一份（${latest.name}）没有 MANIFEST.json`, latest: latest.path }
  let files = 0
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
    if (m.format !== 'fish-memory-pack') return { ok: false, detail: `最近一份格式不对：${m.format}`, latest: latest.path }
    files = (m.files || []).length
  } catch (e) {
    return { ok: false, detail: `MANIFEST 读不出来：${e?.message || e}`, latest: latest.path }
  }
  if (ageMs > BACKUP_STALE_MS) {
    return { ok: false, detail: `最近一份是 ${hours} 小时前（超过 48 小时）：${latest.name}`, latest: latest.path }
  }
  return { ok: true, detail: `最近一份 ${latest.name} · ${hours} 小时前 · ${files} 个文件`, latest: latest.path, count: dirs.length }
}

/**
 * 恢复演练：把最近一份备份解开到临时目录，验一遍链。
 * **备份没验过 = 希望**，所以这条要能定期跑。
 */
export function runDrill(backupRoot) {
  const tmp = join(process.env.TEMP || '/tmp', `fish-doctor-drill-${process.pid}`)
  try {
    const dirs = readdirSync(backupRoot)
      .filter((n) => n.startsWith('fish-memory-'))
      .sort()
      .reverse()
    if (!dirs.length) return { ok: false, detail: '没有可演练的备份' }
    const src = join(backupRoot, dirs[0])
    unpackMemory(src, tmp, { force: true })
    const chk = checkArchive(tmp, { persist: false })
    const points = existsSync(join(tmp, '30_points')) ? readdirSync(join(tmp, '30_points')).filter((f) => f.endsWith('.md')).length : 0
    return {
      ok: chk.ok,
      detail: chk.ok
        ? `演练通过：${dirs[0]} → 档案 ${chk.checked ?? 0} 条 · 记忆点 ${points} 个 · 链完整`
        : `演练失败：解出来的库链不完整`,
      source: dirs[0],
    }
  } catch (e) {
    return { ok: false, detail: `演练失败：${e?.message || e}` }
  } finally {
    try {
      const { rmSync } = awaitImportFs()
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 清不掉临时目录不影响结论 */
    }
  }
}

// 静态 import 一份（ESM 里不走动态 require）
import { rmSync } from 'node:fs'
function awaitImportFs() {
  return { rmSync }
}

/** --fix：只补"缺的那一行"，绝不删别的；改之前先备份 profile */
export function fixDeclared(profileDir, pluginDir = PLUGIN_DIR) {
  const prof = readProfile(profileDir)
  if (!prof.ok) return { ok: false, detail: prof.reason }
  const json = prof.json
  json.dependencies = json.dependencies || {}
  if (json.dependencies['dsh-fish-memory']) {
    return { ok: true, detail: '已经有声明，不需要修' }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bak = `${prof.path}.bak-doctor-${stamp}`
  writeFileSync(bak, prof.raw, 'utf8')
  json.dependencies['dsh-fish-memory'] = `link:${pluginDir.replace(/\\/g, '/')}`
  writeFileSync(prof.path, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  return { ok: true, detail: `已补回声明：link:${pluginDir}（原文件备份到 ${bak}）` }
}

/**
 * 备份位置提示（不判失败）。
 *
 * 现状：备份默认落在 `<库的父目录>/fish-memory-backups`——**和库同一块盘**。
 * 硬盘坏了、工作区被 `git clean -fdx` 清了，两份一起没。
 * 这条只提示不拦：把它挪到另一块盘是个决定，不是 bug。
 */
export function checkBackupLocation(libDir, backupRoot) {
  const lib = resolve(libDir).toLowerCase()
  const bak = resolve(backupRoot).toLowerCase()
  if (bak.startsWith(lib.slice(0, 3))) {
    const sameRoot = lib.slice(0, 2) === bak.slice(0, 2)
    return {
      ok: true,
      warn: true,
      detail: sameRoot
        ? `备份和库在同一个盘（${bak.slice(0, 2)}）：这块盘坏了两份一起没；想更稳就把 FISH_MEMORY_BACKUP 指到另一块盘`
        : '备份在另一个盘上',
    }
  }
  return { ok: true, detail: '备份不在库所在的盘' }
}

/** 失败时在工作区根放一个显眼的文件（他会看见） */
export function writeAlert(workspaceRoot, lines) {
  const p = join(workspaceRoot, '⚠️-fish-memory-体检失败.md')
  try {
    writeFileSync(
      p,
      [
        '# ⚠️ 大肥鱼记忆体检没通过',
        '',
        `时间：${new Date().toISOString()}`,
        '',
        '对话会照常进行，但她可能什么都想不起来——**而且不会报错**。',
        '',
        ...lines.map((l) => `- ${l}`),
        '',
        '## 怎么修',
        '',
        '```powershell',
        'node scripts/doctor.mjs --fix     # 补回插件声明（会先备份 profile）',
        'node scripts/memory.mjs verify    # 看档案链',
        '```',
        '',
        '修完把这个文件删掉即可（它是给你看的，不是给她看的）。',
        '',
      ].join('\n'),
      'utf8',
    )
    return p
  } catch {
    return null
  }
}

export function runDoctor({ dir, profileDir = DEFAULT_PROFILE, backupRoot, drill = false, fix = false, now = Date.now() } = {}) {
  const lib = resolve(dir || join(PLUGIN_DIR, '..', 'fish-memory'))
  const bRoot = resolve(backupRoot || join(lib, '..', 'fish-memory-backups'))
  const results = []

  let declared = checkDeclared(profileDir)
  if (!declared.ok && fix) {
    const fixed = fixDeclared(profileDir)
    results.push({ name: 'profile 声明', ...fixed, fixed: true })
    declared = checkDeclared(profileDir)
  } else {
    results.push({ name: 'profile 声明', ...declared })
  }
  results.push({ name: '装进去的那份', ...checkInstalled(profileDir) })
  results.push({ name: '记忆库', ...checkLibrary(lib) })
  results.push({ name: '最近备份', ...checkBackup(bRoot, { now }) })
  results.push({ name: '备份位置', ...checkBackupLocation(lib, bRoot) })
  if (drill) results.push({ name: '恢复演练', ...runDrill(bRoot) })

  const bad = results.filter((r) => !r.ok)
  return { ok: bad.length === 0, dir: lib, profileDir, backupRoot: bRoot, results, bad }
}

// ── CLI ────────────────────────────────────────────────────────
const isMain = process.argv[1] && /doctor\.mjs$/.test(process.argv[1]) && !process.env.NODE_TEST_CONTEXT
if (isMain) {
  const dir = val('--dir', join(PLUGIN_DIR, '..', 'fish-memory'))
  const profileDir = val('--profile', DEFAULT_PROFILE)
  const r = runDoctor({ dir, profileDir, drill: has('--drill'), fix: has('--fix') })

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else if (!has('--quiet')) {
    for (const x of r.results) console.log(`  ${x.ok ? (x.warn ? '!' : '✓') : '✗'} ${x.name}：${x.detail}`)
    console.log('')
    console.log(r.ok ? '✓ 体检通过：她去接话时读得到记忆' : `✗ 体检没通过：${r.bad.length} 条`)
  }

  if (!r.ok) {
    const alert = writeAlert(resolve(dir, '..'), r.bad.map((b) => `${b.name}：${b.detail}`))
    if (alert && !has('--quiet')) console.log(`  已写告警文件：${alert}`)
    process.exitCode = 1
  } else {
    // 过了就把旧告警删掉（它是给"没过"用的）
    try {
      const stale = join(resolve(dir, '..'), '⚠️-fish-memory-体检失败.md')
      if (existsSync(stale)) renameSync(stale, `${stale}.已修复-${Date.now()}`)
    } catch {
      /* 删不掉就留着 */
    }
  }
}

export { PLUGIN_DIR, DEFAULT_PROFILE }
