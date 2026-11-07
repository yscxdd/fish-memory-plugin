// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * lock.js — 跨进程写锁（插件进程 vs CLI）。
 *
 * 场景：会话进行中你跑 `memory index` / `ingest`，两边同时写
 * 20_state/state.json、retrieval.json、20_index/*。进程内队列管不到另一个进程。
 *
 * 做法：20_state/.lock 用 `wx` 原子创建；拿不到就等（Atomics.wait 同步睡）。
 *
 * **A7（v0.72.0）**：原来"3s 等不到就放弃 + 30s 判残留"。
 * 大库上 `redact --apply` / `promote` / `ingest` 完全可能跑 >30s，
 * 于是另一个进程判"残留"直接抢锁，**两边同时写**。
 * 现在：等 10s；残留阈值 5 分钟；长操作每 10s `utimes` 续租（心跳）。
 * 抢锁失败也会留一行日志（以前只活在调用方的 catch 里）。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 这个 pid 还在跑吗？（EPERM 也算活着：那是别人的进程，不能碰） */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

export const LOCK_WAIT_MS = 10_000
export const LOCK_STALE_MS = 5 * 60_000
export const LOCK_HEARTBEAT_MS = 10_000

export function withLock(dir, fn, { timeoutMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
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
        // A7（v0.72.0）：先看"锁的主人还活着吗"。
        // 长操作（redact --apply / promote / ingest）是同步 CPU 活，定时器根本不会跑，
        // 所以"心跳 + 年龄"救不了它——那时**活着就是活着**，mtime 再旧也不能抢。
        const holder = Number(String(readFileSync(file, 'utf8')).split(/\s+/)[0])
        const alive = holder > 0 && pidAlive(holder)
        if (!alive && Date.now() - statSync(file).mtimeMs > staleMs) {
          unlinkSync(file)
          continue
        }
      } catch {
        /* 锁刚被释放，重试 */
      }
      if (Date.now() - start > timeoutMs) {
        // A7：失败要留痕（调用方多半只 `catch { warn }`，等于没人知道）
        try {
          mkdirSync(join(dir, '50_log'), { recursive: true })
          appendFileSync(
            join(dir, '50_log', 'lock.log'),
            `${JSON.stringify({ at: new Date().toISOString(), event: 'timeout', waitedMs: Date.now() - start, pid: process.pid })}\n`,
            'utf8',
          )
        } catch {
          /* 日志写不上不影响抛错 */
        }
        throw new Error(`记忆库写锁超时：${file}（等了 ${Date.now() - start}ms）`)
      }
      sleep(25)
    }
  }
  let beat = null
  try {
    // 心跳：长操作期间刷新 mtime，别让别的进程把"还在干活"误判成"残留"
    if (heartbeatMs > 0) {
      beat = setInterval(() => {
        try {
          const now = new Date()
          utimesSync(file, now, now)
        } catch {
          /* 锁已经被别人接走，心跳失败无所谓 */
        }
      }, heartbeatMs)
      if (typeof beat.unref === 'function') beat.unref()
    }
    return fn()
  } finally {
    if (beat) clearInterval(beat)
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
