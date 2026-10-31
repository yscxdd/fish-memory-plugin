// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * sync.mjs — 把源码同步到 profile 的安装副本。
 *
 * 为什么不直接 link：链接后插件改动会立刻进宿主进程的模块缓存，
 * 但 DSH 只在启动时加载 bundle；拷贝一份反而更接近真实安装形态。
 *
 * 用法：
 *   node scripts/sync.mjs [profileDir]
 * profileDir 默认取 $env:DSH_PROFILE_DIR，再退回 ~/.dsh/profiles/desktop
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const profile = resolve(
  process.argv[2] ||
    process.env.DSH_PROFILE_DIR ||
    join(homedir(), '.dsh', 'profiles', 'desktop'),
)

const target = join(profile, 'node_modules', 'dsh-fish-memory')
if (!existsSync(profile)) {
  console.error(`profile 不存在：${profile}`)
  process.exit(1)
}

// 已经用 `link:` 装进 profile 时，target 是指回源码的符号链接/junction：
// 这时候再 cp 就是"把源码拷到自己身上"，Node 会直接报 ERR_FS_CP_EINVAL。
// 用 lstat（不是 stat——stat 会跟到链接目标，看到的永远是普通目录）。
if (existsSync(target)) {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      console.log(`${target} 是符号链接（link: 安装），源码即安装，不需要 sync。`)
      console.log('改了代码 → 完全退出 DSH 再打开即可；要改回拷贝安装，先删掉这个链接。')
      process.exit(0)
    }
  } catch {
    /* 拿不到状态就按老流程走 */
  }
}

mkdirSync(target, { recursive: true })
for (const file of ['package.json', 'cordis.patch.yml']) {
  cpSync(join(pkgRoot, file), join(target, file))
}
cpSync(join(pkgRoot, 'lib'), join(target, 'lib'), { recursive: true })

const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
console.log(`已同步 ${installed.name}@${installed.version} → ${target}`)
console.log('完全退出 DSH 再打开，插件才会重新加载。')
