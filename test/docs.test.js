// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 文档不腐（v0.26.1）：这些"说明"是给人看的，但一旦落后于代码就会误导人。
 *
 * 以前踩过：清单写着 227 测试、契约写着"来源只有 msg_id"，代码早变了。
 * 这个文件只做一件事——**把关键说法钉成断言**，改代码忘了改文档就会红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initMemory } from '../lib/scaffold.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('技能里写了"每月写自述 → 提修订"的完整链路', () => {
  const src = read('lib/index.js')
  assert.match(src, /每月一次：写自述/, '技能要有自述小节')
  assert.match(src, /self-draft/, '要有 self-draft')
  assert.match(src, /self-promote/, '要有 self-promote')
  assert.match(src, /soul propose/, '要有 soul propose')
  assert.match(src, /soul apply/, '要有 soul apply')
  assert.match(src, /15%/, '要写清漂移阈值')
  assert.match(src, /20%/, '要写清单次上限')
  assert.match(src, /锁定小节/, '要写清锁定区')
  assert.match(src, /pin: soft/, '书评要用 pin: soft')
  assert.match(src, /不要用 `key: true`/, '要明确不要用 key')
})

test('init 生成的 MEMORY.md 里有"她怎么变"那张表与流程', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-docs-'))
  const { dir: lib } = initMemory(join(dir, 'fish-memory'))
  const mem = readFileSync(join(lib, 'MEMORY.md'), 'utf8')
  assert.match(mem, /她怎么变/)
  assert.match(mem, /气质（底线）/)
  assert.match(mem, /叙事/)
  assert.match(mem, /soul propose/)
  assert.match(mem, /soul apply/)
  assert.match(mem, /15_self\//)
  assert.match(mem, /锁定小节/)
})

test('README 的功能表提到素材源与 stats；版本号与 package.json 一致', () => {
  const readme = read('README.md')
  assert.match(readme, /素材源/)
  assert.match(readme, /memory stats/)
  const pkg = JSON.parse(read('package.json'))
  assert.ok(readme.includes(pkg.version), `README 标题要带 v${pkg.version}`)
  assert.ok(readme.includes(`${pkg.version}`), 'README 里要有当前版本号')
})

test('契约里三条硬说法与代码一致', (t) => {
  // v0.74.0（A13）：契约已经随插件发布（docs/CONTRACT-v1.0-plugin-interface.md）。
  // 以前它在工作区外，于是这一条**每次发布都 skip**——测不到等于没测。
  const url = new URL('../docs/CONTRACT-v1.0-plugin-interface.md', import.meta.url)
  let contract = ''
  try {
    contract = readFileSync(url, 'utf8')
  } catch {
    // 它现在就在仓库里：读不到 = 真的坏了，不许 skip
    assert.fail('契约文件读不到：docs/CONTRACT-v1.0-plugin-interface.md')
  }
  assert.match(contract, /7\.5\.1 人格修订提案/, '契约要有 §7.5.1')
  assert.match(contract, /pin: hard/, '契约要写 pin 两档')
  assert.match(contract, /asset:<kind>:<id>/, '契约要写素材源形态')
})
