#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * test-tz.mjs — 同一套测试，三个时区各跑一遍（v0.52.2）。
 *
 * 为什么要有：v0.50.0–v0.52.0 的 CI **连红三次**，原因只有一条——
 * 我在测试里写死了 `+08:00`，本地过、GitHub runner（UTC）不过。
 * "记得跑三个时区"不能靠记性，得有个命令。
 *
 * 用法：
 *   node scripts/test-tz.mjs            # 三个时区
 *   node scripts/test-tz.mjs UTC        # 只跑一个
 *   node scripts/test-tz.mjs --json     # 机器可读
 *
 * 退出码：
 *   0 = 三个时区都只有"已知债"在失败（或全绿）
 *   1 = 出现**新的**失败（这一条才是真信号）
 *
 * 「已知债」白名单写在下面：只在特定时区失败、且已经查清原因的老问题。
 * 它存在的意义不是让命令变绿，是让**新增的时区 bug 立刻显形**。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const ZONES = ['UTC', 'Asia/Shanghai', 'America/New_York']

/**
 * 已知债：这些用例只在下面的时区失败，原因已查（见 CHANGELOG v0.52.1 末尾）。
 * 加东西进这个表之前，先在 CHANGELOG 里写清"为什么"。
 */
export const KNOWN = {
  'America/New_York': [
    'startRun：同一天第二次自动加序号，latestRun 指对',
    '#1 档案只追加：换掉一行的正文，链校验必须失败',
    '#3 幂等（实况）：同一 seq 只入库一次；同一 msgid_plat 换个 seq 会进两行，但审计必须报出来',
  ],
}

/** 从 node --test 的输出里数数、抓失败用例名 */
export function parseTestOutput(text) {
  const nums = {}
  for (const line of String(text).split('\n')) {
    const m = /^ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/.exec(line.trim())
    if (m) nums[m[1]] = Number(m[2])
  }
  const failed = []
  for (const line of String(text).split('\n')) {
    const m = /^✖\s+(.+?)\s+\(\d/.exec(line.trim())
    if (m) failed.push(m[1])
  }
  // 去重（"failing tests:" 之后还会再列一遍）
  return { ...nums, failed: [...new Set(failed)] }
}

function runZone(zone) {
  const r = spawnSync(process.execPath, ['--test'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    env: { ...process.env, TZ: zone },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { zone, ...parseTestOutput(out), status: r.status }
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const zones = args.filter((a) => !a.startsWith('--'))
  const list = zones.length ? zones : ZONES

  const results = []
  for (const zone of list) {
    const r = runZone(zone)
    const known = new Set(KNOWN[zone] || [])
    const fresh = r.failed.filter((f) => !known.has(f))
    const stale = r.failed.filter((f) => known.has(f))
    results.push({ ...r, fresh, stale, ok: fresh.length === 0 })
  }

  if (json) {
    console.log(JSON.stringify({ results }, null, 2))
  } else {
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗'
      const debt = r.stale.length ? ` · 已知债 ${r.stale.length}` : ''
      console.log(`${mark} ${r.zone.padEnd(18)} pass ${r.pass ?? 0}/${r.tests ?? 0}${debt}`)
      for (const f of r.fresh) console.log(`    ✗ 新失败：${f}`)
    }
    const bad = results.filter((r) => !r.ok)
    console.log('')
    console.log(bad.length ? `✗ ${bad.length} 个时区有**新**失败` : '✓ 没有新的时区相关失败')
    if (!bad.length) {
      const debt = results.reduce((n, r) => n + r.stale.length, 0)
      if (debt) console.log(`  （已知债 ${debt} 条，见本文件 KNOWN 与 CHANGELOG v0.52.1）`)
    }
  }

  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('test-tz.mjs')) main()
