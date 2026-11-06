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

/** 反过来：像聊天（给"只在日常对话里做的事"用） */
export const looksLikeChat = (text) => !looksLikeWork(text)
