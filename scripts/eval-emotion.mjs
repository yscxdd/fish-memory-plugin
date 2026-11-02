#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪词典的评测基线（v0.32.0）。
 *
 * 存在的理由：我们一直只有"测试通过"（结构对不对），没有"判断准不准"。
 * 这个脚本拿一份**人工标注**的样本，报出本地词典的：
 *   · 三分类准确率（负 / 中 / 正）与只看符号的准确率
 *   · 混淆矩阵、每类 P/R/F1、平均绝对误差（MAE）
 *   · easy / hard 两档分开报（hard = 反讽、否定、转述、混合）
 *
 * 用法：
 *   node scripts/eval-emotion.mjs                 # 人读
 *   node scripts/eval-emotion.mjs --json          # 给 CI / 别的脚本吃
 *   node scripts/eval-emotion.mjs --file x.jsonl  # 换数据集
 *   node scripts/eval-emotion.mjs --wrong 15      # 多列几条错例
 *
 * **注意**：标注是人工打的，属于"主观基线"，不是金标准。hard 那档才是重点。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lexiconValence } from '../lib/emotion.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_FILE = join(HERE, '..', 'samples', 'eval-emotion.jsonl')

/** 判定用的死区：|valence| 小于这个算"中性" */
export const DEADZONE = 0.15

export function signOf(v) {
  if (Math.abs(v) < DEADZONE) return 0
  return v > 0 ? 1 : -1
}

/** 读数据集（跳过空行与注释行） */
export function loadCases(file = DEFAULT_FILE) {
  const raw = readFileSync(file, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('//') || s.startsWith('#')) continue
    const j = JSON.parse(s)
    if (typeof j.text !== 'string' || typeof j.valence !== 'number') continue
    out.push({
      text: j.text,
      expected: Math.max(-1, Math.min(1, j.valence)),
      hard: j.hard === true,
      note: j.note || '',
    })
  }
  return out
}

/** 跑一遍，返回数字（纯函数，供测试复用） */
export function runEval(cases = loadCases()) {
  const rows = cases.map((c) => {
    const r = lexiconValence(c.text)
    const got = signOf(r.valence)
    const want = signOf(c.expected)
    // got 是**符号**（-1/0/1），raw 才是原始效价——混淆矩阵要靠 got 对上
    return { ...c, got, raw: r.valence, arousal: r.arousal, want, ok: got === want, absErr: Math.abs(r.valence - c.expected) }
  })

  const of = (arr) => {
    const n = arr.length || 1
    const correct = arr.filter((r) => r.ok).length
    const mae = arr.reduce((s, r) => s + r.absErr, 0) / n
    return { n: arr.length, correct, acc: correct / n, mae }
  }

  // 混淆矩阵：want → got
  const labels = [-1, 0, 1]
  const matrix = {}
  for (const w of labels) {
    matrix[w] = {}
    for (const g of labels) matrix[w][g] = rows.filter((r) => r.want === w && r.got === g).length
  }

  // 每类 P/R/F1（macro）
  const perClass = {}
  for (const k of labels) {
    const tp = rows.filter((r) => r.want === k && r.got === k).length
    const fp = rows.filter((r) => r.want !== k && r.got === k).length
    const fn = rows.filter((r) => r.want === k && r.got !== k).length
    const p = tp + fp ? tp / (tp + fp) : 0
    const rec = tp + fn ? tp / (tp + fn) : 0
    perClass[k] = { p, r: rec, f1: p + rec ? (2 * p * rec) / (p + rec) : 0, support: tp + fn }
  }
  const macroF1 = labels.reduce((s, k) => s + perClass[k].f1, 0) / labels.length

  return {
    all: of(rows),
    easy: of(rows.filter((r) => !r.hard)),
    hard: of(rows.filter((r) => r.hard)),
    byBucket: {
      neg: of(rows.filter((r) => r.want === -1)),
      neu: of(rows.filter((r) => r.want === 0)),
      pos: of(rows.filter((r) => r.want === 1)),
    },
    matrix,
    perClass,
    macroF1,
    wrong: rows.filter((r) => !r.ok),
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`

function main() {
  const argv = process.argv.slice(2)
  const flag = (name, dflt) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : dflt
  }
  const file = flag('--file', DEFAULT_FILE)
  const wrongLimit = Number(flag('--wrong', 30))
  const r = runEval(loadCases(file))

  if (argv.includes('--json')) {
    const { wrong, ...rest } = r
    console.log(JSON.stringify({ ...rest, file }, null, 2))
    return
  }

  console.log(`情绪词典基线 · ${file}`)
  console.log(`  样本 ${r.all.n} 条（easy ${r.easy.n} / hard ${r.hard.n}）· 死区 |v|<${DEADZONE}`)
  console.log('')
  console.log(`  三分类准确率   ${pct(r.all.acc)}   （easy ${pct(r.easy.acc)} · hard ${pct(r.hard.acc)}）`)
  console.log(`  macro F1       ${r.macroF1.toFixed(3)}`)
  console.log(`  MAE            ${r.all.mae.toFixed(3)}`)
  console.log('')
  console.log('  分桶：')
  for (const [k, v] of Object.entries(r.byBucket)) {
    console.log(`    ${k.padEnd(4)} n=${String(v.n).padStart(2)}  准确 ${pct(v.acc).padStart(6)}  MAE ${v.mae.toFixed(2)}`)
  }
  console.log('')
  console.log('  混淆矩阵（行=标注，列=判定）：')
  console.log('          判负   判中   判正')
  for (const w of [-1, 0, 1]) {
    const name = w === -1 ? '标负' : w === 0 ? '标中' : '标正'
    const m = r.matrix[w]
    console.log(`    ${name}  ${String(m[-1]).padStart(4)}   ${String(m[0]).padStart(4)}   ${String(m[1]).padStart(4)}`)
  }
  console.log('')
  const w = r.wrong.slice(0, wrongLimit)
  console.log(`  错例 ${r.wrong.length} 条${w.length < r.wrong.length ? `（列前 ${w.length}）` : ''}：`)
  for (const x of w) {
    console.log(`    [${x.hard ? 'hard' : 'easy'}] 标${x.want > 0 ? '+' : x.want < 0 ? '−' : '0'} 得${x.got.toFixed(2)}  ${x.text}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('eval-emotion.mjs')) main()
