// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 可见性 + 跨轮去重（v0.61.0，A + B）。
 *
 * A：v0.58 只做了"这条记忆属于谁"（scope）；这一层补"属于这里的东西，
 *    能不能在这个场合说出来"——private 在群里只给索引行（暗示），secret 连标题都不给。
 * B：人在意的第一个毛病不是"忘"，是"怎么又提这件事"。
 *
 * 钉住：
 *   ① secret 在群里硬过滤，私聊不受影响；
 *   ② private 在群里降级成索引行（**不含摘要**）——"能提一句、不能复述"；
 *   ③ 缺省 private（宁可少说一句）；
 *   ④ 跨轮去重：10 轮内不重复，第 11 轮回来；窗口 0 = 关闭；
 *   ⑤ 被挡掉要留日志口径（skipped / remaining）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_VISIBILITY,
  hintOnly,
  normalizeVisibility,
  survivesInGroup,
  visibilityOf,
} from '../lib/visibility.js'
import { filterRecentlyShown, noteShown, resetShown, shownFor } from '../lib/injected.js'
import { layoutBody } from '../lib/render.js'

const group = 'group:123'
const dm = 'dm:master'

test('A：secret 在群里硬过滤，在私聊里照常', () => {
  const p = { id: 'P1', visibility: 'secret', salience: 3, title: '私事' }
  assert.equal(survivesInGroup(p, group), false)
  assert.equal(survivesInGroup(p, dm), true)
})

test('A：public / private 在群里都留得住（区别在降级，不在出现）', () => {
  assert.equal(survivesInGroup({ visibility: 'public' }, group), true)
  assert.equal(survivesInGroup({ visibility: 'private' }, group), true)
})

test('A：private 在群里只给暗示，public 不受限', () => {
  assert.equal(hintOnly({ visibility: 'private' }, group), true)
  assert.equal(hintOnly({ visibility: 'public' }, group), false)
  assert.equal(hintOnly({ visibility: 'private' }, dm), false, '私聊不该被降级')
})

test('A：缺省是 private（宁可少说一句），写错值不认', () => {
  assert.equal(visibilityOf({}), DEFAULT_VISIBILITY)
  assert.equal(DEFAULT_VISIBILITY, 'private')
  assert.equal(normalizeVisibility('weird'), null)
  assert.equal(visibilityOf({ visibility: 'weird' }), 'private', '坏值按缺省处理，不抛')
})

test('A：被标 _hintOnly 的点渲染成索引行（不含摘要）', () => {
  const p = {
    id: 'P1',
    title: '他怕被丢下',
    summary: '他说过最怕被丢下，所以一直不敢先挂电话',
    salience: 5,
    date: '2026-11-05',
    _hintOnly: true,
  }
  const r = layoutBody([p], { budget: 300 })
  assert.ok(r.text.includes('他怕被丢下'), '标题要在（这是"暗示"的载体）')
  assert.ok(!r.text.includes('不敢先挂电话'), `摘要不能出现，实际：${r.text}`)
})

test('B：10 轮内不重复，第 11 轮回来', () => {
  resetShown()
  const point = { id: 'P1' }
  noteShown('s1', 1, [point])

  assert.equal(filterRecentlyShown('s1', 2, [point], 10).kept.length, 0, '第 2 轮该挡')
  assert.equal(filterRecentlyShown('s1', 10, [point], 10).kept.length, 0, '第 10 轮还在窗口内')
  assert.equal(filterRecentlyShown('s1', 11, [point], 10).kept.length, 1, '第 11 轮该回来')
})

test('B：不同会话各算各的（A 会话讲过，不影响 B 会话）', () => {
  resetShown()
  noteShown('sA', 1, [{ id: 'P1' }])
  assert.equal(filterRecentlyShown('sB', 2, [{ id: 'P1' }], 10).kept.length, 1)
})

test('B：窗口 0 = 关闭（不许静默改成默认值）', () => {
  resetShown()
  noteShown('s1', 1, [{ id: 'P1' }])
  assert.equal(filterRecentlyShown('s1', 2, [{ id: 'P1' }], 0).kept.length, 1)
})

test('B：被挡掉要能被数出来（skipped 计数）', () => {
  resetShown()
  noteShown('s1', 1, [{ id: 'P1' }, { id: 'P2' }])
  const r = filterRecentlyShown('s1', 2, [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }], 10)
  assert.equal(r.kept.length, 1)
  assert.equal(r.skipped, 2)
})

test('B：noteShown 会记下轮次（审计要能查"上次讲是哪一轮"）', () => {
  resetShown()
  noteShown('s1', 7, [{ id: 'P1' }])
  const m = shownFor('s1')
  assert.equal([...m.values()][0], 7)
})
