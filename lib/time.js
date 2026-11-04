// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 时间轴（v0.40.0，① 组）——补上"这条从什么时候开始成立"。
 *
 * 我们原来只有三样：`date`（发生日）、`invalid_at`（**已经**失效）、`expires_at`（**将会**失效）。
 * 缺的是 `valid_from`。没有它，隔两个月翻到"我下个月要去广州"，分不清是**计划**还是**已完成**。
 *
 * 三个桶（照 mem0 2026 那套"当前状态 / 过去事件 / 未来计划"）：
 *   current  现在成立
 *   past     已经失效（invalid_at / expires_at 已过）
 *   future   还没开始（valid_from 在未来）
 *
 * 只用来**标注与排序**，不改任何数据。
 */

export const TIME_CURRENT = 'current'
export const TIME_PAST = 'past'
export const TIME_FUTURE = 'future'

const ms = (v) => {
  const t = Date.parse(String(v || ''))
  return Number.isFinite(t) ? t : null
}

/** 这条点在"现在"属于哪个桶 */
export function timeBucket(p, now = new Date()) {
  const n = now.getTime()
  const from = ms(p.valid_from) ?? ms(p.date)
  const invalid = ms(p.invalid_at)
  const expires = ms(p.expires_at)
  if (from != null && from > n) return TIME_FUTURE
  if (invalid != null && invalid <= n) return TIME_PAST
  if (expires != null && expires <= n) return TIME_PAST
  return TIME_CURRENT
}

/** 注入里的短标记（现在的不标，省 token） */
export function timeMarker(bucket) {
  if (bucket === TIME_PAST) return '[过去]'
  if (bucket === TIME_FUTURE) return '[计划]'
  return ''
}

const PAST_RE = /(上次|之前|以前|那时候|当天|那天|回[忆想]|记得.*(时候|那次)|后来)/ 
const FUTURE_RE = /(下次|以后|将来|明天|后天|下周|下个月|明年|计划|打算|准备|要去的)/

/** 他这句话在问哪个时间段（问不到就 null） */
export function queryIntent(query) {
  const q = String(query || '')
  if (PAST_RE.test(q)) return TIME_PAST
  if (FUTURE_RE.test(q)) return TIME_FUTURE
  return null
}

/**
 * 时间权重：问过去就偏过去，问将来就偏将来，没问就偏现在。
 *
 * 为什么用乘 0.6 而不是直接过滤：过滤会让"问上次"时彻底看不到现在的事，
 * 而人回答"上次"时也会顺口提"现在不一样了"。
 */
export function timeWeight(p, intent = null, now = new Date()) {
  const bucket = timeBucket(p, now)
  if (!intent) return bucket === TIME_CURRENT ? 1 : 0.85
  if (bucket === TIME_CURRENT) return 1
  return bucket === intent ? 1.1 : 0.6
}

/** 时间轴体检：过去/计划各有多少（给 audit 用） */
export function timelineCounts(points, now = new Date()) {
  const out = { current: 0, past: 0, future: 0 }
  for (const p of points) out[timeBucket(p, now)] += 1
  return out
}

/** `memory timeline` 用：按时间排一眼 */
export function timelineRows(points, now = new Date()) {
  return points
    .map((p) => ({
      id: p.id,
      title: p.title || '',
      bucket: timeBucket(p, now),
      valid_from: p.valid_from || p.date || null,
      invalid_at: p.invalid_at || null,
      expires_at: p.expires_at || null,
    }))
    .sort((a, b) => String(b.valid_from || '').localeCompare(String(a.valid_from || '')))
}

export function timeLabel(bucket) {
  return bucket === TIME_PAST ? '过去' : bucket === TIME_FUTURE ? '计划' : '现在'
}
/* ── 相对时间（v0.49.0，A3）──────────────────────────────────── */

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 中文数字 → 阿拉伯（一 / 两 / 十 / 十二 / 三十…），解不出返回 null */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
export function cnNumber(s) {
  const t = String(s || '').trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (!t) return null
  if (t === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(t)
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0)
  if (t.length === 1 && t in CN_DIGIT) return CN_DIGIT[t]
  const m2 = /^([一二两三四五六七八九])([一二两三四五六七八九])$/.exec(t)
  if (m2) return CN_DIGIT[m2[1]] * 10 + CN_DIGIT[m2[2]]
  return null
}

/** 本地某天的 0 点 */
function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}
function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
function weekStart(d) {
  // 周一为一周之始（中文习惯），getDay(): 0=周日
  const wd = d.getDay() === 0 ? 7 : d.getDay()
  return dayStart(addDays(d, -(wd - 1)))
}
function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
}

/**
 * 从他的问法里解出一段时间窗（v0.49.0）。
 *
 * 为什么需要：`goldset.js` 自己写着"没有跨会话时序"——他说"上周三聊的那个"，
 * 我们只会拿字面去撞，撞不上就空召回。先把时间约束解出来，再让窗内的点排前面。
 *
 * 支持：今天 / 昨天 / 前天 / 大前天 / 这周 / 上周 / 上周三 / 这个月 / 上个月 / 今年 / 去年 /
 *       最近 N 天 | 周 | 个月 / N 天前 / N 周前 / N 个月前
 *
 * 解不出就返回 null——**不要猜**（猜错比不猜更糟：会把无关的点拉上来）。
 * @returns {{from:Date, to:Date, label:string}|null}
 */
export function parseTimeRange(query, now = new Date()) {
  const q = String(query || '')
  if (!q) return null
  const today = dayStart(now)
  const mk = (from, to, label) => ({ from, to, label })

  // 最近 N 天 / 周 / 个月
  const recent = /(?:最近|近|这)\s*([0-9一二两三四五六七八九十]+)\s*(天|日|周|个?月)/.exec(q)
  if (recent) {
    const n = cnNumber(recent[1])
    if (Number.isFinite(n) && n > 0 && n <= 3650) {
      const unit = recent[2]
      const from = unit.includes('月') ? new Date(today.getFullYear(), today.getMonth() - n, today.getDate()) : unit.includes('周') ? addDays(today, -7 * n) : addDays(today, -n)
      return mk(from, now, `最近 ${n} ${unit}`)
    }
  }

  // N 天前 / N 周前 / N 个月前
  const ago = /([0-9一二两三四五六七八九十]+)\s*(天|日|周|个?月)\s*前/.exec(q)
  if (ago) {
    const n = cnNumber(ago[1])
    if (Number.isFinite(n) && n > 0 && n <= 3650) {
      const unit = ago[2]
      const from = unit.includes('月') ? new Date(today.getFullYear(), today.getMonth() - n, today.getDate()) : unit.includes('周') ? addDays(today, -7 * n) : addDays(today, -n)
      const to = unit.includes('月') ? new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59) : addDays(from, unit.includes('周') ? 6 : 0)
      return mk(from, unit.includes('周') || unit.includes('月') ? to : new Date(from.getFullYear(), from.getMonth(), from.getDate(), 23, 59, 59), `${n} ${unit}前`)
    }
  }

  // 上周三 / 上周 / 这周
  const wk = /(上上周|上周|这周|本周)\s*([一二三四五六日天])?/.exec(q)
  if (wk) {
    const base = weekStart(now)
    const shift = wk[1] === '上上周' ? -14 : wk[1] === '上周' ? -7 : 0
    const start = addDays(base, shift)
    if (wk[2]) {
      const day = WEEKDAY[wk[2]]
      const from = addDays(start, day - 1)
      return mk(from, new Date(from.getFullYear(), from.getMonth(), from.getDate(), 23, 59, 59), `${wk[1]}${wk[2]}`)
    }
    return mk(start, new Date(addDays(start, 6).getFullYear(), addDays(start, 6).getMonth(), addDays(start, 6).getDate(), 23, 59, 59), wk[1])
  }

  // 这个月 / 上个月 / 上上个月
  const mo = /(上上个月|上个月|这个月|本月)/.exec(q)
  if (mo) {
    const shift = mo[1] === '上上个月' ? -2 : mo[1] === '上个月' ? -1 : 0
    const from = new Date(now.getFullYear(), now.getMonth() + shift, 1, 0, 0, 0, 0)
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59)
    return mk(from, to, mo[1])
  }

  // 今年 / 去年
  const yr = /(去年|今年)/.exec(q)
  if (yr) {
    const y = yr[1] === '去年' ? now.getFullYear() - 1 : now.getFullYear()
    return mk(new Date(y, 0, 1, 0, 0, 0, 0), new Date(y, 11, 31, 23, 59, 59), yr[1])
  }

  // 今天 / 昨天 / 前天 / 大前天
  const dy = /(大前天|前天|昨天|今天)/.exec(q)
  if (dy) {
    const n = { 今天: 0, 昨天: -1, 前天: -2, 大前天: -3 }[dy[1]]
    const from = addDays(today, n)
    return mk(from, new Date(from.getFullYear(), from.getMonth(), from.getDate(), 23, 59, 59), dy[1])
  }

  return null
}

/** 点在不在这个时间窗里（没有日期的点 = 不知道，不加分也不扣分） */
export function inRange(point, range) {
  if (!range || !point) return null
  const t = Date.parse(String(point.date || ''))
  if (!Number.isFinite(t)) return null
  return t >= range.from.getTime() && t <= range.to.getTime()
}

/**
 * 时间窗加权：窗内 ×1.25，窗外 ×0.8，没日期的不动。
 * 不做硬过滤——"上周三"也可能记错，硬过滤会把对的答案直接删掉。
 */
export function rangeWeight(point, range) {
  const hit = inRange(point, range)
  if (hit === null) return 1
  return hit ? 1.25 : 0.8
}