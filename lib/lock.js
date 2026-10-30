// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * lock.js — 跨进程写锁（插件进程 vs CLI）。
 *
 * 场景：会话进行中你跑 `memory index` / `ingest`，两边同时写
 * 20_state/state.json、retrieval.json、20_index/*。进程内队列管不到另一个进程。
 *
 * 做法：20_state/.lock 用 `wx` 原子创建；拿不到就等（Atomics.wait 同步睡），
 * 超时 3s 放弃；锁文件超过 30s 视为残留，可抢。
 */

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function withLock(dir, fn, { timeoutMs = 3000, staleMs = 30_000 } = {}) {
  mkdirSync(join(dir, '20_state'), { recursive: true })
  const file = join(dir, '20_state', '.lock')
  const start = Date.now()
  let fd = null
  while (fd === null) {
    try {
      fd = openSync(file, 'wx')
      writeSync(fd, `${process.pid} ${Date.now()}`)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) {
          unlinkSync(file)
          continue
        }
      } catch {
        /* 锁刚被释放，重试 */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`记忆库写锁超时：${file}`)
      sleep(25)
    }
  }
  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore: 释锁失败就算了，stale 锁会被超时接管 */
    }
    try {
      unlinkSync(file)
    } catch {
      /* ignore: 删锁文件失败也无妨，stale 会被超时接管 */
    }
  }
}
