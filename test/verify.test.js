// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifyPackage } from '../lib/verify.js'

function pkg({ bom = false, apply = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fishmem-verify-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/memory.mjs'), '// entry\n')
  writeFileSync(join(root, 'README.md'), '# x\n')
  writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: fish-memory\n      name: dsh-fish-memory\n')
  writeFileSync(join(root, 'lib/host.js'), 'export function attachHost() {}\n')
  writeFileSync(
    join(root, 'lib/index.js'),
    `${apply ? 'export function apply() {}\nexport const name = "x"\nexport const inject = []' : 'export const x = 1'}`,
  )
  const json = JSON.stringify({ name: 'dsh-fish-memory', version: '0.0.0' })
  writeFileSync(join(root, 'package.json'), bom ? '\uFEFF' + json : json)
  return root
}

test('verify：完整包通过', () => {
  const r = verifyPackage(pkg())
  assert.equal(r.ok, true, r.errors.join('; '))
})

test('verify：缺 host.js 也算错（宿主口子层不能悄悄丢）', () => {
  const root = pkg()
  rmSync(join(root, 'lib/host.js'))
  const r = verifyPackage(root)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('lib/host.js')), r.errors.join('; '))
})

test('verify：BOM 与缺 apply 都算错', () => {
  const bom = verifyPackage(pkg({ bom: true }))
  assert.ok(bom.errors.some((e) => e.includes('BOM')), bom.errors.join('; '))

  const na = verifyPackage(pkg({ apply: false }))
  assert.ok(na.errors.some((e) => e.includes('apply')), na.errors.join('; '))
})
