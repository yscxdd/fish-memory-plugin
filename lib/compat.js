// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * compat.js — 版更适配：快照、对比、尸检报告。
 *
 * 设计取自三处成熟做法，各取一条：
 *   - VS Code：`engines.vscode` —— 由**宿主**在装载时判兼容，别等运行到一半才崩。
 *     （我们的对应物在 package.json 的 `engines.dsh`）
 *   - Babel `api.assertVersion`：不负责实现缺失的 API，只负责**给出清楚的错误**。
 *     （我们的对应物是 apply 的整体 try/catch + 尸检报告）
 *   - Neovim `:checkhealth`：检查项分级 ok/warn/error，每条 error 附带建议。
 *     （我们的对应物是 `memory compat` / `hostcheck` 的输出）
 *
 * 本文件只管三件事：
 *   ① 每次加载把"探到的宿主口子"记成快照（只在真的变了的时候写盘）
 *   ② 与上一份快照对比，给出 regressed / recovered / first
 *   ③ apply 抛错时写一份能看的尸检报告（不依赖 ctx，只用 fs）
 *
 * 为什么必须落盘：DSH 不保存主进程日志（rc.5 实测），崩了以后现场是空的。
 * 上一个版本是靠临时手写探针才挖出 `cannot get property "timer" without inject`；
 * 这里把那件事固化成流程，而不是指望下次还记得怎么挖。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const SURFACE_FILE = join('20_state', 'host-surface.json')
export const COMPAT_LOG = join('50_log', 'compat.log')

/**
 * 快照格式版本。**改字段就要 +1**，否则老快照会一直"看起来没变"而不被重写
 * （v0.6.0 就踩过：加了 unprobeable，但因为 found/missing 没变，永远不落盘）。
 */
export const SURFACE_VERSION = 2

/**
 * apply 崩了该往哪儿写尸检报告。
 *
 * 难点：崩的时候记忆库目录还没解析（目录本来就是拿到会话 cwd 才算的）。
 * 所以按"一定能写出来"排序：显式配置 → 环境变量 → 系统临时目录。
 * 临时目录那份是最后兜底——**宁可写到系统临时目录，也不要什么都不留**。
 */
export function autopsyDir(config = {}) {
  const explicit = config?.memoryDir
  if (typeof explicit === 'string' && explicit.trim() && isAbsolute(explicit.trim())) return explicit.trim()
  const env = process.env.FISH_MEMORY_DIR
  if (typeof env === 'string' && isAbsolute(env)) return env
  return join(tmpdir(), 'dsh-fish-memory')
}

/**
 * 启动早期把"服务还没就绪"和"服务真没了"分开。
 *
 * 实测（2026-10-30，DSH 0.2.1-rc.5）：进程刚起来时第一次装配可能读不到
 * `workingDirectory` / `tokenMeter`（它们在树里靠后），于是快照记了一条
 * `surface-regressed`，几十秒后又 `surface-recovered`。**每次重启都误报一次，没人会再信它。**
 *
 * 规则：加载后 GRACE_MS 内，`service-*` 的缺失按下不表（host.log 里仍记原始探测，
 * 只是不进快照、不告警）。过了宽限期还缺，照实报——那才是真的没了。
 *
 * @param {{found?:string[], missing?:string[], requiredMissing?:string[], unprobeable?:string[]}} surface
 * @param {number} msSinceAttach 距加载过了多久
 * @param {number} [graceMs]
 */
export function bootAdjustedSurface(surface, msSinceAttach, graceMs = 60_000) {
  const fresh = Number(msSinceAttach) >= 0 && Number(msSinceAttach) < graceMs
  if (!fresh) return { surface, deferred: [] }
  const deferred = (surface.missing || []).filter((id) => id.startsWith('service-'))
  if (!deferred.length) return { surface, deferred: [] }
  return {
    surface: { ...surface, missing: (surface.missing || []).filter((id) => !id.startsWith('service-')) },
    deferred,
  }
}

function ensureDir(dir, sub) {
  try {
    mkdirSync(join(dir, sub), { recursive: true })
  } catch {
    /* 建不出来就写不了，调用方自己兜 */
  }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 两份快照的差异。**纯函数**，好测。
 *
 * @param {{found?:string[], missing?:string[]}|null} prev 上一次快照（null = 第一次）
 * @param {{found:string[], missing:string[], requiredMissing?:string[]}} next 这次探到的
 * @returns {{kind:'first'|'unchanged'|'regressed'|'recovered'|'mixed', regressed:string[],
 *            recovered:string[], missing:string[], requiredMissing:string[]}}
 */
export function diffSurface(prev, next) {
  const nextMissing = [...(next.missing || [])].sort()
  const nextFound = [...(next.found || [])].sort()
  if (!prev) {
    return { kind: 'first', regressed: [], recovered: [], missing: nextMissing, requiredMissing: next.requiredMissing || [] }
  }
  const prevMissing = new Set(prev.missing || [])
  const prevFound = new Set(prev.found || [])
  const regressed = nextMissing.filter((id) => !prevMissing.has(id))
  const recovered = nextFound.filter((id) => !prevFound.has(id))
  let kind = 'unchanged'
  if (regressed.length && recovered.length) kind = 'mixed'
  else if (regressed.length) kind = 'regressed'
  else if (recovered.length) kind = 'recovered'
  return { kind, regressed, recovered, missing: nextMissing, requiredMissing: next.requiredMissing || [] }
}

/**
 * 记录这次探到的口子；只有真的变了才写盘（避免每轮刷文件）。
 *
 * @param {string} dir 记忆库目录
 * @param {{found:string[], missing:string[], requiredMissing?:string[]}} surface
 * @param {string} [now] ISO 时间（测试可注入）
 */
export function recordSurface(dir, surface, now = new Date().toISOString()) {
  const path = join(dir, SURFACE_FILE)
  const prev = readJson(path)
  const diff = diffSurface(prev, surface)
  // 口子没变、格式也没变 → 不写盘。
  // 格式变了（SURFACE_VERSION）必须重写，否则新字段永远进不了磁盘。
  const sameFormat = prev?.version === SURFACE_VERSION
  if (diff.kind === 'unchanged' && sameFormat) return diff

  const record = {
    version: SURFACE_VERSION,
    at: now,
    found: [...(surface.found || [])].sort(),
    missing: [...(surface.missing || [])].sort(),
    // 静态探不了的那几个（事件名、消息形状）：只能靠跑，但不能在快照里"消失"
    unprobeable: [...(surface.unprobeable || [])].sort(),
    requiredMissing: surface.requiredMissing || [],
    // 留下上一份，方便 `memory compat` 说"比上次少了什么"
    previous: prev ? { at: prev.at, missing: prev.missing || [] } : null,
  }
  try {
    ensureDir(dir, '20_state')
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf8')
  } catch {
    /* 写不了就算了，别因为日志把插件弄崩 */
  }
  return diff
}

/**
 * apply 抛错时的尸检报告：**不依赖 ctx**，只往 50_log/compat.log 追加一条。
 * 报告里带 stack、当时的 surface 探测结果、node 版本——够修 bug，不需要再写探针。
 *
 * @param {string} dir 记忆库目录（可能还没解析出来，那就写不了，返回 null）
 * @param {Error|unknown} error
 * @param {{found?:string[], missing?:string[], requiredMissing?:string[]}} [surface]
 */
export function reportApplyFailure(dir, error, surface) {
  if (!dir) return null
  const entry = {
    at: new Date().toISOString(),
    event: 'apply-failed',
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? String(error.stack || '').split('\n').slice(0, 8).join('\n') : '',
    node: process.versions?.node,
    surface: surface
      ? { found: surface.found || [], missing: surface.missing || [], requiredMissing: surface.requiredMissing || [] }
      : null,
    hint: '先跑 memory compat 看缺了哪个口子；只改 lib/host.js；验收看 50_log/host.log',
  }
  try {
    ensureDir(dir, '50_log')
    appendFileSync(join(dir, COMPAT_LOG), JSON.stringify(entry) + '\n', 'utf8')
    return entry
  } catch {
    return null
  }
}

/**
 * 读最近一次尸检报告与快照，给 `memory compat` 用。
 * @param {string} dir
 */
export function readCompatRecord(dir) {
  const surface = readJson(join(dir, SURFACE_FILE))
  let failures = []
  try {
    const path = join(dir, COMPAT_LOG)
    if (existsSync(path)) {
      failures = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-5)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { at: null, event: 'unparsable', raw: line.slice(0, 200) }
          }
        })
        .filter((e) => e.event === 'apply-failed')
    }
  } catch {
    /* ignore: 探不到就当没有——compat 只做参考，不阻塞 */
  }
  return { surface, failures }
}
