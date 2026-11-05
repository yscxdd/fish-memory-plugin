// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * visibility.js — 三级可见性（v0.61.0）。
 *
 * 为什么补这个：v0.58 做了 scope 隔离（群看不见私聊、私聊看不见群），但那只解决
 * **"这条记忆属于谁"**；没解决**"属于这里的东西，能不能在这个场合说出来"**。
 *
 * 例如："他说过怕被丢下" 属于 dm:master（对），但群里有人问"她怎么看你"时，
 * 这件事**不该被复述**——只该允许暗示（"你上次提过的那类事我记着"）。
 *
 * 三级（借 dsn-mnemo 的分法，Apache-2.0，此处为独立实现，未复制其代码）：
 *
 *   public    哪儿都能说（默认在群里写的东西）
 *   private   私聊能复述；群聊**只给索引行**（标题级，不给摘要与正文）——"暗示"的实现方式
 *   secret    群聊里**根本不出现**（硬过滤，连标题都不给）
 *
 * 缺省值：**private**。理由：宁可少说一句，不要多说一句。
 * 私聊作用域下三级都按原文给——这一层只约束"跨场合"。
 */

export const VISIBILITIES = Object.freeze(['public', 'private', 'secret'])
export const DEFAULT_VISIBILITY = 'private'

export function normalizeVisibility(raw) {
  return VISIBILITIES.includes(raw) ? raw : null
}

export const visibilityOf = (p) => normalizeVisibility(p && p.visibility) || DEFAULT_VISIBILITY

/**
 * 这条在当前作用域能不能出现。
 * **只在群作用域过滤 secret**；私聊里三级都按原文给——这一层只约束"跨场合"。
 */
export function survivesInGroup(p, scope) {
  if (!String(scope || '').startsWith('group:')) return true
  return visibilityOf(p) !== 'secret'
}

/**
 * 群作用域下要不要降级成"暗示"（只给索引行，不给摘要）。
 * 只在群作用域生效；私聊里 private 照样全文。
 */
export function hintOnly(p, scope) {
  const isGroup = String(scope || '').startsWith('group:')
  if (!isGroup) return false
  return visibilityOf(p) === 'private'
}
