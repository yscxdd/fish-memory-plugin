// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * rank.js — 检索权重的**唯一合成处**（v0.50.0）。
 *
 * 为什么要抽出来：这段链以前写在 `index.js` 的 `weight:` 闭包里，
 * 于是"时间窗有没有生效""注意力有没有生效"只能靠肉眼看代码——
 * 离线金标（`goldset.runHard`）也复现不出同一套权重，测出来的数字和线上不是一回事。
 *
 * 现在两边都调这一个函数：线上跑的是它，难题组测的也是它。
 *
 * 合成顺序（乘性，任何一项为 1 就等于没开）：
 *   记忆强度（遗忘曲线，`store.memoryWeight`）
 *   × 时间意图（问过去偏过去，`timeWeight`）
 *   × 时间窗（"上周三"的窗内 ×1.25、窗外 ×0.8，`rangeWeight`）
 *   × 注意力（有压力时危机 ×3、日常 ×0.1，`attentionMultiplier`）
 */

import { attentionMultiplier, classifyAttention } from './attention.js'
import { rangeWeight, timeWeight } from './time.js'

/**
 * @param {object} point 记忆点（要有 date / cluster / tags）
 * @param {{intent?:string|null, range?:object|null, stress?:boolean, memoryWeight?:number}} ctx
 * @returns {number} 权重乘数
 */
export function retrievalWeight(point, { intent = null, range = null, stress = false, memoryWeight = 1 } = {}) {
  return (
    (Number(memoryWeight) || 1) *
    timeWeight(point, intent) *
    rangeWeight(point, range) *
    attentionMultiplier(classifyAttention(point), { stress: Boolean(stress) })
  )
}
