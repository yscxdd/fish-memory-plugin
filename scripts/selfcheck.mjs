#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * selfcheck.mjs — 一次跑完所有闸门，给"新会话/新机器"用。
 *
 * 为什么要有：验证散在 9 个命令里（verify / gold / hostcheck / compat / check / audit /
 * privacy / 完整性 / vault），新来的人（或下一个我）容易漏跑一两项，然后对着半绿的状态猜。
 * 这里把它们收成一张表：**每项 PASS/FAIL + 一句为什么**，退出码 1 = 有失败。
 *
 * 跑法：
 *   node scripts/selfcheck.mjs                # 默认查插件目录旁边的 fish-memory/
 *   node scripts/selfcheck.mjs --dir <库> --json
 *
 * 注意：`node --test` 不在里面（它是测试套件，不是闸门）；跑完这条再单独跑它。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { audit, readArchive, readPointFiles, validatePoint } from '../lib/toolkit.js'
import { checkHost } from '../lib/hostcheck.js'
import { readCompatRecord } from '../lib/compat.js'
import { checkArchive } from '../lib/integrity.js'
import { privacyReport } from '../lib/privacy.js'
import { runGold } from '../lib/goldset.js'
import { fingerprintDir } from '../lib/util.js'
import { verifyPackage } from '../lib/verify.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const dirIdx = argv.indexOf('--dir')
const asJson = argv.includes('--json')
const dir = resolve(dirIdx >= 0 ? argv[dirIdx + 1] : join(pkgRoot, '..', 'fish-memory'))

const rows = []
const add = (name, ok, detail, level = 'fail') => rows.push({ name, ok, detail, level })

// ① 发版自检（文件在不在、BOM、apply 导出）
try {
  const r = verifyPackage(pkgRoot)
  add('包自检 verify', r.ok, r.ok ? '必需文件齐全、无 BOM' : r.errors.join('；'))
} catch (e) {
  add('包自检 verify', false, String(e?.message || e))
}

// ② 金标召回
try {
  const r = runGold()
  add('金标 gold', r.hits >= 16 && r.falsePositives.length === 0, `${r.hits}/${r.total} 命中、负例误命中 ${r.falsePositives.length}、边际 ${r.margin}`)
} catch (e) {
  add('金标 gold', false, String(e?.message || e))
}

// ③ 宿主口子（静态）
try {
  const r = checkHost(pkgRoot)
  add('宿主口子 hostcheck', r.ok, r.ok ? `${r.points.length} 个口子都有标记、无 ctx 泄漏` : r.errors.join('；'))
} catch (e) {
  add('宿主口子 hostcheck', false, String(e?.message || e))
}

// ④ 记忆库在不在（后面几项都靠它）
if (!existsSync(dir)) {
  add('记忆库存在', false, `找不到 ${dir}（用 --dir 指定）`)
} else {
  add('记忆库存在', true, dir)

  // ⑤ 点校验（与 check 命令同一条判据）
  try {
    const archive = readArchive(dir)
    const points = readPointFiles(dir, '30_points')
    const pending = readPointFiles(dir, '40_pending')
    const all = [...points, ...pending].map((p) => ({ id: p.id, ...validatePoint(p, { archive, points }) }))
    const bad = all.filter((x) => x.errors.length)
    const warned = all.filter((x) => !x.errors.length && x.warnings.length)
    add('点校验 check', bad.length === 0, `${all.length} 条，${bad.length} 条硬错误${warned.length ? `，${warned.length} 条告警` : ''}`)
  } catch (e) {
    add('点校验 check', false, String(e?.message || e))
  }

  // ⑥ 审计（§10 契约）
  try {
    const r = audit(dir)
    add('审计 audit', r.passed, r.passed ? '全部阻塞项通过' : r.checks.filter((c) => !c.ok).map((c) => c.id).join('、'))
  } catch (e) {
    add('审计 audit', false, String(e?.message || e))
  }

  // ⑦ 档案完整性（全库，不是只看最后一个文件）
  try {
    const r = checkArchive(dir, { persist: false })
    add(
      '档案完整性',
      r.ok,
      `${r.checked} 个文件 · 改过 ${r.changed.length} · 丢了 ${r.missing.length} · 坏链 ${r.broken.length}${r.sampled ? '（抽样）' : ''}`,
    )
  } catch (e) {
    add('档案完整性', false, String(e?.message || e))
  }

  // ⑧ 版更对照（缺了口子 / 崩过）
  try {
    const { surface, failures } = readCompatRecord(dir)
    const required = surface?.requiredMissing || []
    const ok = required.length === 0 && failures.length === 0
    const detail = surface
      ? `缺必需口子 ${required.length}、加载失败记录 ${failures.length}`
      : '还没有宿主快照（插件还没在这个库上加载过）'
    add('版更对照 compat', ok, detail, surface ? 'fail' : 'warn')
  } catch (e) {
    add('版更对照 compat', false, String(e?.message || e))
  }

  // ⑨ 隐私（会被 git 带走吗）
  try {
    const r = privacyReport(dir)
    add(
      '隐私 privacy',
      r.risks.length === 0,
      r.repo ? `在 ${r.repo} 里；记忆库${r.memoryIgnored ? '已' : '未'}忽略、备份${r.backupIgnored ? '已' : '未'}忽略` : '不在 git 仓库里',
      r.repo ? 'fail' : 'pass',
    )
  } catch (e) {
    add('隐私 privacy', false, String(e?.message || e))
  }

  // ⑩ vault 视图（有就检查是不是派生物；没有只提示）
  try {
    const idx = join(dir, '20_index', 'index.md')
    if (!existsSync(idx)) add('vault 视图', true, '还没生成（跑 memory vault 即可）', 'warn')
    else {
      const text = readFileSync(idx, 'utf8')
      add('vault 视图', text.includes('derived: true'), text.includes('derived: true') ? '入口页是派生物' : '入口页缺少 derived 标记', 'warn')
    }
  } catch (e) {
    add('vault 视图', false, String(e?.message || e), 'warn')
  }

  // ⑪ 环境：装了哪个版本、库多大
  try {
    const pkgVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version
    const profilePkg = join(process.env.DSH_PROFILE_DIR || '', 'node_modules', 'dsh-fish-memory', 'package.json')
    let installed = '未在 profile 里找到'
    if (process.env.DSH_PROFILE_DIR && existsSync(profilePkg)) {
      installed = JSON.parse(readFileSync(profilePkg, 'utf8')).version
    }
    add('版本一致', true, `源码 v${pkgVersion} · profile ${installed}（环境变量 DSH_PROFILE_DIR 未设时跳过比对）`, 'warn')

    // ⑫ 运行时版本：磁盘一致 ≠ 进程里也一致（v0.13.1）
    // 这个项目反复栽在"改了源码但没生效"上；唯一知道进程里是哪一版的地方，是它自己启动时写的 host.log。
    const hostLog = join(dir, '50_log', 'host.log')
    let rec = null
    if (existsSync(hostLog)) {
      const last = readFileSync(hostLog, 'utf8').trim().split('\n').filter(Boolean).pop()
      try {
        rec = JSON.parse(last) ?? null
      } catch {
        rec = null
      }
    }
    const live = rec?.plugin ?? null
    const liveLib = rec?.lib ?? null
    const localLib = fingerprintDir(join(pkgRoot, 'lib'))
    if (liveLib) {
      // 指纹比版本号诚实：只 bump 版本不动 lib/ 时，进程里的代码其实没变，不该报"要重启"
      if (liveLib === localLib) {
        add('运行时版本', true, `进程里的 lib 与磁盘一致（lib ${localLib}，进程 v${live}）`, 'warn')
      } else {
        add(
          '运行时版本',
          false,
          `进程 lib ${liveLib}（v${live}）· 磁盘 lib ${localLib}（v${pkgVersion}）→ 关/开一次插件才生效`,
          'warn',
        )
      }
    } else if (live !== null) {
      add('运行时版本', true, `进程 v${live}，启动记录没有 lib 指纹（v0.13.2 之前）`, 'warn')
    } else {
      add('运行时版本', true, 'host.log 里没有版本字段（v0.13.1 之前的启动记录）', 'warn')
    }
  } catch {
    /* 环境信息拿不到不算失败 */
  }
}

const failed = rows.filter((r) => !r.ok && r.level === 'fail')
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, dir, rows }, null, 2))
} else {
  console.log(`记忆库：${dir}`)
  console.log(`node：${process.versions.node}\n`)
  for (const r of rows) {
    const mark = r.ok ? '✓' : r.level === 'warn' ? '!' : '✗'
    console.log(`${mark} ${r.name.padEnd(18)} ${r.detail}`)
  }
  console.log('')
  console.log(failed.length ? `✗ 有 ${failed.length} 项失败：${failed.map((f) => f.name).join('、')}` : '✓ 所有闸门通过')
  console.log('别忘了还有测试套件：cd fish-memory-plugin && node --test')
}
process.exit(failed.length ? 1 : 0)
