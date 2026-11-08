// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * anchor.js — 改口之后，旧问法不能断（v0.77.0）。
 *
 * ## 问题（实测过，不是推测）
 *
 * `memory invalidate` 把旧点标成失效后，`productionPool` 会把它从检索池里筛掉，
 * 只剩新的那条。而新点的标题往往**不含旧话题的词**：
 *
 *   旧：约了周六见面（invalid_at 2026-11-01）
 *   新：改成周日了
 *   查询「我们约的哪天见面」→ 最高分 **0.000**，因为两边二字组零重叠
 *
 * 结果是：**她改过口之后，你再用原来那个问法问，她反而查不到。**
 * 这不是阈值问题（0.000 降阈值救不了），是**话题锚点随旧点一起消失了**。
 *
 * ## 修法
 *
 * invalidate 的时候，把旧标题里的"话题词"继承给新点的 `aliases`——
 * `retrieve.js` 本来就把 `aliases` 并进 `tags` 一起算分，所以这一步等于
 * 把断掉的线索接回去。只做加法，不改正文，不改旧点。
 *
 * ## 为什么不是自动全做
 *
 * 继承哪些词是**编辑判断**，不是计算：从"约了周六见面"里挑出"约/见面"可以，
 * 挑出"周六"就错了（周五的新点不该被"周六"命中）。所以：
 *   · 默认只继承**去掉时间词、数字、助词之后的 2 字词**；
 *   · 命令行可以 `--inherit` 手动指定，覆盖自动结果。
 */

/** 这些词不该被继承：时间、数字、量词、常见助词——继承它们会让新点被错误命中 */
const STOP = new Set([
  '周六', '周日', '周一', '周二', '周三', '周四', '周五', '今天', '明天', '昨天', '后天', '前天',
  '上午', '下午', '晚上', '中午', '早上', '凌晨', '这个', '那个', '一下', '什么', '怎么', '已经',
  '还是', '然后', '但是', '因为', '所以', '如果', '我们', '你们', '他们', '自己', '现在', '刚才',
])

const isCjk = (s) => /^[\u4e00-\u9fa5]+$/.test(s)

/**
 * 从标题里挑出可以继承的话题词。
 *
 * **第一版是滑窗二字组，结果全是垃圾**：`约了周六见面` → `["约了","了周","六见","见面"]`，
 * 其中三个是跨词边界切出来的假词，继承过去只会污染检索。
 *
 * 现在改成：先把助词/时间词/数字当**分隔符**，再取切出来的中文片段（1–4 字）。
 * 同一条 ⇒ `["约","见面"]`——正是查询「我们约的哪天见面」里的那两个词。
 */
export function topicWords(title, { max = 4 } = {}) {
  const t = String(title || '').trim()
  if (!t) return []
  // 助词、代词、时间词、数字一律当分隔符（不是词）
  const SEP = /[的了是在和与就都也又很太把被给让着过吗呢吧啊呀嘛哦额咩哈\s，。、！？,.!?0-9零一二三四五六七八九十周六日今明昨后前早晚上午中凌晨点分号年月]/g
  const chunks = t.replace(SEP, ' ').split(/\s+/).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const c of chunks) {
    const w = c.slice(0, 4) // 长句只取前 4 字，别把整句搬进 aliases
    if (!isCjk(w) || w.length < 1) continue
    if (STOP.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= max) break
  }
  return out
}

/**
 * 算"这次 invalidate 应该继承给谁、继承什么"。
 *
 * 找新点的顺序（都对不上就不继承，返回空——**宁可不断言，也不乱连**）：
 *   ① 显式给的 `--by <id>`
 *   ② 某个 active 点的 `contradicts` 里包含旧 id（她或 refute 已经声明过冲突）
 *   ③ 同 cluster、同 type、日期比旧点新、且是 active 的最新一条
 *
 * @returns {{by:string|null, words:string[], reason:string}}
 */
export function planInheritance(points, oldPoint, { by = null, inherit = null } = {}) {
  const words = Array.isArray(inherit) && inherit.length ? inherit : topicWords(oldPoint?.title)
  if (!words.length) return { by: null, words: [], reason: '旧标题里没有可继承的话题词' }

  const active = points.filter((p) => p.id !== oldPoint.id && p.status === 'active')
  let target = null
  let reason = ''

  if (by) {
    target = active.find((p) => p.id === by) || null
    reason = target ? '--by 指定的新点' : `--by 指的 ${by} 不是 active 点`
  }
  if (!target) {
    target = active.find((p) => Array.isArray(p.contradicts) && p.contradicts.includes(oldPoint.id)) || null
    if (target) reason = '新点的 contradicts 里已经声明了这条'
  }
  if (!target) {
    const same = active
      .filter((p) => p.cluster === oldPoint.cluster && p.type === oldPoint.type && String(p.date || '') > String(oldPoint.date || ''))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    target = same[0] || null
    if (target) reason = '同 cluster / 同 type / 日期更新（兜底）'
  }

  if (!target) return { by: null, words, reason: reason || '找不到该继承给谁' }
  return { by: target.id, words, reason }
}
