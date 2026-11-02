// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 情绪词典的评测基线（v0.32.0）——把"准不准"变成一个数字，并钉住它不倒退。
 *
 * 为什么要有这个文件：我们以前只有"结构测试"（情绪行能不能渲染、状态机转不转），
 * 没有"判断对不对"。一个只会输出 0 的词典也能让所有结构测试通过。
 *
 * 基线（2026-11-03，62 条人工标注）：
 *   三分类 83.9% · easy 100% · hard 50% · macro F1 0.502 · MAE 0.361
 *
 * **标注是主观的**：这份样本是我按"人读到这句话会怎么感觉"打的，不是金标准；
 * 而且调词典时用过它一次，所以这个数偏乐观。hard 档（反讽/否定/转述/混合）才是重点。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEADZONE, loadCases, runEval, signOf } from '../scripts/eval-emotion.mjs'

const FLOOR = {
  all: 0.8, // 整体不能低于 80%
  easy: 0.95, // 明显该对的几乎不能错
  hard: 0.45, // 反讽/否定/转述：现在就这个水平，别再掉
  mae: 0.4, // 平均绝对误差上限
}

test('数据集本身：至少 60 条，三档都有，easy/hard 都在', () => {
  const cases = loadCases()
  assert.ok(cases.length >= 60, `样本太少：${cases.length}`)
  assert.ok(cases.filter((c) => c.expected > 0).length >= 15, '正例太少')
  assert.ok(cases.filter((c) => c.expected < 0).length >= 15, '负例太少')
  assert.ok(cases.filter((c) => c.expected === 0).length >= 12, '中性太少')
  assert.ok(cases.filter((c) => c.hard).length >= 15, 'hard 太少')
  assert.ok(cases.filter((c) => !c.hard).length >= 30, 'easy 太少')
})

test('signOf 的死区：|v|<0.15 算中性', () => {
  assert.equal(signOf(0), 0)
  assert.equal(signOf(0.14), 0)
  assert.equal(signOf(-0.14), 0)
  assert.equal(signOf(DEADZONE), 1)
  assert.equal(signOf(-0.6), -1)
})

test('基线不倒退：整体 / easy / hard / MAE 都在地板上方', () => {
  const r = runEval()
  assert.ok(r.all.acc >= FLOOR.all, `整体准确率 ${(r.all.acc * 100).toFixed(1)}% < ${FLOOR.all * 100}%`)
  assert.ok(r.easy.acc >= FLOOR.easy, `easy 准确率 ${(r.easy.acc * 100).toFixed(1)}% < ${FLOOR.easy * 100}%`)
  assert.ok(r.hard.acc >= FLOOR.hard, `hard 准确率 ${(r.hard.acc * 100).toFixed(1)}% < ${FLOOR.hard * 100}%`)
  assert.ok(r.all.mae <= FLOOR.mae, `MAE ${r.all.mae.toFixed(3)} > ${FLOOR.mae}`)
})

test('混淆矩阵与分桶自洽（不漏样本）', () => {
  const r = runEval()
  const inMatrix = [-1, 0, 1].reduce((s, w) => s + [-1, 0, 1].reduce((t, g) => t + r.matrix[w][g], 0), 0)
  assert.equal(inMatrix, r.all.n)
  assert.equal(r.easy.n + r.hard.n, r.all.n)
  assert.equal(r.byBucket.neg.n + r.byBucket.neu.n + r.byBucket.pos.n, r.all.n)
})

test('错例清单和准确率对得上（错了就是错了，不许瞒）', () => {
  const r = runEval()
  assert.equal(r.wrong.length, r.all.n - r.all.correct)
  assert.ok(r.wrong.length > 0, '一份 100% 全对的样本多半是样本太容易')
})
