// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 隐私体检（v0.9.0）：这套库会不会被 git 带走。
 *
 * 三条边界要守住：
 *   ① 探测要认得出 `.git` 在上层（而不是只在库自己身上找）；
 *   ② 忽略判定要认常见写法（裸名字、带尾斜杠、带前导斜杠、通配前缀），
 *      但**不能被 `!fish-memory` 这种反忽略骗过**；
 *   ③ `--write` 只**追加**一个带标记的块，不动别人原有的行，且幂等。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BLOCK_BEGIN, findGitRoot, privacyReport, writeGitignoreBlock } from '../lib/privacy.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

/** 造一个仓库：repo/fish-memory + repo/fish-memory-backups */
function seedRepo({ gitignore } = {}) {
  const repo = tmp('fishmem-repo-')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'fish-memory'), { recursive: true })
  mkdirSync(join(repo, 'fish-memory-backups', 'fish-memory-2026-10-30'), { recursive: true })
  if (gitignore !== undefined) writeFileSync(join(repo, '.gitignore'), gitignore, 'utf8')
  return repo
}

test('findGitRoot：从库目录往上找到仓库根', () => {
  const repo = seedRepo()
  assert.equal(findGitRoot(join(repo, 'fish-memory')), repo)
  const outside = tmp('fishmem-nogit-')
  assert.equal(findGitRoot(outside), null)
})

test('privacyReport：没被忽略 → 两条风险都报出来', () => {
  const repo = seedRepo({ gitignore: 'node_modules/\n' })
  const r = privacyReport(join(repo, 'fish-memory'))
  assert.equal(r.repo, repo)
  assert.equal(r.memoryIgnored, false)
  assert.equal(r.backupIgnored, false)
  assert.equal(r.risks.length, 2)
  assert.ok(r.risks.some((x) => x.includes('备份')))
  assert.ok(r.advice.some((a) => a.includes('--write')))
})

test('privacyReport：认得几种常见写法（含带斜杠与前缀斜杠）', () => {
  for (const line of ['fish-memory', 'fish-memory/', '/fish-memory', '**/fish-memory', 'fish-memory-backups/']) {
    const repo = seedRepo({ gitignore: `${line}\n` })
    const r = privacyReport(join(repo, 'fish-memory'))
    assert.equal(r.memoryIgnored || r.backupIgnored, true, `应认出：${line}`)
  }
})

test('privacyReport：`!fish-memory` 是反忽略，不能当成已覆盖', () => {
  const repo = seedRepo({ gitignore: '!fish-memory\n!fish-memory-backups\n' })
  const r = privacyReport(join(repo, 'fish-memory'))
  assert.equal(r.memoryIgnored, false)
  assert.equal(r.backupIgnored, false)
  assert.equal(r.risks.length, 2)
})

test('privacyReport：库内自带 .gitignore 也算覆盖；不在仓库里则无风险', () => {
  const repo = seedRepo({ gitignore: '' })
  writeFileSync(join(repo, 'fish-memory', '.gitignore'), '*\n', 'utf8')
  const r = privacyReport(join(repo, 'fish-memory'))
  assert.equal(r.localGitignore, true)
  assert.equal(r.memoryIgnored, true)

  const lonely = tmp('fishmem-nogit-')
  mkdirSync(join(lonely, 'fish-memory'), { recursive: true })
  const plain = privacyReport(join(lonely, 'fish-memory'))
  assert.equal(plain.repo, null)
  assert.deepEqual(plain.risks, [])
})

test('writeGitignoreBlock：追加带标记的块，原有内容一个字不动', () => {
  const repo = seedRepo({ gitignore: 'node_modules/\n*.log\n' })
  const r = writeGitignoreBlock(repo, { memoryName: 'fish-memory', backupName: 'fish-memory-backups' })
  assert.equal(r.changed, true)
  const text = readFileSync(join(repo, '.gitignore'), 'utf8')
  assert.ok(text.startsWith('node_modules/\n*.log\n'), '原有内容必须在最前面、原样')
  assert.ok(text.includes(BLOCK_BEGIN))
  assert.match(text, /^fish-memory\/$/m)
  assert.match(text, /^fish-memory-backups\/$/m)
})

test('writeGitignoreBlock：幂等——第二次不重复追加', () => {
  const repo = seedRepo({ gitignore: '' })
  const first = writeGitignoreBlock(repo)
  assert.equal(first.changed, true)
  const before = readFileSync(join(repo, '.gitignore'), 'utf8')
  const second = writeGitignoreBlock(repo)
  assert.equal(second.changed, false)
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), before)
})

test('writeGitignoreBlock：没有 .gitignore 时新建；目录不可写时返回原因而不是抛', () => {
  const repo = seedRepo()
  assert.equal(existsSync(join(repo, '.gitignore')), false)
  const r = writeGitignoreBlock(repo)
  assert.equal(r.changed, true)
  assert.equal(existsSync(join(repo, '.gitignore')), true)

  const bad = writeGitignoreBlock(join(repo, 'no-such-dir'))
  assert.equal(bad.changed, false)
  assert.ok(bad.reason)
})

test('写完再体检：风险清零', () => {
  const repo = seedRepo({ gitignore: '' })
  writeGitignoreBlock(repo)
  const r = privacyReport(join(repo, 'fish-memory'))
  assert.deepEqual(r.risks, [])
  assert.equal(r.memoryIgnored, true)
  assert.equal(r.backupIgnored, true)
})
