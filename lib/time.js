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
