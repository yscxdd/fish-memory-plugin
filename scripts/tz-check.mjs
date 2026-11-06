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
  // v0.53.0：原本这里有 3 条"只在纽约时区失败"的债（identity.startRun、档案链 #1/#3）。
  // 根因是**测试**用 UTC 时间戳构造、而库按**本地日**分文件（库是对的，测试是错的）。
  // 现在已改测试，白名单清空——但保留这个空数组，让结构自解释：以后再加债，
  // 就往对应的时区里放，别在别处开小灶。
  'America/New_York': [],
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
  // v0.67.1（F3）：stdout 被管道接走时 Node 会切到 TAP reporter（`# tests 799`），
  // 而这里的 parser 只认 spec 的 `ℹ tests 799` → 解析出 0/0 却打 ✓。
  // **一个门禁在测不到东西的时候必须红。** 现在显式指定 reporter。
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], {
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
    let r = runZone(zone)
    // v0.67.1（F3）：0 条也算失败——解析器对着空输出说自己"没有新失败"，是假绿
    if (!(r.tests > 0)) r = { ...r, failed: [...(r.failed || []), '(解析到 0 条用例——reporter 或解析器坏了)'] }
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

// 防御：就算哪天又被丢进测试目录，也不要在测试进程里递归跑
if (process.argv[1] && process.argv[1].endsWith('tz-check.mjs') && !process.env.NODE_TEST_CONTEXT) main()
