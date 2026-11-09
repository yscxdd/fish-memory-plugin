// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * serveapi.js — 只读接口的**纯逻辑**（v0.59.0）。
 *
 * 为什么从 `scripts/serve.mjs` 里抠出来：那个文件一 import 就 `listen()`，测不了。
 * 而这几件事恰好是最该测的——**它们是通道接入的唯一接触面**：
 *
 *   · `parseContextQuery`：`/context` 怎么读参数、scope 不合法时怎么拒；
 *   · `filterForScope`：真的按 scope 过滤（不是嘴上说隔离）；
 *   · `scopeAnswer`：`/scope` 根据渠道字段判"这条消息属于谁"。
 *
 * 三条红线照旧：零依赖 / 只读 / 不猜（拿不到就明说拿不到）。
 */

import { filterByScope, resolveScope, SCOPE_DM_MASTER, validateScope } from './scope.js'

/**
 * 解析 `/context` 的查询串。
 * @returns {{ok:true, q:string, session:string, mode?:string, scope:string} | {ok:false, error:string, status:number}}
 */
export function parseContextQuery(params = {}) {
  const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k])
  // 评审 v0.80.1 次要项：MCP 侧有 QUERY_MAX=2000，HTTP 侧没有——
  // 别人可以用一个超长 q 把检索拖死。同一口径限一下。
  const q = String(get('q') || '').slice(0, 2000)
  const session = String(get('session') || '')
  // F5（审计 v0791，P1）：session 直接拼路径，`../../x` 能读到库外任意 *.json。
  // 字符集只留会话 id 用得上的那些；带 `..` 一律拒。
  if (session && (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(session) || session.includes('..'))) {
    return { ok: false, status: 400, error: 'session 不合法（只允许字母数字 . _ -，且不能含 ..）' }
  }
  const modeRaw = get('mode')
  const mode = modeRaw ? String(modeRaw) : undefined
  if (mode && mode !== 'daily' && mode !== 'task') {
    return { ok: false, status: 400, error: `mode 只能是 daily / task：${mode}` }
  }
  const scopeRaw = get('scope')
  if (scopeRaw == null || String(scopeRaw).trim() === '') {
    // 没传 = 主人私聊（历史行为不变；这也让老客户端不用改）
    return { ok: true, q, session, mode, scope: SCOPE_DM_MASTER }
  }
  const v = validateScope(scopeRaw)
  if (!v.ok) return { ok: false, status: 400, error: v.reason }
  return { ok: true, q, session, mode, scope: v.scope }
}

/** 按 scope 过滤点（一行，但这里必须有反向测试） */
export function filterForScope(points, scope) {
  const v = validateScope(scope)
  if (!v.ok) return []
  return filterByScope(points, v.scope)
}

/**
 * `/scope` 的答案：把这个渠道事件判成"属于谁"。
 *
 * @param {{channelType?:string, groupId?:string, senderId?:string, masterIds?:string, homeGroups?:string, memberRole?:string}} q
 *   masterIds / homeGroups 用逗号分隔（查询串里就是这样传的）
 */
export function scopeAnswer(q = {}) {
  const split = (v) => (v == null || v === '' ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean))
  const r = resolveScope({
    channelType: q.channelType,
    groupId: q.groupId ?? null,
    senderId: q.senderId ?? null,
    masterIds: split(q.masterIds),
    homeGroups: split(q.homeGroups),
    memberRole: q.memberRole ?? null,
  })
  return {
    ...r,
    // 通道侧最需要的两句人话：
    mayWriteCore: false, // 永远 false —— 任何人、任何渠道
    writeTarget: r.readOnly ? '40_pending/' : '40_pending/（仍然只写草稿，直写点由人过闸）',
  }
}
