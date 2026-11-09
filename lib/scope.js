// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * scope.js — "这条记忆属于谁"（v0.58.0）。
 *
 * 为什么需要：这个库一直把世界建模成"我和他两个人"——`relation.md` 一份、
 * `emotion.user` 一位、`touchSession` 里没有说话人。接进群聊之后，
 * **群里任何人都能触发写入**：一句"我最怕被丢下"就可能进 `40_pending/`，
 * 过闸后变成主人的画像。
 *
 * （OWASP ASI06 把这叫 memory poisoning：记忆写入是特权操作，不是普通 I/O。）
 *
 * 所以先把"归属"这一列加上，**再接通道**。三种取值：
 *
 *   global            全局层（soul / rules 这些锚点，永不按 scope 分）
 *   dm:master         主人私聊
 *   group:<gid>       某个群（群内共享）
 *
 * 判定只认**不可改的 id**，绝不认昵称：官方通道昵称可改，OneBot 的群名片谁都能设。
 * 有人（AstrBot 的 ai_memory 插件）就是被这事逼出了"冒充检测"。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readPointFiles } from './toolkit.js'
import { atomicWriteText, sha8 } from './util.js'

export const SCOPE_GLOBAL = 'global'
export const SCOPE_DM_MASTER = 'dm:master'

/** 群作用域？ */
export const isGroupScope = (s) => String(s || '').startsWith('group:')

/** 点的 scope（缺省 = global，历史点不用迁移） */
export const scopeOf = (point) => (point && typeof point.scope === 'string' && point.scope ? point.scope : SCOPE_GLOBAL)

/**
 * 一条点对当前作用域可不可见：自己的 scope 或 global。
 * 注意方向：**group:A 看不见 dm:master，dm:master 也看不见 group:A**——
 * 主人库不该因为群聊而膨胀，群里也不该读到家里的事。
 */
export function visible(point, scope = SCOPE_DM_MASTER) {
  const s = scopeOf(point)
  if (s === SCOPE_GLOBAL) return true
  return s === scope
}

/** 检索前的过滤（一行，但必须有反向测试：A 的结果里不许有 B） */
export function filterByScope(points, scope = SCOPE_DM_MASTER) {
  return (points || []).filter((p) => visible(p, scope))
}

/**
 * 由渠道回调判断这次消息属于谁。
 *
 * @param {{channelType?:string, groupId?:string|number, senderId?:string|number,
 *          masterIds?:Array<string|number>, homeGroups?:Array<string|number>, memberRole?:string}} ctx
 * @returns {{scope:string, role:'master'|'member'|'stranger', readOnly:boolean, reason:string}}
 */
export function resolveScope({
  channelType,
  groupId = null,
  senderId = null,
  masterIds = [],
  homeGroups = [],
  memberRole = null,
} = {}) {
  const asStr = (v) => (v == null ? '' : String(v))
  const masters = new Set((masterIds || []).map(asStr))
  const homes = new Set((homeGroups || []).map(asStr))
  const sender = asStr(senderId)
  const group = asStr(groupId)
  const isMasterId = Boolean(sender) && masters.has(sender)

  if (channelType === 'private') {
    return isMasterId
      ? { scope: SCOPE_DM_MASTER, role: 'master', readOnly: false, reason: '私聊 + 主人 id 白名单' }
      : { scope: `dm:${sender || 'unknown'}`, role: 'stranger', readOnly: true, reason: '私聊但不是白名单里的人：只读' }
  }

  // 群：主人 = id 在白名单 **且** 群在 homeGroups 里。
  // memberRole === 'owner' 只作为附加依据，不作为唯一依据（群主可能不是主人）。
  if (!group) {
    return { scope: `group:unknown`, role: 'member', readOnly: true, reason: '群消息但拿不到群标识' }
  }
  const isMasterHere = isMasterId && homes.has(group)
  const ownerButNotListed = !isMasterHere && memberRole === 'owner' && homes.has(group)
  return {
    scope: `group:${group}`,
    // 评审 v0.80.1 次要项：这里原来是 `isMasterHere || ownerButNotListed ? 'member' : 'member'`——
    // 两个分支一样，等于这个三元从来没起过作用。**群里一律 member**（写入只进 pending），
    // 所以直接写常量；"主人在群里算不算 master"是设计问题，不在这里悄悄决定。
    role: 'member',
    readOnly: true,
    reason: isMasterHere ? '群 + 主人（仍只写 pending）' : '群友：只写 pending',
  }
}

/**
 * 校验一个 scope 字符串（v0.59.0）。
 *
 * 为什么要在入口校验：`scope` 是**隔离边界**，拼错的 scope（`group:`、`group`、`Group:1`）
 * 会让过滤失效——最坏的情况是"以为隔离了，其实两条都看得见"。
 * 所以宁可直接 400，也不猜。
 */
export function validateScope(s) {
  const v = String(s == null ? '' : s).trim()
  if (!v) return { ok: false, reason: 'scope 不能为空' }
  if (v === SCOPE_GLOBAL || v === SCOPE_DM_MASTER) return { ok: true, scope: v }
  if (/^dm:[A-Za-z0-9_-]{1,64}$/.test(v)) return { ok: true, scope: v }
  if (/^group:[A-Za-z0-9_-]{1,64}$/.test(v)) return { ok: true, scope: v }
  return { ok: false, reason: `scope 写法不对（要 global / dm:<id> / group:<id>）：${v}` }
}

/** 是否允许把它当"可写的家"（只有主人私聊是） */
export const isMasterScope = (s) => String(s || '') === SCOPE_DM_MASTER

/**
 * A3（v0.71.0）：给**没有 scope** 的点补一列。
 *
 * 为什么必须补：缺省按 `global` 处理，而 global 对**所有**作用域可见。
 * 接群那天，「他怕被丢下」这种**标题**会跟着索引行进群——标题本身就是隐私。
 *
 * 只碰缺 scope 的点；每个点写一行日志（含改动前后指纹）。
 */
export function stampScope(dir, fallback = SCOPE_DM_MASTER, { now = new Date(), files = null } = {}) {
  const list = files || readPointFiles(dir, '30_points')
  const target = list.filter((p) => !p.scope)
  const rows = []
  let stamped = 0
  for (const p of target) {
    try {
      const abs = String(p.file || '').includes(dir) ? String(p.file) : join(dir, '30_points', String(p.file))
      const raw = readFileSync(abs, 'utf8')
      const before = sha8(raw)
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
      if (!m) continue
      const next = `---\n${m[1]}\nscope: ${fallback}\n---\n${m[2]}`
      atomicWriteText(abs, next)
      stamped += 1
      rows.push({ at: now.toISOString(), id: p.id, scope: fallback, before, after: sha8(next) })
    } catch (e) {
      rows.push({ at: now.toISOString(), id: p.id, error: String(e?.message || e) })
    }
  }
  if (rows.length) {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(join(dir, '50_log', 'scope-stamp.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
  return { stamped, skipped: list.length - target.length, log: '50_log/scope-stamp.log' }
}
