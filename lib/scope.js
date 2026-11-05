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
    role: isMasterHere || ownerButNotListed ? 'member' : 'member', // 群里一律 member：写入只进 pending
    readOnly: true,
    reason: isMasterHere ? '群 + 主人（仍只写 pending）' : '群友：只写 pending',
  }
}
