// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * goldset.js — 金标召回集（20 条改写查询 + 6 条负例）与 A/B 跑分器。
 *
 * 为什么单独成模块：这套查询既是**回归闸门**（`node --test`），也是**调参的尺子**
 * （`memory gold --ab`）。两处用同一份数据，才不会出现"测试里 8/10、真库里另一回事"。
 *
 * 四条自我约束：
 *   1. 点都是合成的（`fixture` 语义），不对应任何真实记忆；
 *   2. 查询必须"改写"过——不复用点的标题/标签原文，否则量到的是字面匹配；
 *   3. 只断言下限，不断言排名顺序——顺序会随权重变，下限不变；
 *   4. 负例和正例一样重要：只提召回率的调参会把阈值调成"什么都命中"。
 *
 * 覆盖的召回路径：标题命中 / 标签命中 / 别名命中（并进 tags）/ 同簇干扰 /
 * 只有 summary 命中的弱信号 / 高显著度但不该赢的干扰项 / 两处同词但答案唯一。
 *
 * 缺口（写下来，免得以为它很全）：没有指代（"那个"、"上次那个"）、没有跨会话时序
 * （"上周三"）、没有否定句（"我不讨厌香菜"）、没有多语言混写。这四类要等真实语料。
 */

import { rankHybrid } from './retrieve.js'
import { makeIdf } from './idf.js'

const P = (id, title, { tags = [], aliases = [], cluster = '日常', salience = 3, date = '2026-10-20', summary = '' } = {}) => ({
  id,
  title,
  tags,
  aliases,
  cluster,
  salience,
  date,
  summary,
})

/** 20 条合成点：一条对应一条查询，另有若干同簇干扰项 */
export const GOLD_POINTS = [
  P('M1', '台风天看海', { tags: ['台风'], aliases: ['海边', '看海'], cluster: '出行', salience: 4, summary: '台风夜去海边。' }),
  P('M2', '他讨厌香菜', { tags: ['香菜', '忌口'], aliases: ['芹菜'], cluster: '偏好' }),
  P('M3', '别夸她懂事', { tags: ['懂事', '底线'], aliases: ['夸奖'], cluster: '她的偏好', salience: 5 }),
  P('M4', '他嫌麻辣烫贵', { tags: ['麻辣烫', '价格'], aliases: ['火锅'], cluster: '吃喝' }),
  P('M5', '他在成都', { tags: ['成都'], aliases: ['城市'], cluster: '关于他' }),
  P('M6', '用 ffmpeg 转码', { tags: ['转码'], aliases: ['格式转换', '视频压缩'], cluster: '工具' }),
  P('M7', '周末去那家店', { tags: ['周末', '那家店'], aliases: ['约定'], cluster: '约定', salience: 4 }),
  P('M8', '吵架那天他没在听', { tags: ['吵架'], aliases: ['没在听', '冷战'], cluster: '冲突', salience: 4 }),
  P('M9', '楼下那家面', { tags: ['吃饭'], aliases: ['面', '面条'], cluster: '日常', salience: 2 }),
  P('M10', '她怕打雷', { tags: ['打雷'], aliases: ['雷声'], cluster: '她的偏好', salience: 4 }),
  // ── 以下 10 条是扩充的干扰/近义项：不是更难的字面，是同话题里"容易赢错"的那条 ──
  P('M11', '他老家在潮汕', { tags: ['老家'], aliases: ['家乡', '籍贯'], cluster: '关于他' }),
  P('M12', '过生日她不想被祝福', { tags: ['生日', '祝福'], aliases: ['生日蛋糕'], cluster: '她的偏好', salience: 4 }),
  P('M13', '下雨天他膝盖疼', { tags: ['下雨', '膝盖'], cluster: '日常' }),
  P('M14', '公司搬去城东', { tags: ['公司', '搬家'], aliases: ['办公室'], cluster: '工作' }),
  P('M15', '他答应不半夜打游戏', { tags: ['游戏', '承诺'], aliases: ['熬夜'], cluster: '约定', salience: 4 }),
  P('M16', '第一次见面在书店', { tags: ['书店', '见面'], cluster: '回忆', salience: 5 }),
  // 无标签的一条：只有 summary 说得清。默认 summary 权重低，这里就是金标的已知短处。
  P('M17', '那阵子的固定安排', { cluster: '日常', salience: 2, summary: '每天下午三点喝咖啡，雷打不动。' }),
  P('M18', '她哭了那次', { tags: ['哭'], cluster: '冲突', salience: 4, summary: '因为我提起他爸，她哭了。' }),
  P('M19', '他讨厌被叫小名', { tags: ['小名'], aliases: ['绰号'], cluster: '偏好', salience: 4 }),
  P('M20', '台风把窗户吹坏', { tags: ['台风', '窗户'], cluster: '家', salience: 4, summary: '去年台风天窗户被吹坏。' }),
]

/** 20 条改写查询：`[查询, 期望的 top-1 id]` */
export const GOLD_QUERIES = [
  ['海边那件事', 'M1'],
  ['我对什么忌口', 'M2'],
  ['她不喜欢被说懂事', 'M3'],
  ['上次说火锅贵', 'M4'],
  ['我们在哪个城市', 'M5'],
  ['视频压缩怎么做', 'M6'],
  ['周末那个约定', 'M7'],
  ['冷战那次', 'M8'],
  ['面条', 'M9'],
  ['她怕雷声吗', 'M10'],
  ['他老家是哪的', 'M11'],
  ['她生日那天怎么过的', 'M12'],
  ['下雨他膝盖就疼', 'M13'],
  ['公司搬哪去了', 'M14'],
  ['他答应过不再熬夜', 'M15'],
  ['我们第一次见面在哪', 'M16'],
  ['每天下午几点喝咖啡', 'M17'],
  ['因为我提起他爸', 'M18'],
  ['他讨厌被叫绰号', 'M19'],
  ['台风把窗户吹坏了', 'M20'],
]

/**
 * 负例：库里没有任何一条该被想起来。
 * 只测正例的调参会把阈值越调越低，所以这 6 条必须**零命中**。
 */
export const GOLD_NEGATIVES = ['今天股票涨了吗', 'docker 怎么装', '明天几点开会', '帮我写个爬虫', '天气如何', '这道题怎么做']

/**
 * A/B 候选权重。
 * 键跟 `retrieval.weights` 一致：title / tags(含 aliases) / cluster / summary / unigram(单字兜底系数)。
 * 这些是**假设**，不是结论——真库跑过才敢定默认。
 */
export const WEIGHT_SETS = {
  default: { title: 3, tags: 3, cluster: 1, summary: 1, unigram: 0.5 },
  titleHeavy: { title: 5, tags: 2, cluster: 1, summary: 1, unigram: 0.5 },
  tagsHeavy: { title: 2, tags: 5, cluster: 1, summary: 1, unigram: 0.5 },
  summaryHeavy: { title: 3, tags: 3, cluster: 1, summary: 3, unigram: 0.5 },
  noCluster: { title: 3, tags: 3, cluster: 0, summary: 1, unigram: 0.5 },
}

/** 金标下限：20 条里至少 16 条 top-1 命中（80%，和契约 §12 第 4 项同口径） */
export const GOLD_FLOOR = 0.8

/**
 * 跑一遍金标。
 *
 * 默认值 = **插件默认值**（rebalance 开、IDF 关），这样 `memory gold` 量的就是
 * 她现在真跑的那套打分，而不是一个只在测试里存在的配置。
 *
 * `useIdf: true` 时用**这一份金标自己的语料**算 IDF——只用来量"IDF 有没有用"；
 * 真库里 IDF 来自 `store.idf()`（全库统计）。
 *
 * @param {{points?:object[], queries?:Array<[string,string]>, negatives?:string[],
 *          threshold?:number, limit?:number, weights?:object, useIdf?:boolean,
 *          rebalance?:boolean, idfMode?:'min'|'query'}} [opts]
 * @returns {{total:number, hits:number, rate:number, ok:boolean, rows:object[],
 *            misses:string[], falsePositives:string[], margin:number, useIdf:boolean,
 *            rebalance:boolean, idfMode:string}}
 */
export function runGold({
  points = GOLD_POINTS,
  queries = GOLD_QUERIES,
  negatives = GOLD_NEGATIVES,
  threshold = 0.8,
  limit = 3,
  weights,
  useIdf = false,
  rebalance = true,
  idfMode = 'min',
} = {}) {
  const idf = useIdf ? makeIdf(points) : undefined
  const opts = { threshold, limit, weights, idf, rebalance, idfMode }
  const rows = []
  const misses = []
  let hits = 0
  let margin = Infinity
  for (const [query, expect] of queries) {
    const top = rankHybrid(points, query, opts)
    const got = top[0]?.point.id ?? null
    const ok = got === expect
    if (ok) hits += 1
    else misses.push(`${query} → ${got ?? '空'}（期望 ${expect}）`)
    // 边际：top-1 领先第二名的分差。饱和的金标只能靠它看"有多稳"。
    if (top.length >= 2) margin = Math.min(margin, top[0].score - top[1].score)
    rows.push({ query, expect, got, score: top[0] ? +top[0].score.toFixed(2) : 0, ok })
  }
  const falsePositives = negatives.filter((q) => rankHybrid(points, q, opts).length > 0)
  const total = queries.length
  const rate = total ? hits / total : 0
  return {
    total,
    hits,
    rate,
    ok: rate >= GOLD_FLOOR && falsePositives.length === 0,
    rows,
    misses,
    falsePositives,
    margin: Number.isFinite(margin) ? +margin.toFixed(2) : null,
    useIdf,
    rebalance,
    idfMode,
  }
}

/**
 * A/B 的对照组：权重 × IDF × 稀疏补权。
 *
 * 为什么把 `idf`/`rebalance` 都放进来：v0.5.12 加的两项都是**打分逻辑的替换**，
 * 不是新参数——必须能和"不开"直接比，否则说不清它到底值不值。
 */
export const AB_VARIANTS = [
  { name: 'default', weights: WEIGHT_SETS.default },
  { name: 'no-rebalance', weights: WEIGHT_SETS.default, rebalance: false },
  { name: 'default+idf', weights: WEIGHT_SETS.default, useIdf: true },
  { name: 'idf(query)', weights: WEIGHT_SETS.default, useIdf: true, idfMode: 'query' },
  { name: 'titleHeavy', weights: WEIGHT_SETS.titleHeavy },
  { name: 'tagsHeavy', weights: WEIGHT_SETS.tagsHeavy },
  { name: 'summaryHeavy', weights: WEIGHT_SETS.summaryHeavy },
  { name: 'noCluster', weights: WEIGHT_SETS.noCluster },
]

/**
 * A/B：同一份金标跑多组权重/开关，返回每组命中数、相对默认值的差、误命中与边际。
 *
 * @param {{variants?:Array<{name:string, weights:object, useIdf?:boolean, rebalance?:boolean, idfMode?:string}>, threshold?:number}} [opts]
 */
export function abGold({ variants = AB_VARIANTS, threshold = 0.8 } = {}) {
  const baseRun = runGold({ weights: WEIGHT_SETS.default, threshold })
  const results = []
  for (const variant of variants) {
    const r = runGold({
      weights: variant.weights,
      useIdf: Boolean(variant.useIdf),
      rebalance: variant.rebalance !== false,
      idfMode: variant.idfMode || 'min',
      threshold,
    })
    results.push({
      name: variant.name,
      weights: variant.weights,
      useIdf: Boolean(variant.useIdf),
      rebalance: variant.rebalance !== false,
      idfMode: variant.idfMode || 'min',
      hits: r.hits,
      total: r.total,
      rate: r.rate,
      delta: r.hits - baseRun.hits,
      margin: r.margin,
      falsePositives: r.falsePositives,
      misses: r.misses,
    })
  }
  return { base: baseRun.hits, total: baseRun.total, baseFalsePositives: baseRun.falsePositives, results }
}
