// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 版更适配层（lib/compat.js）与 apply 的保险丝。
 *
 * 这三组测的是**事故之后能不能查出原因**，不是功能：
 *   ① 快照对比：少了/多了/首次/没变，四种结论都要对；
 *   ② 尸检报告：崩了要留 stack + 当时的口子状态，而且不能依赖 ctx；
 *   ③ 保险丝：ctx 是个会抛的 Proxy 时，apply 不许把整个插件拖死，还要留下痕迹。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import {
  COMPAT_LOG,
  SURFACE_FILE,
  autopsyDir,
  bootAdjustedSurface,
  diffSurface,
  readCompatRecord,
  recordSurface,
  reportApplyFailure,
} from '../lib/compat.js'
import { HOST_POINTS } from '../lib/host.js'

const surface = (found, missing = [], requiredMissing = [], unprobeable = []) => ({
  found,
  missing,
  requiredMissing,
  unprobeable,
})

/** 最小可用假 ctx：够 apply 跑完，但没有任何可选服务 */
function fakeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on() {
      return () => {}
    },
    systemPrompt: { context: () => () => {} },
    tools: { register: () => () => {} },
    skills: { register: () => () => {} },
    get: () => undefined,
  }
}

test('快照对比：首次 / 没变 / 少了 / 多了 / 又少又多', () => {
  assert.equal(diffSurface(null, surface(['a', 'b'])).kind, 'first')
  assert.equal(diffSurface(surface(['a', 'b'], []), surface(['b', 'a'], [])).kind, 'unchanged')

  const regressed = diffSurface(surface(['a', 'b'], []), surface(['a'], ['b']))
  assert.equal(regressed.kind, 'regressed')
  assert.deepEqual(regressed.regressed, ['b'])

  const recovered = diffSurface(surface(['a'], ['b']), surface(['a', 'b'], []))
  assert.equal(recovered.kind, 'recovered')
  assert.deepEqual(recovered.recovered, ['b'])

  const mixed = diffSurface(surface(['a'], ['b']), surface(['b'], ['a']))
  assert.equal(mixed.kind, 'mixed')
  assert.deepEqual(mixed.regressed, ['a'])
  assert.deepEqual(mixed.recovered, ['b'])
})

test('recordSurface：变了才写盘，写的时候留上一份，方便下一次说"少了什么"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  const first = recordSurface(dir, surface(['a', 'b']), '2026-10-30T00:00:00.000Z')
  assert.equal(first.kind, 'first')
  const file = join(dir, SURFACE_FILE)
  assert.equal(existsSync(file), true)
  const rec1 = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(rec1.found, ['a', 'b'])
  assert.equal(rec1.previous, null)

  // 没变：不该重写（mtime/内容都不动）
  const before = readFileSync(file, 'utf8')
  const same = recordSurface(dir, surface(['b', 'a']), '2026-10-30T01:00:00.000Z')
  assert.equal(same.kind, 'unchanged')
  assert.equal(readFileSync(file, 'utf8'), before)

  // 少了 a：写新快照，并记住上一份缺什么
  const regressed = recordSurface(dir, surface(['b'], ['a']), '2026-10-30T02:00:00.000Z')
  assert.equal(regressed.kind, 'regressed')
  const rec2 = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(rec2.missing, ['a'])
  assert.equal(rec2.previous.at, '2026-10-30T00:00:00.000Z')
  assert.deepEqual(rec2.previous.missing, [])
})

test('recordSurface：格式版本变了就必须重写（否则新字段永远进不了磁盘）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  // 手写一份"老格式"快照：口子一模一样，但没有 unprobeable 字段
  mkdirSync(join(dir, '20_state'), { recursive: true })
  writeFileSync(
    join(dir, SURFACE_FILE),
    JSON.stringify({ version: 1, at: '2026-10-30T00:00:00.000Z', found: ['a'], missing: [], requiredMissing: [], previous: null }),
    'utf8',
  )
  const diff = recordSurface(dir, surface(['a'], [], [], ['x']), '2026-10-30T03:00:00.000Z')
  assert.equal(diff.kind, 'unchanged', '口子确实没变')
  const rec = JSON.parse(readFileSync(join(dir, SURFACE_FILE), 'utf8'))
  assert.equal(rec.version, 2, '格式要升级')
  assert.deepEqual(rec.unprobeable, ['x'], '新字段要真的落盘')
})

test('启动宽限：service-* 在启动早期算"未就绪"，不算"缺"（否则每次重启误报一次）', () => {
  const fresh = surface(['inject'], ['service-working-directory', 'service-token-meter', 'event-inbox'])
  const early = bootAdjustedSurface(fresh, 3_000)
  assert.deepEqual(early.deferred, ['service-working-directory', 'service-token-meter'])
  assert.deepEqual(early.surface.missing, ['event-inbox'], '非 service 的缺失照实报')

  const late = bootAdjustedSurface(fresh, 120_000)
  assert.deepEqual(late.deferred, [], '过了宽限期就不该再宽容')
  assert.deepEqual(late.surface.missing, ['service-working-directory', 'service-token-meter', 'event-inbox'])

  // 没有 service 缺失时不动对象（常见路径零开销）
  const clean = surface(['inject'], ['event-inbox'])
  assert.equal(bootAdjustedSurface(clean, 1_000).surface, clean)
})

test('尸检报告：有 stack、有当时的口子状态、不依赖 ctx；日志里的坏行不影响读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  recordSurface(dir, surface(['a'], ['b'], ['b']), '2026-10-30T00:00:00.000Z')
  const err = new Error('cannot get property "timer" without inject')
  err.stack = 'Error: cannot get property "timer" without inject\n    at getTarget (cordis/lib/index.js:884)\n    at apply (index.js:24)'
  const entry = reportApplyFailure(dir, err, surface(['a'], ['b'], ['b']))
  assert.ok(entry)
  assert.match(entry.error, /timer/)
  assert.match(entry.stack, /cordis\/lib\/index\.js:884/)
  assert.deepEqual(entry.surface.requiredMissing, ['b'])
  assert.ok(entry.node)
  assert.match(entry.hint, /lib\/host\.js/)

  // 混进一行坏 JSON：读取时跳过，不许整份读不出来
  writeFileSync(join(dir, COMPAT_LOG), readFileSync(join(dir, COMPAT_LOG), 'utf8') + '{坏行\n', 'utf8')
  const rec = readCompatRecord(dir)
  assert.equal(rec.failures.length, 1)
  assert.match(rec.failures[0].error, /timer/)
  assert.ok(rec.surface, '快照要能一起读出来')
  assert.deepEqual(rec.surface.missing, ['b'])
})

test('会抛的 Proxy 当 ctx：退化成"什么都没探到"，但**不该崩**（safeRead 兜住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom: host property exploded')
      },
    },
  )
  assert.doesNotThrow(() => apply(hostile, { memoryDir: dir }))
  // 没崩就没有尸检报告——这是对的：能降级就不要崩
  assert.equal(readCompatRecord(dir).failures.length, 0)
})

test('保险丝：applyInner 真的抛了，也不许把整根 fiber 拖死，且必须留下尸检报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  // 读配置时抛（normalizeConfig 会访问 retrieval）——这类错误在保险丝之外
  const config = {
    memoryDir: dir,
    get retrieval() {
      throw new Error('config exploded while reading retrieval')
    },
  }
  assert.doesNotThrow(() => apply({ ...fakeCtx() }, config))

  const logPath = join(dir, COMPAT_LOG)
  assert.equal(existsSync(logPath), true, '崩了必须留痕')
  const rec = readCompatRecord(dir)
  assert.equal(rec.failures.length, 1)
  assert.match(rec.failures[0].error, /config exploded/)
  assert.ok(rec.failures[0].surface, '报告里要带当时的口子探测结果')
})

test('保险丝不误伤：正常的假 ctx 走完 apply，不写 apply-failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-compat-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  assert.doesNotThrow(() => apply(fakeCtx(), { memoryDir: dir }))
  const rec = readCompatRecord(dir)
  assert.equal(rec.failures.length, 0, '正常装配不该留下尸检报告')
  assert.equal(rec.surface, null, '目录还没解析时不该写快照（快照在建库时写）')
})

test('口子清单与快照长度一致（快照说 17/17 才有意义）', () => {
  const ids = HOST_POINTS.map((p) => p.id)
  assert.equal(ids.length, 17)
  assert.equal(new Set(ids).size, 17)
})
