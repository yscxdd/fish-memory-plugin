// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * envcheck.js — selfcheck 里那两条"环境一致性"闸门的判据。
 *
 * 为什么单独抽出来：v0.15.0 之前它们是写死在 selfcheck.mjs 里的两个分支，
 * 而且都**判不出失败**——
 *   - `版本一致`：`add(..., true, ...)` 结论写死 true，两个版本号不一致也打 ✓；
 *   - `运行时版本`：只在 level:'warn' 上报告，不计入失败，于是"磁盘 0.15.0、
 *     进程 0.14.1"仍然输出「✓ 所有闸门通过」、退出码 0。
 * 而「改了 lib/ 没重启」正是这个项目反复栽的那个坑。
 *
 * 抽成纯函数有两个好处：能单测，且 selfcheck 只负责打印。
 */

/** 版本号只留数字段，容忍 `v0.15.0` / `0.15.0-rc.1` 这类写法 */
export function normalizeVersion(v) {
  return String(v ?? '').trim().replace(/^v/i, '')
}

/**
 * 源码版本 vs profile 里装的版本。
 *
 * - 没设 DSH_PROFILE_DIR（或 profile 里没有这个包）→ 跳过，不算失败
 * - 两个都有且相同 → 过
 * - 两个都有但不同 → **失败**（不是提醒）：装的那份不是这份代码
 *
 * @returns {{ok:boolean, level:'fail'|'warn', detail:string, skipped:boolean}}
 */
export function versionGate({ pkgVersion, installedVersion, checked }) {
  const src = normalizeVersion(pkgVersion)
  const inst = normalizeVersion(installedVersion)
  if (!checked) {
    return {
      ok: true,
      level: 'warn',
      skipped: true,
      detail: `源码 v${src} · profile ${inst || '未找到'}（未设 DSH_PROFILE_DIR，跳过比对）`,
    }
  }
  if (!inst) {
    return { ok: false, level: 'fail', skipped: false, detail: `源码 v${src} · profile 里找不到这个包` }
  }
  if (src === inst) return { ok: true, level: 'fail', skipped: false, detail: `源码 v${src} · profile v${inst}` }
  return {
    ok: false,
    level: 'fail',
    skipped: false,
    detail: `源码 v${src} · profile v${inst} → 跑 scripts/sync.mjs 再关/开插件`,
  }
}

/**
 * 磁盘上的 lib/ 指纹 vs 进程启动时记下的 lib/ 指纹。
 *
 * 指纹一致 = 进程跑的就是磁盘这份代码；不一致 = 改了没重启，**失败**。
 * 版本号只作参考：只 bump 版本不动 lib/ 时，代码其实没变。
 *
 * @returns {{ok:boolean, level:'fail'|'warn', detail:string, skipped:boolean}}
 */
export function runtimeGate({ liveLib, localLib, liveVersion, diskVersion }) {
  if (!liveLib) {
    if (liveVersion !== null && liveVersion !== undefined) {
      return {
        ok: true,
        level: 'warn',
        skipped: false,
        detail: `进程 v${liveVersion}，启动记录没有 lib 指纹（v0.13.2 之前）`,
      }
    }
    return { ok: true, level: 'warn', skipped: false, detail: 'host.log 里没有版本字段（v0.13.1 之前的启动记录）' }
  }
  if (liveLib === localLib) {
    return {
      ok: true,
      level: 'fail',
      skipped: false,
      detail: `进程里的 lib 与磁盘一致（lib ${localLib}，进程 v${liveVersion ?? '?'}）`,
    }
  }
  return {
    ok: false,
    level: 'fail',
    skipped: false,
    detail: `进程 lib ${liveLib}（v${liveVersion ?? '?'}）· 磁盘 lib ${localLib}（v${normalizeVersion(diskVersion)}）→ 关/开一次插件才生效`,
  }
}
