#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * fidelity.mjs — "还是同一条鱼"的两格刻度（v0.56.0，N1）。
 *
 * 为什么不是金标：金标 20/20 已饱和，测不出任何改进。这两格**现在是未知的**，
 * 而且是对外可比的——别人报 BEAM，我们报"矛盾 + 换窗"。
 *
 * 用法：
 *   node scripts/fidelity.mjs          # 两行数字 + 明细
 *   node scripts/fidelity.mjs --json   # 机器可读（进 CI 也不用模型）
 *
 * 退出码：全过 0；有任何一格掉 1。
 */

import { runFidelity } from '../lib/fidelity.js'

const json = process.argv.includes('--json')
const r = runFidelity()

if (json) {
  console.log(JSON.stringify({ at: r.at, ok: r.ok, contradiction: r.contradiction, handoff: r.handoff }, null, 2))
  process.exit(r.ok ? 0 : 1)
}

const pct = (x) => Math.round(x * 100)

console.log(`保真度（${r.at.slice(0, 16).replace('T', ' ')}）`)
console.log('')
console.log(`  矛盾消解  contradiction_top1  ${r.contradiction.hit}/${r.contradiction.total}  ${pct(r.contradiction.rate)}%`)
for (const row of r.contradiction.rows) {
  console.log(`    ${row.ok ? '✓' : '✗'} 「${row.query}」→ ${row.top ?? '空'}${row.oldIncluded ? '（旧点也在，' + (row.marked ? '带冲突标记' : '**没有标记**') + '）' : ''}`)
}
console.log('')
console.log(`  换窗保留  handoff_retention  ${r.handoff.hit}/${r.handoff.total}  ${pct(r.handoff.rate)}%`)
for (const row of r.handoff.rows) {
  console.log(`    ${row.ok ? '✓' : '✗'} ${row.name}`)
}
console.log('')
console.log(r.ok ? '✓ 两格都满了' : '✗ 有格子没满（这就是基线，先记下来）')
console.log('  说明：不调模型、不联网、只读；矛盾那格测的是"新旧两个版本谁排第一 + 冲突有没有被摊开"。')

process.exit(r.ok ? 0 : 1)
