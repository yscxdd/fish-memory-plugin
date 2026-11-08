// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 隐私脱敏（v0.31.0）——借自《性格与记忆情绪系统 v2》的 SENSITIVE 做法。
 *
 * 为什么要有：档案（`10_archive/`）是**逐字只追加**的。他随手把 API key、手机号、
 * 身份证贴进对话，那条就永久躺在库里了——不是"要不要记"的问题，是"库里不该有这种东西"。
 *
 * 三条规矩：
 *   ① **在入库前脱敏**（`buildRecord` 里就换掉），所以档案里从来没有明文；
 *   ② 脱敏标记是**幂等**的：同一段文字重复脱敏，结果不变；
 *   ③ 逐字校验仍然成立：档案和 QUOTE 都是脱敏后的文本，两边一致。
 */

/** 敏感模式：顺序有意义（先长后短、先具体后泛化） */
export const SENSITIVE_PATTERNS = [
  { kind: '身份证', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: '银行卡', re: /(?<!\d)\d{16,19}(?!\d)/g },
  // F3（审计 v0791，P1）：原来的 `[..]+` 后面跟一个可能不存在的 `@`——
  // 没有 @ 的长串（base64 / JWT / 哈希）会让引擎一路扫到串尾再回溯，O(n²)。
  // 按 RFC 给两段都加长度上限：local ≤64、domain ≤255，量级立刻变回线性。
  { kind: '邮箱', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
  { kind: 'API密钥', re: /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g },
  // 裸十六进制**不**单独脱敏：实测真库 17 处命中全是 sha256 校验和（我们自己打印的包指纹），
  // 脱敏会把正当内容改坏。真正的密钥一般带前缀（sk-/ghp_）或跟着关键词（password/api_key），下面两条已覆盖。
  { kind: '凭据', re: /\b((?:bearer|token|secret|password|passwd|api[_-]?key))\b(\s*[:=：]\s*)(?!\[脱敏)[^\s，。；、,;]{6,}/gi, keepKeyword: true },
  { kind: '凭据', re: /(密码|密钥|秘钥|口令|令牌)(\s*[:=：是]?\s*)(?!\[脱敏)[^\s，。；、,;]{4,}/g, keepKeyword: true },
]

/**
 * 长文本分片脱敏（F3）。
 *
 * 在**空白/换行**处切，尽量不把一段 token 切成两半；切不开就硬切。
 * 分片边界处的漏检是可能的（被切开的密钥两半都匹配不上），
 * 但代价是"偶尔漏一条"，而原来是"卡死十几秒"——后者更糟。
 */
function redactChunked(text) {
  const hits = []
  const tally = new Map()
  let out = ''
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + REDACT_CHUNK)
    if (end < text.length) {
      // 往回找一个空白/换行，最多退 512 字符
      const window = text.slice(Math.max(i, end - 512), end)
      const at = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
      if (at > 0) end = Math.max(i, end - 512) + at + 1
    }
    const piece = redactOnce(text.slice(i, end))
    out += piece.text
    for (const h of piece.hits) {
      hits.push(h)
      tally.set(h.kind, (tally.get(h.kind) || 0) + h.count)
    }
    i = end
  }
  return { text: out, hits: [...tally].map(([kind, count]) => ({ kind, count })) }
}

/** 已经脱敏过的标记（幂等：跳过它们再跑一遍不会变） */
const MARK_RE = /\[脱敏:[^\]]+\]/g

const MARKS = '\u0000MARK\u0000'

/**
 * 把一段文本里的敏感信息换成 `[脱敏:手机号]` 这样的标记。
 * @returns {{ text: string, hits: Array<{kind: string, count: number}> }}
 */
/** 单段进正则的最大长度：再长的文本先切片（F3） */
const REDACT_CHUNK = 8 * 1024

export function redactText(input) {
  let text = String(input ?? '')
  if (!text) return { text, hits: [] }
  // F3 第二道闸：不管哪条规则有没有上界，**任何单次正则的输入不超过 8KB**。
  // 这是 Node 官方文档点名的做法（限长 + 限输入），不靠"写一个更聪明的正则"。
  if (text.length > REDACT_CHUNK) return redactChunked(text)
  return redactOnce(text)
}

/** 真正的脱敏实现（单段，≤8KB） */
function redactOnce(text) {

  // 先把已有的标记摘下来，避免二次脱敏把标记本身当敏感内容
  const marks = []
  text = text.replace(MARK_RE, (m) => {
    marks.push(m)
    return MARKS
  })

  const hits = []
  for (const { kind, re, keepKeyword } of SENSITIVE_PATTERNS) {
    let count = 0
    const mark = '[' + '脱敏:' + kind + ']'
    text = text.replace(re, (...args) => {
      count += 1
      // keepKeyword：保留关键词本身（`密码：xxx` → `密码：[脱敏:凭据]`），别把「密码」两个字吞掉
      if (keepKeyword && typeof args[1] === 'string') {
        const kw = args[1]
        const sep = typeof args[2] === 'string' ? args[2] : ''
        return kw + sep + mark
      }
      return mark
    })
    if (count) hits.push({ kind, count })
  }

  // 标记还原（原有标记原样放回；新生成的标记不在 marks 里，不动）
  let i = 0
  text = text.replace(new RegExp(MARKS, 'g'), () => marks[i++] ?? '')
  return { text, hits }
}

/** 有没有敏感信息（不生成结果，只判断） */
export function hasSecret(input) {
  return redactText(input).hits.length > 0
}

/** 脱敏统计的可读一行（给 CLI / audit 用） */
export function hitsSummary(hits) {
  if (!hits || !hits.length) return ''
  return hits.map((h) => `${h.kind}×${h.count}`).join(' · ')
}
