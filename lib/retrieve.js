// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * retrieve.js — 检索：归一化 / 二字组 / 打分 / 门控 / 事件簇。
 *
 * 修正记录（契约 §14 第 4 条）：
 *   - overlap 除以 min(|Q|,|P|)，不除以 |Q|（否则长句搜不到强相关记忆）
 *   - 去掉 /8 的总权重归一（只命中标题/标签也应算数）
 *   - 阈值 0.30 → 0.80
 * 这三条都是实测结论，不是设计稿的原始写法。
 */

/** 归一化：全角转半角、小写、只留中文/字母/数字（契约 §3.2） */
export function normalize(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, '')
}

/** 二字组（契约 §3.3） */
export function bigrams(s) {
  const t = normalize(s)
  if (t.length <= 1) return new Set(t ? [t] : [])
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 重合率：除以较小集合（契约 §14 修正） */
export function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const g of a) if (b.has(g)) n++
  return n / Math.min(a.size, b.size)
}

/**
 * IDF 加权重合率（v0.5.12）。把 overlap 里的"命中个数"换成"命中权重和"：
 *
 *   mode='min'（默认）  Σ_{g∈Q∩P} idf(g) / min(Σ_{g∈Q} idf, Σ_{g∈P} idf)
 *   mode='query'        Σ_{g∈Q∩P} idf(g) / Σ_{g∈Q} idf
 *
 * 'min' 保持 §14 那条修正（长查询不稀释），代价是"只由一个常见二字组构成的短字段"
 * 会归一化到 1.0——IDF 在它身上不起作用。
 * 'query' 是经典 BM25 的分母方向，靠 IDF 自己压掉虚词，长查询不再稀释。
 *
 * `idf` 缺省时一律走 overlap 快路径。
 *
 * @param {Set<string>} a 查询二字组
 * @param {Set<string>} b 字段二字组
 * @param {(g:string)=>number} [idf]
 * @param {'min'|'query'} [mode]
 */
export function weightedOverlap(a, b, idf, mode = 'min') {
  if (!a.size || !b.size) return 0
  if (!idf) return overlap(a, b)
  let matched = 0
  for (const g of a) if (b.has(g)) matched += idf(g)
  if (!matched) return 0
  let sumA = 0
  for (const g of a) sumA += idf(g)
  if (mode === 'query') return sumA > 0 ? matched / sumA : 0
  let sumB = 0
  for (const g of b) sumB += idf(g)
  const denom = Math.min(sumA, sumB)
  return denom > 0 ? matched / denom : 0
}

/** 字段是否有内容 */
function hasField(v) {
  return Boolean(v && String(v).trim())
}

/**
 * 稀疏点补权（v0.5.12）：一条点没有的字段，把它的权重挪给有的字段。
 *
 * 为什么：字段权重是"每个字段最多能贡献多少分"，但 `tags: []` 的点会白丢 3 份预算。
 * 金标里的 M17（没有标签，只有摘要）就死在这上面——它的内容全在摘要里，
 * 摘要权重只有 1，怎么算都过不了 0.8。这不是"该点不重要"，是"它没有那个字段"。
 *
 * 规则：把缺失字段的权重，按现有字段的权重比例分给它们；一个字段都没有就原样返回。
 * 只有真的缺字段时才分配新对象（有字段的常见情况零开销）。
 */
export function rebalanceWeights(point, w) {
  const present = {
    title: hasField(point.title),
    tags: (point.tags || []).length > 0,
    cluster: hasField(point.cluster),
    summary: hasField(point.summary),
  }
  const missing = ['title', 'tags', 'cluster', 'summary'].filter((k) => !present[k])
  if (!missing.length) return w
  const kept = ['title', 'tags', 'cluster', 'summary'].filter((k) => present[k])
  if (!kept.length) return w
  const freed = missing.reduce((n, k) => n + w[k], 0)
  const totalKept = kept.reduce((n, k) => n + w[k], 0)
  if (!freed || !totalKept) return w
  const out = { ...w }
  for (const k of missing) out[k] = 0
  for (const k of kept) out[k] = w[k] + (freed * w[k]) / totalKept
  return out
}
/**
 * 默认字段权重：title 3 / tags 3 / cluster 1 / summary 1 / 单字兜底 0.5（契约 §3.4）。
 *
 * 这组数一直是硬编码的常量。v0.5.9 起可被 `retrieval.weights` 覆盖，
 * 但**默认值就是这里的常量**——配置里没写，就等于这份；
 * 配置写了但全为 0（等于关掉检索），mergeWeights 会拒绝并退回这份。
 */
export const DEFAULT_WEIGHTS = Object.freeze({ title: 3, tags: 3, cluster: 1, summary: 1, unigram: 0.5 })

/**
 * 补齐权重：缺的键用默认值填，非法值丢掉。
 *
 * 为什么要有这一步：`score()` 拿到的可能是用户配置的一部分（比如只配了 `tags`），
 * 剩下的必须有人保证"非空"。**唯一保证人就是这个函数**，调用方不必自己判空。
 *
 * @param {object} [partial]
 * @returns {{title:number, tags:number, cluster:number, summary:number, unigram:number}}
 */
export function mergeWeights(partial) {
  const out = { ...DEFAULT_WEIGHTS }
  if (!partial || typeof partial !== 'object') return out
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    if (partial[key] === undefined) continue
    const n = Number(partial[key])
    if (Number.isFinite(n) && n >= 0) out[key] = n
  }
  // 四个字段权重全是 0 = 检索永远零分。这不是"调参"，是配错了，退回默认。
  if (out.title + out.tags + out.cluster + out.summary === 0) return { ...DEFAULT_WEIGHTS }
  return out
}

/**
 * 字段权重（契约 §3.4）。
 *
 * `weights` 要么不传（用默认值），要么是一份**已经 mergeWeights 补满**的对象——
 * rank / rankHybrid 在入口处补一次，循环里不再逐点补（10k 点 × 5 次判空不值得）。
 * 不要拿用户配置里的半份对象直接调它：缺的字段会算成 NaN，检索会静默全空。
 */
export function score(querySet, point, weights, idf, options = {}) {
  if (!querySet.size) return 0
  const base = weights || DEFAULT_WEIGHTS
  const w = options.rebalance ? rebalanceWeights(point, base) : base
  const mode = options.idfMode || 'min'
  // idf 缺省 = 走原公式（v0.5.12 前的老行为，测试里大量在用）
  return (
    w.title * weightedOverlap(querySet, bigrams(point.title), idf, mode) +
    w.tags * weightedOverlap(querySet, bigrams((point.tags || []).join('')), idf, mode) +
    w.cluster * weightedOverlap(querySet, bigrams(point.cluster), idf, mode) +
    w.summary * weightedOverlap(querySet, bigrams(point.summary), idf, mode)
  )
}

/** 门控：这句话值不值得检索（契约 §3.8） */
export function isGated(text) {
  const q = (text || '').trim()
  if (!q) return true
  if (/^[在嗯哦好啊哈？?…….\s]+$/.test(q)) return true
  if (!/[\u4e00-\u9fffa-z0-9]/i.test(q)) return true
  // 纯语气/应答，短且无实义
  if (q.length < 6 && /^(在吗|在不在|嗯+|哦+|好[的吧啊]?|行[的吧]?|可以|哈哈+|哈+|收到|ok)$/i.test(q)) return true
  return false
}

/** 话题未变：新查询的二字组有 >80% 能在上轮查询里找到（契约 §3.8 第 3 条） */
export function sameTopic(querySet, lastQuerySet, ratio = 0.8) {
  if (!querySet.size || !lastQuerySet.size) return false
  let n = 0
  for (const g of querySet) if (lastQuerySet.has(g)) n++
  return n / querySet.size > ratio
}

/**
 * 排序：score ↓，salience ↓，date ↓（契约 §3.6）。
 * 零命中返回空数组——不降级。
 */
export function rank(points, querySet, { threshold = 0.8, limit = 20, weight, weights, idf } = {}) {
  if (!querySet.size) return []
  return points
    .map((p) => ({ point: p, score: score(querySet, p, weights, idf) * (weight ? weight(p) : 1) }))
    .filter((x) => x.score >= threshold)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.point.salience || 0) - (a.point.salience || 0) ||
        String(b.point.date || '').localeCompare(String(a.point.date || '')),
    )
    .slice(0, limit)
}

/** 单字集合（短查询兜底） */
export function unigrams(s) {
  return new Set([...normalize(s)])
}

/**
 * 混合排序：bigram 主分 + 单字补分（权重 0.5）+ 可选强度权重 + 可选 IDF / 稀疏补权。
 * 别名 aliases 并进 tags 一起算。
 *
 * `idf` 传进来时，bigram 那部分改用 IDF 加权重合率（虚词二字组不再值钱）；
 * `rebalance` 打开时，缺字段的点把权重挪给有内容的字段（见 rebalanceWeights）。
 */
export function rankHybrid(
  points,
  text,
  { threshold = 0.8, limit = 20, weight, weights, idf, rebalance = false, idfMode = 'min' } = {},
) {
  const w = mergeWeights(weights)
  const qs = bigrams(text)
  const qu = unigrams(text)
  if (!qs.size && !qu.size) return []
  const options = { rebalance, idfMode }
  return points
    .map((p0) => {
      const p = p0.aliases?.length ? { ...p0, tags: [...(p0.tags || []), ...p0.aliases] } : p0
      const base = score(qs, p, w, idf, options)
      // 单字兜底用同一份（可能补过权的）权重，否则"没标签的点"在兜底里也白丢分
      const wp = rebalance ? rebalanceWeights(p, w) : w
      // 单字兜底的准入门槛（v0.5.9）：只给「短查询」或「二字组已经命中」的点加分。
      // 不加这道闸，一个常见字就能把整条点抬过 0.8 —— 金标里「每天下午几点喝咖啡」
      // 曾因此误中「下雨天他膝盖疼」（共用一个"天"字，0.80 刚好过线）。
      const uniOk = qs.size <= 2 || base > 0
      const uni =
        uniOk && wp.unigram
          ? wp.unigram *
            (wp.title * overlap(qu, unigrams(p.title)) +
              wp.tags * overlap(qu, unigrams((p.tags || []).join(''))) +
              wp.cluster * overlap(qu, unigrams(p.cluster)))
          : 0
      return { point: p0, score: (base + uni) * (weight ? weight(p0) : 1) }
    })
    .filter((x) => x.score >= threshold)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.point.salience || 0) - (a.point.salience || 0) ||
        String(b.point.date || '').localeCompare(String(a.point.date || '')),
    )
    .slice(0, limit)
}

/** 她这轮有没有真的提到这条（用于复述回血） */
export function wasMentioned(point, text) {
  const t = String(text || '')
  if (!t) return false
  const q = String(point.quote || '')
  if (q.length >= 4 && t.includes(q.slice(0, Math.min(q.length, 12)))) return true
  const title = String(point.title || '')
  return title.length >= 4 && t.includes(title)
}

/**
 * 事件簇：同一 event 只留分数最高的一条，最多 maxEvents 个（契约 §3.7）。
 * 无 event 时用 id 当自己的事件，保证一条点只占一个名额。
 */
export function pickByEvent(ranked, maxEvents = 3) {
  const picked = []
  const seen = new Set()
  for (const item of ranked) {
    const ev = item.point.event || item.point.id
    if (seen.has(ev)) continue
    seen.add(ev)
    picked.push(item.point)
    if (picked.length >= maxEvents) break
  }
  return picked
}
