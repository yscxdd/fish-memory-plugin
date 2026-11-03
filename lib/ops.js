// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 运维类不入库（v0.37.0）——借自《AI伙伴运行机制》的写入判据。
 *
 * 他们的原话：*"不进运维类（进程挂了、端口不通）、临时状态、工具的调用细节。
 * 这些东西记进去只会淹掉真正重要的东西。"*
 *
 * 我们靠人审挡了一部分，但她完全可能把"插件报错了"写成一条 event。
 * 这里给一个**便宜的检测**：命中就在 `check` 里提醒、在 `audit` 里计数——
 * **只提醒，不拦截**（这是风格问题，不是错误）。
 */

export const OPS_PATTERNS = [
  { kind: '报错', re: /(报错|错误|异常|堆栈|stack ?trace|Error:|EADDRINUSE|ECONNREFUSED|ENOENT|ETIMEDOUT)/i },
  { kind: '进程', re: /(进程|pid\s*\d+|重启|崩溃|挂掉|挂了|卡死|oom|内存溢出)/i },
  { kind: '端口/网络', re: /(端口|port\s*\d+|连接超时|超时|timeout|断线|掉线|502|503|504)/i },
  { kind: '构建/部署', re: /(编译|构建|打包|部署|上线|回滚|升级到|降级到|install|npm |pnpm |git pull|diff|commit)/i },
  { kind: '日志/配置', re: /(日志|log\s*文件|配置项|config|环境变量|\.env|路径|目录不存在)/i },
]

/** 这段文字像不像运维记录？返回命中的类别（空数组 = 不像） */
export function opsKinds(text) {
  const t = String(text || '')
  if (!t.trim()) return []
  return OPS_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.kind)
}

/** 像不像（有命中就算） */
export function looksLikeOps(text) {
  return opsKinds(text).length > 0
}
