// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * idf.js — 二字组的区分度权重（IDF），零依赖。
 *
 * 为什么需要：现在的 `overlap` 把所有二字组当等价。于是
 *   「那天 / 什么 / 我们 / 一个」 和 「香菜 / 冷战 / 城东」 权重相同，
 * 一条只是措辞相近的点，能靠几个虚词二字组把分数顶上去。
 * IDF 的作用就是把"几乎每条都有的二字组"压下去、"只有这一条有的"抬起来。
 *
 * 公式用 Lucene 的 BM25 IDF（恒正，不会出现负分）：
 *   idf(g) = ln(1 + (N - df(g) + 0.5) / (df(g) + 0.5))
 * N = 库里点数，df = 含该二字组的点数。参考：BM25 的标准实现，以及零依赖 JS 版
 * 中文实现（字符二元组分词 + 同一个 idf 式）。
 *
 * 关键设计：**不引入新的打分公式，只把 overlap 里的"计数"换成"权重和"**：
 *   overlap    = |Q∩P| / min(|Q|,|P|)
 *   idfOverlap = Σ_{g∈Q∩P} idf(g) / min(Σ_{g∈Q} idf(g), Σ_{g∈P} idf(g))
 * 当 idf 恒为常数时两式**恒等**（test/gold.test.js 钉住）。所以开不开它
 * 都不改变量纲、不用重调阈值 0.8，只改变"哪些命中更值钱"。
 *
 * 依赖方向：本文件 import retrieve.js 的 bigrams；retrieve.js **不** import 本文件
 * （它只收一个 `idf` 函数参数）——避免循环依赖。
 */

import { bigrams } from './retrieve.js'

/** 一条点参与统计的字段（与打分用的字段一致，别多别少） */
function gramsOf(point) {
  return [
    ...bigrams(point.title || ''),
    ...bigrams((point.tags || []).join('')),
    ...bigrams((point.aliases || []).join('')),
    ...bigrams(point.cluster || ''),
    ...bigrams(point.summary || ''),
  ]
}

/** 每一条点贡献哪些二字组（去重后） */
export function documentBigrams(points = []) {
  return points.map((p) => new Set(gramsOf(p)))
}

/**
 * 建一份 IDF 查询函数。
 * 空库返回恒定权重 1（与现有行为一致，不会把检索压成零分）。
 *
 * @param {object[]} points 参与统计的点（只该是 active 的）
 * @returns {((gram:string)=>number) & {n:number, df:Map<string,number>}}
 */
export function makeIdf(points = []) {
  const df = new Map()
  for (const grams of documentBigrams(points)) {
    for (const g of grams) df.set(g, (df.get(g) || 0) + 1)
  }
  const n = points.length
  const memo = new Map()

  const idf = (gram) => {
    const hit = memo.get(gram)
    if (hit !== undefined) return hit
    const d = df.get(gram) || 0
    // 空库：没有统计意义，权重取 1，退化成普通 overlap
    const v = n === 0 ? 1 : Math.log(1 + (n - d + 0.5) / (d + 0.5))
    memo.set(gram, v)
    return v
  }
  idf.n = n
  idf.df = df
  return idf
}
