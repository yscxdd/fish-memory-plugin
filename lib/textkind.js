// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * textkind.js — "这句话是聊天，还是工作产出"（v0.65.0）。
 *
 * 从 `wakeup.js` 挪出来的。为什么挪：`voice.js`（挖口癖）、`emotion.js`（情绪闸）、
 * `alias.js`（别名）都需要同一个判据，而它们**不能反向依赖 wakeup**
 * （wakeup 依赖 voice 的取样，会成环）。
 *
 * 判据是**保守的**（宁可把一句正常的当成工作）：漏判的代价是"工作措辞进人格"，
 * 误判的代价只是"少算一次情绪/少挖一条口癖"。
 */

/** 这条像不像工作产出（代码/路径/命令/长汇报） */
export function looksLikeWork(text) {
  const t = String(text || '')
  if (t.length > 120) return true // 长回复基本是汇报/解释
  if (/```|`|\*\*|<\/?[a-z]/.test(t)) return true // 代码块、行内代码、加粗、标签
  const ascii = (t.match(/[A-Za-z]/g) || []).length
  if (ascii / Math.max(1, t.length) > 0.15) return true // 英文/路径/命令占比过高
  return /(文件|代码|测试|提交|仓库|命令|路径|脚本|打包|同步|版本|报错|日志|函数|接口|配置|依赖|部署)/.test(t)
}

/**
 * 这句话里有没有"我"和"自身状态"（v0.66.0，E1）。
 *
 * 为什么不能复用 looksLikeWork：那条判据是为"这条**回复**是不是工作产出"设计的
 * （长、英文多、带技术词）。拿它判"**他这句话**算不算情绪事件"会误伤最该被听见的那类：
 *   「刚被 leader 骂了一顿，心里堵得慌」→ 因为一个英文词就被挡
 *   「这个版本上线之后我整个人都空了」→ 因为"版本"在黑名单里被挡
 *   「> 120 字一律算工作」→ 把最需要被听见的长倾诉整类排除
 *
 * 实测：v0.65 下他的消息有 50% 被判成工作 → 情绪半停摆。
 *
 * 新判据只问两件事：有"我"（或俺/咱）+ 有自身状态词。**判断/评价不算情绪**。
 */
// 保留这个正则是为了**可读性**（判据里说明"有我在说"），但它不是必要条件，见 hasFeel
const SELF_REF = /(我|俺|咱)/
const FEEL_WORD = /(累|难受|烦|怕|慌|委屈|开心|高兴|难过|想哭|哭|疼|空|没劲|不想动|孤独|寂寞|焦虑|生气|烦死|堵|崩|爽|踏实|安心|紧张|撑不住|熬不住|睡不着|失眠)/
const JUDGE_ONLY = /(我觉得|我认为).{0,6}(不行|可以|挺好|没问题|对不对|错了)/

export function hasFeel(text) {
  const raw = String(text || '')
  if (!raw.trim()) return false
  // 代码块先剥掉：代码里出现"我"和"怕"不算他在说心情
  const t = raw.replace(/```[\s\S]*?```/g, ' ')
  // **不以"我"为必要条件**：中文常省略主语——
  // 「刚被 leader 骂了一顿，心里堵得慌」「Java 又出问题了，烦」都没有"我"，
  // 但两句都是在说心情（实测：加了 SELF 条件这两句会被挡掉，而它们正是该被听见的）。
  if (!FEEL_WORD.test(t)) return false
  if (JUDGE_ONLY.test(t)) return false
  return true
}

/** 反过来：像聊天（给"只在日常对话里做的事"用） */
export const looksLikeChat = (text) => !looksLikeWork(text)
