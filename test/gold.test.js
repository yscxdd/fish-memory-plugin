// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 金标召回 + 打分开关（契约 §12 第 4 项、§9 配置项）。
 *
 * 这一组测的是**打分接口**，不是"我觉得哪组权重更好"：
 *   - 插件默认配置下，金标 ≥ 下限，负例零命中；
 *   - 开关真的会改变结果（关掉稀疏补权必须掉分，否则等于没接上）；
 *   - IDF 量不出增益就**默认关**，并由测试把这个结论钉住；
 *   - 权重缺键/全 0/非法值都有明确归宿（补默认 / 拒绝 / 丢）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  abGold,
  GOLD_FLOOR,
  GOLD_NEGATIVES,
  GOLD_POINTS,
  GOLD_QUERIES,
  runGold,
  WEIGHT_SETS,
} from '../lib/goldset.js'
import { DEFAULT_WEIGHTS, mergeWeights, overlap, rankHybrid, rebalanceWeights, weightedOverlap } from '../lib/retrieve.js'
import { makeIdf } from '../lib/idf.js'
import { normalizeConfig } from '../lib/config.js'

test('金标（插件默认打分：rebalance 开、idf 关）：20 条里 ≥19，且 6 条负例零命中', () => {
  const r = runGold()
  assert.equal(r.total, 20)
  assert.equal(r.rebalance, true, '默认要开稀疏补权')
  assert.equal(r.useIdf, false, '默认不开 IDF（量过零增益）')
  assert.equal(r.falsePositives.length, 0, `负例不该命中：${r.falsePositives.join('、')}`)
  assert.ok(r.hits >= 19, `命中 ${r.hits}/20；未命中：${r.misses.join('；')}`)
  assert.equal(r.ok, true)
})

test('稀疏补权真的有用：关掉它，没标签那条就死（20/20 → 19/20，边际 0.68 → 0.38）', () => {
  const on = runGold()
  const off = runGold({ rebalance: false })
  assert.equal(off.rows.find((r) => r.expect === 'M17').ok, false, '关掉后 M17（没有 tags）应打不中')
  assert.equal(on.rows.find((r) => r.expect === 'M17').ok, true, '打开后应打中')
  assert.ok(on.hits > off.hits, 'A/B 要能量出差别，否则等于没接上')
  assert.ok(on.margin > off.margin, `边际应更好：${on.margin} vs ${off.margin}`)
})

test('IDF：金标量不出增益，所以默认关（有证据才开，别凭直觉开）', () => {
  const base = runGold()
  const withIdf = runGold({ useIdf: true })
  const querySide = runGold({ useIdf: true, idfMode: 'query' })
  for (const r of [withIdf, querySide]) {
    assert.ok(r.hits >= base.hits, 'IDF 不许把命中弄差')
    assert.equal(r.falsePositives.length, 0, 'IDF 不许制造误命中')
  }
  // 记录结论而不是断言"更好"：这套金标区分不出 IDF 的收益
  assert.ok(withIdf.margin <= base.margin + 0.01, '真出现明显增益时，才回头改默认值')
})

test('金标：默认权重就是 retrieve.js 的 DEFAULT_WEIGHTS（不许两处各写一份）', () => {
  assert.deepEqual(WEIGHT_SETS.default, { ...DEFAULT_WEIGHTS })
  const same = runGold({ weights: DEFAULT_WEIGHTS })
  assert.equal(same.hits, runGold().hits)
})

test('权重真的生效：summary 权重提到 3 在"关掉补权"时能救回只在摘要里的那条', () => {
  const base = runGold({ rebalance: false })
  const heavy = runGold({ weights: WEIGHT_SETS.summaryHeavy, rebalance: false })
  assert.equal(base.rows.find((r) => r.expect === 'M17').ok, false, '关补权 + 默认权重：这条应打不中')
  assert.equal(heavy.rows.find((r) => r.expect === 'M17').ok, true, 'summary 提到 3 应能打中')
  assert.ok(heavy.hits > base.hits, 'A/B 要能量出差别，否则权重等于没接上')
})

test('权重真的生效：title 权重提到 5 会输给标题里共用「那次」的干扰项', () => {
  const heavy = runGold({ weights: WEIGHT_SETS.titleHeavy })
  const row = heavy.rows.find((r) => r.expect === 'M8')
  assert.equal(row.ok, false)
  assert.equal(row.got, 'M18')
  assert.ok(heavy.hits < runGold().hits, '单一字段权重过高应该掉分，不该只涨不跌')
})

test('A/B：每组都报命中数、边际与负例，不允许静默通过', () => {
  const ab = abGold()
  assert.equal(ab.total, 20)
  assert.ok(ab.results.length >= 6, '对照组太少就看不出差别')
  for (const s of ab.results) {
    assert.equal(typeof s.hits, 'number')
    assert.ok(s.margin === null || s.margin > 0, `${s.name} 的边际应为正`)
    assert.ok(Array.isArray(s.falsePositives))
    assert.equal(s.falsePositives.length, 0, `${s.name} 不该误命中负例`)
    assert.equal(typeof s.rebalance, 'boolean', '每组都要标出有没有开补权')
  }
  // 边际 = top-1 与第二名的分差；饱和的金标只能靠它看稳不稳
  assert.ok(ab.results.find((s) => s.name === 'default').margin > 0)
  // 关补权那一组必须真的掉分，否则说明对照组是摆设
  assert.equal(ab.results.find((s) => s.name === 'no-rebalance').delta, -1)
})

test('mergeWeights：缺的键补默认，非法值丢掉，全 0 退回默认', () => {
  assert.deepEqual(mergeWeights(undefined), { ...DEFAULT_WEIGHTS })
  assert.deepEqual(mergeWeights({}), { ...DEFAULT_WEIGHTS })
  assert.deepEqual(mergeWeights({ tags: 7 }), { ...DEFAULT_WEIGHTS, tags: 7 })
  assert.deepEqual(mergeWeights({ tags: 'x', title: -1 }), { ...DEFAULT_WEIGHTS })
  assert.deepEqual(mergeWeights({ title: 0, tags: 0, cluster: 0, summary: 0 }), { ...DEFAULT_WEIGHTS })
  // 只把一处调成 0 是合法的：明确要关掉某个字段
  assert.equal(mergeWeights({ cluster: 0 }).cluster, 0)
})

test('单字兜底不能单独把一条点抬过门槛（长查询只共用一个常见字）', () => {
  const noise = { id: 'N', title: '下雨天他膝盖疼', tags: ['下雨', '膝盖'], cluster: '日常', salience: 3, summary: '', aliases: [] }
  const empty = { id: 'E', title: '那阵子的固定安排', tags: [], cluster: '日常', salience: 2, summary: '每天下午三点喝咖啡。', aliases: [] }
  // 「天」是两边都有的常见字，二字组一个都不重合
  const top = rankHybrid([noise, empty], '每天下午几点喝咖啡', { threshold: 0.8 })
  assert.deepEqual(top, [], '不该靠单字凑够 0.8')
  // 短查询仍走兜底：单字查询要能命中
  const short = rankHybrid([noise], '膝盖', { threshold: 0.8 })
  assert.equal(short[0]?.point.id, 'N')
})

test('IDF 加权重合率：均匀 IDF 时**精确等于** overlap（所以开关不改量纲）', () => {
  const q = new Set(['香菜', '菜的', '的味'])
  const p = new Set(['香菜', '菜的', '好吃'])
  const uniform = (g) => 2.5 // 常数
  assert.equal(weightedOverlap(q, p, uniform), overlap(q, p))
  // 缺省 idf 也走同一条快路径
  assert.equal(weightedOverlap(q, p), overlap(q, p))
})

test('IDF：罕见二字组比常见二字组值钱（这就是它存在的理由）', () => {
  const points = [
    { title: '台风天看海', tags: ['台风'], cluster: '出行', summary: '' },
    { title: '台风把窗户吹坏', tags: ['台风'], cluster: '家', summary: '' },
    { title: '他讨厌香菜', tags: ['香菜'], cluster: '偏好', summary: '' },
  ]
  const idf = makeIdf(points)
  assert.equal(idf.n, 3)
  assert.ok(idf('台风') < idf('香菜'), `常见词应更轻：台风=${idf('台风').toFixed(2)} 香菜=${idf('香菜').toFixed(2)}`)
  // 空库退化成恒等 1，不会把检索压成零分
  assert.equal(makeIdf([])('随便'), 1)
  assert.ok(idf('从没出现的词') > idf('香菜'), '没出现过的二字组（df=0）权重最高，这没问题——它也不会被命中')
})

test('稀疏补权：没 tags 的点把那份权重按比例挪给 title/summary，四个字段都在时原样返回', () => {
  const w = { ...DEFAULT_WEIGHTS }
  const full = { title: '有标题', tags: ['标签'], cluster: '日常', summary: '有摘要' }
  assert.equal(rebalanceWeights(full, w), w, '四个字段都在：不分配新对象')

  const noTags = { title: '那阵子的固定安排', tags: [], cluster: '日常', summary: '每天下午三点喝咖啡。' }
  const out = rebalanceWeights(noTags, w)
  assert.equal(out.tags, 0)
  const total = out.title + out.tags + out.cluster + out.summary
  assert.equal(+total.toFixed(6), +(w.title + w.tags + w.cluster + w.summary).toFixed(6), '总权重不增不减')
  assert.ok(out.summary > w.summary, '摘要该拿到更多权重（它的内容都在摘要里）')

  // 一个字段都没有：原样返回，别把权重全清零
  const empty = { title: '', tags: [], cluster: '', summary: '' }
  assert.equal(rebalanceWeights(empty, w), w)
})

test('配置：retrieval.rebalance / idf 只收布尔，idfMode 只收两个值', () => {
  const lines = []
  const cfg = normalizeConfig(
    { retrieval: { rebalance: false, idf: 'yes', idfMode: 'cosine' } },
    { warn: (m) => lines.push(String(m)) },
  )
  assert.equal(cfg.retrieval.rebalance, false)
  assert.equal(cfg.retrieval.idf, undefined, '字符串不是布尔，必须丢掉')
  assert.equal(cfg.retrieval.idfMode, undefined, '不认得的枚举值必须丢掉')
  const joined = lines.join('\n')
  assert.match(joined, /rebalance|idf/)
  assert.match(joined, /idfMode/)

  const ok = normalizeConfig({ retrieval: { idf: true, idfMode: 'query' } })
  assert.equal(ok.retrieval.idf, true)
  assert.equal(ok.retrieval.idfMode, 'query')
})

test('配置：retrieval.weights 越界 clamp、拼错告警、全 0 拒绝', () => {
  const lines = []
  const logger = { warn: (m) => lines.push(String(m)) }
  const cfg = normalizeConfig(
    { retrieval: { weights: { title: 99, tags: 4, sumary: 2 } } },
    logger,
  )
  assert.equal(cfg.retrieval.weights.title, 10, '上限 clamp 到 10')
  assert.equal(cfg.retrieval.weights.tags, 4)
  assert.equal(cfg.retrieval.weights.sumary, undefined, '拼错的键不进配置')
  assert.match(lines.join('\n'), /sumary/, '拼错的键要告警')

  const zeroLines = []
  const zero = normalizeConfig(
    { retrieval: { weights: { title: 0, tags: 0, cluster: 0, summary: 0 } } },
    { warn: (m) => zeroLines.push(String(m)) },
  )
  assert.equal(zero.retrieval.weights, undefined, '全 0 等于关掉检索，必须拒绝')
  assert.match(zeroLines.join('\n'), /全是 0/)

  // 只关一个字段是合法的，不该被拒
  const partial = normalizeConfig({ retrieval: { weights: { cluster: 0 } } })
  assert.deepEqual(partial.retrieval.weights, { cluster: 0 })
})

test('金标用的是合成点，不许混进真实记忆（fixture 纪律）', () => {
  for (const p of GOLD_POINTS) {
    assert.match(p.id, /^M\d+$/, '金标点 ID 用 M1..M20，和真实记忆点 M-YYYY-MM-DD-NNN 区分开')
    assert.equal(p.source, undefined, '金标点没有 source：它不是真档案里的事')
    assert.equal(p.status, undefined, '金标点不是 active 记忆点，不该被注入')
  }
  assert.equal(GOLD_QUERIES.length, GOLD_POINTS.length, '一条点对一条查询')
  assert.ok(GOLD_NEGATIVES.length >= 3, '负例少于 3 条就看不出阈值放松的代价')
})
