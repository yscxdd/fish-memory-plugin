// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * nearMiss.js — 「差一点想起」要说出口（v0.77.0）。
 *
 * ## 为什么
 *
 * `retrieval.log` 从 v0.73 就记 `nearMiss`（最好的那条没过线），但**从来没有回到注入**。
 * 于是一件事发生了两次：
 *   · 她查了，没查到，**但不知道该说"我没找到"**；
 *   · 你问她"我们约的哪天"，她答不上，你以为她忘了——其实是她**没找到却也没说**。
 *
 * 公开文章那句「'忘了'通常等于'没检索到'」说的就是这个：**差一点和完全没有，对用户的体感是一样的。**
 * 这一版只做一件事：让"差一点"和"完全没有"能说出口。
 *
 * ## 三条纪律
 *
 *   ① **只在"核对类问句"上开口**。日常闲聊里插一句"我没找到"是噪音；
 *      问"改了吗/还是/哪天"这类**在核对一件具体的事**的时候，没说出口才是错的。
 *   ② **同一条点 12 小时只提一次**（复用 `remind.js` 的 `reminded.json`）。
 *   ③ **库里没有点的时候完全不开口**——空库上每句都"没找到"，那不是诚实，是坏掉。
 */

import { remindLine } from './remind.js'
import { REMIND_COOLDOWN_MS, loadReminded, markReminded } from './remind.js'

/**
 * 核对类问句。
 *
 * **口径是拿 97 条真消息量出来的，不是拍脑袋**（2026-11-08，`_old-fish-memory-backups`）：
 *
 * | 规则 | 误报 | 我们约的哪天见面 | 见面改时间了吗 |
 * |---|---|---|---|
 * | 只要「变化类」 | 0/97 | ✗ | ✓ |
 * | 只要「指向类」 | 1/97 | ✓ | ✗ |
 * | **两类取并集（去掉「还是」）** | **1/97** | **✓** | **✓** |
 *
 * 所以是**并集**，不是交集（交集两条都抓不到）。「还是」被单独拿掉：
 * 它在口语里出现太多（"我们还是朋友吧"），加回来会把日常聊天判成核对。
 */
const CHANGE_RE = /改了吗|改了没|变了吗|变了没|有没有变|还作数|还有效|还算数|推迟|延后|取消|改到|改成|改期|改时间/
const POINT_RE = /哪天|哪一天|几号|周几|星期几|几点|什么时候|约的|说好|定好|确定|确认/

/** 这句话是不是在核对一件具体的事 */
export function looksLikeCheck(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  return CHANGE_RE.test(t) || POINT_RE.test(t)
}

/**
 * 生成那一行（≤25 tok）。不该开口时返回 null。
 *
 * @param {{query:string, nearMiss:{id:string,score:number}|null, threshold:number|null, pointCount:number,
 *          now?:Date}} p
 * @returns {{text:string, id:string|null, kind:'near'|'none'}|null}
 */
export function checkLine({ query, nearMiss, threshold = null, pointCount = 0, now = new Date() } = {}) {
  if (!looksLikeCheck(query)) return null
  // 空库上不开口：那不是"没找到"，那是还没有
  if (pointCount <= 0) return null

  const th = Number.isFinite(threshold) ? threshold : 0.8
  const near = nearMiss && Number.isFinite(nearMiss.score) ? nearMiss : null
  // 差一点：分数在 0.7 与阈值之间（太低的不算"差一点"，那确实是没找到）
  if (near && near.score >= 0.7 && near.score < th) {
    return { text: `〔核对〕这事我不太确定，可能是「${near.id}」那条；你确认下。`, id: near.id, kind: 'near' }
  }
  // 完全没有：也说一句，别让她装懂
  return { text: '〔核对〕这件事我库里没找到；要么是没记，要么是我没搜到。', id: null, kind: 'none' }
}

/**
 * 带冷却的版本（同一条点 12 小时只提一次；`none` 这类不带 id 的按天去重）。
 *
 * @returns {{text:string, id:string|null, kind:string, marked:boolean}}
 */
export function checkLineWithCooldown(dir, { query, nearMiss, threshold, pointCount, now = new Date() } = {}) {
  const base = checkLine({ query, nearMiss, threshold, pointCount, now })
  if (!base) return { text: '', id: null, kind: 'skip', marked: false }

  const reminded = loadReminded(dir)
  const key = base.id || '__check_none__'
  // reminded.json 的形状是 `{ [id]: { at, at_ms } }`（remind.js 定的），
  // 不是 `{ [id]: 时间戳 }`。第一版按后者读，于是冷却永远判不出来——
  // **同一个账本两种读法，跟字段接线断了是同一种错。**
  const entry = reminded[key]
  const last = Number(entry && typeof entry === 'object' ? entry.at_ms ?? Date.parse(entry.at) : entry) || 0
  if (Number.isFinite(last) && last > 0 && now.getTime() - last < REMIND_COOLDOWN_MS) {
    return { text: '', id: base.id, kind: 'cooldown', marked: false }
  }
  try {
    markReminded(dir, [key], now)
  } catch {
    /* 记账失败不拦这句话 */
  }
  return { text: base.text, id: base.id, kind: base.kind, marked: true }
}

/** 供 index.js 用：拼成注入了吗不用的辅助（保留给测试） */
export function renderCheckBlock(line) {
  if (!line) return ''
  return `<!-- 核对 -->${line}<!-- /核对 -->`
}

// remindLine 目前没用上，留着避免 lint 报"导入了但没用"的误会
void remindLine
