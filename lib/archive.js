// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * archive.js — 档案层：只追加、可溯源、幂等。
 *
 * 取数方式（v0.2 实测，取代契约 §14 的旧结论）：
 *   她的回复不在 `agent.frozenMessages` 里——那是 WeakSet 冻结标记，不是消息数组。
 *   正确来源是宿主顶层事件 `session/event`：
 *     - `user/message`      data = message
 *     - `assistant/message` data = { message, turn, step, ... }
 *   每条都带 `seq`（会话内单调递增），用它做幂等键比平台 msgid 更强。
 *
 * ⚠️ 本文件是**数据形状**（不是方法名）的集中处：宿主改消息结构时改这里。
 *    两个标记：[HOST: data-event-shape]（事件长什么样）、[HOST: data-message-shape]（消息长什么样）。
 *    症状最阴的一类：不报错、不崩，只是把宿主上下文当成他说的话记进档案。
 *
 * 不变量（契约 §11）：
 *   ① 档案只追加，从不改写
 *   ③ 同一个 seq 只入库一次
 *   ⑦ 原话逐字（这里存原文，不改写）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, localDay, readJsonSafe, sha8 } from './util.js'

const KEEP_TYPES = new Set(['user/message', 'assistant/message'])
// [HOST: data-message-shape] 只收「真的来自人」与「真的来自模型」的消息。
// 宿主还会往同一条通道里塞 time-context / runtime-context / user-approval /
// system-prompt 之类的合成消息——把它们当对话记下来，她会以为自己说过。
// 版更后新增的 source.kind 取值会**静默丢消息**（宁可丢，别记错）；加白名单要在这里改。
const ALLOWED_SOURCES = {
  user: new Set(['user']),
  assistant: new Set(['model']),
}

/**
 * 从消息的 content 块里取文字；旁白/工具调用不算「她说的话」
 * [HOST: data-message-shape] 认得三种：message.text（字符串）、content 是字符串、content 是块数组。
 * 块类型目前只认 text / image / image-url；新增块类型会静默丢内容。
 */
export function extractText(message) {
  if (!message) return ''
  if (typeof message.text === 'string') return message.text
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') {
      out.push(block)
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'image' || block.type === 'image-url') out.push('[图片]')
  }
  return out.join('\n').trim()
}

function messageOf(event) {
  // [HOST: data-event-shape] 两种事件的消息放的位置不一样
  if (!event || !event.data) return null
  if (event.type === 'user/message') return event.data
  if (event.type === 'assistant/message') return event.data.message || null
  return null
}

function isAppend(event) {
  // [HOST: data-event-shape] surfaceOp 缺省按 append 算（旧版本没有这个字段）
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/**
 * 这条事件值不值得进档案 / 进工作记忆。
 * 档案与 session tail 必须用同一个判据，否则 tail 里会混进
 * "Time sampled while preparing turn 4" 这种宿主上下文。
 */
export function isArchivable(event) {
  if (!event || !KEEP_TYPES.has(event.type) || !isAppend(event)) return false
  const msg = messageOf(event)
  if (!msg) return false
  const role = event.type === 'assistant/message' ? 'assistant' : 'user'
  return ALLOWED_SOURCES[role].has(String(msg.source?.kind || 'unknown'))
}

/** 事件 → 档案记录；不该入库的返回 null
 *  [HOST: data-event-shape] 这里用到的字段：event.seq / time / surfaceOp / data.{turn,step}、msg.id
 */
export function buildRecord(sessionId, event, now = new Date()) {
  if (!sessionId || !isArchivable(event)) return null
  const msg = messageOf(event)
  if (!msg || typeof msg.id !== 'string' || !msg.id) return null
  const role = event.type === 'assistant/message' ? 'assistant' : 'user'
  const sourceKind = String(msg.source?.kind || 'unknown')
  const text = extractText(msg)
  if (!text) return null

  const time = Number.isFinite(event.time) ? event.time : now.getTime()
  return {
    id: `msg-${event.seq}-${msg.id.slice(-6)}`,
    seq: Number(event.seq),
    prev: 'genesis',
    hash: '',
    ts: new Date(time).toISOString(),
    recorded_at: now.toISOString(),
    role,
    source_kind: sourceKind,
    text,
    session: String(sessionId),
    msgid_plat: msg.id,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    part: '1/1',
    reply_to: null,
    recalled: false,
    backfilled: false,
  }
}

/** 记录摘要（hash 覆盖这六项，顺序固定） */
export function hashOf(rec) {
  return sha8([rec.seq, rec.session, rec.role, rec.ts, rec.msgid_plat, rec.text].join('\u0000'))
}

function dayFileOf(dir, rec) {
  const d = localDay(new Date(rec.ts))
  return join(dir, '10_archive', 'messages', `${d}.jsonl`)
}

/**
 * 校验一段记录。
 *
 * 两个不变量，作用域不同，别混：
 *   - prev/hash 链是**文件级**的（同一份 .jsonl 里前后相接，跨会话也接得上）
 *   - seq 单调是**会话级**的（seq 由宿主按会话发，两个会话在同一天交错写，
 *     文件里就会出现 4172 → 9 这种"回退"——那不是坏数据）
 *
 * v0.4.3 之前这里把 seq 当文件级校验，于是每开一个新会话，
 * 下次启动就会误报「档案链自检失败：seq 不递增」。
 * 旧版档案（没有 seq / hash）只作为锚点前缀跳过，不判定为坏。
 */
export function verifyChain(records) {
  const valid = (records || []).filter((r) => r && typeof r === 'object' && Number.isFinite(r.seq))
  if (!valid.length) return { ok: true, count: 0, legacy: true }
  let prev = null
  const lastSeqOf = new Map() // session -> 已见过的最大 seq
  for (let i = 0; i < valid.length; i++) {
    const r = valid[i]
    const sid = String(r.session || '')
    const lastSeq = lastSeqOf.get(sid)
    if (lastSeq !== undefined && r.seq <= lastSeq) {
      return { ok: false, at: i, reason: `同一会话内 seq 不递增（${sid}）` }
    }
    const h = hashOf(r)
    if (r.hash && r.hash !== h) return { ok: false, at: i, reason: 'hash 对不上' }
    if (i > 0 && (r.prev || 'genesis') !== prev) return { ok: false, at: i, reason: 'prev 对不上' }
    prev = r.hash || h
    lastSeqOf.set(sid, r.seq)
  }
  return { ok: true, count: valid.length }
}

export class ArchiveWriter {
  constructor(dir, { logger, now = () => new Date() } = {}) {
    this.dir = dir
    this.logger = logger
    this.now = now
    this.queue = Promise.resolve()
    this.cursorFile = join(dir, '20_state', 'cursors.json')
    const raw = readJsonSafe(this.cursorFile, null)
    this.cursors = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
      ? { version: 1, sessions: { ...raw.sessions } }
      : { version: 1, sessions: {} }
    this.chain = new Map() // dayFile -> { hash, seq, id }
    this._sizes = new Map() // dayFile -> 我们上次写完之后的大小（V5 竞态检测）
    this.writes = 0
    this.races = 0
  }

  /** 上一个会话里已入档的最大 seq；-1 表示没有 */
  cursorOf(sessionId) {
    const v = this.cursors.sessions[sessionId]
    return Number.isFinite(v) ? v : -1
  }

  /** 单写者队列（契约 §6.1） */
  handle(sessionId, event) {
    const rec = buildRecord(sessionId, event, this.now())
    if (!rec) return Promise.resolve(false)
    if (rec.seq <= this.cursorOf(sessionId)) return Promise.resolve(false)
    this.queue = this.queue.then(() => this._append(rec)).catch((e) => {
      this.logger?.warn?.(`fish-memory: archive failed: ${e?.message || e}`)
      return false
    })
    return this.queue
  }

  _append(rec) {
    // 队列里可能排着同一 seq 的两次投递：进队列后再判一次，否则会写两行
    if (rec.seq <= this.cursorOf(rec.session)) return false
    const file = dayFileOf(this.dir, rec)
    mkdirSync(join(this.dir, '10_archive', 'messages'), { recursive: true })

    // V5（v0.10.0）：跨进程没锁。写之前看一眼文件大小有没有在我们背后变过——
    // 变了说明另一个窗口（或手工编辑）动过它，缓存的链头已经不可信：
    // **丢掉缓存重读一次**，把 prev 接到真实的最后一条上（自愈），并留一条日志。
    const sizeNow = existsSync(file) ? statSync(file).size : 0
    const expected = this._sizes.get(file)
    if (expected !== undefined && sizeNow !== expected) {
      this.chain.delete(file)
      this.races += 1
      const line = `${new Date().toISOString()} ${file} 期望 ${expected}B 实际 ${sizeNow}B`
      this.logger?.warn?.(`fish-memory: 档案被别的进程改过，已重读链头：${file}`)
      try {
        appendFileSync(join(this.dir, '50_log', 'archive-race.log'), JSON.stringify({ at: new Date().toISOString(), file, expected, actual: sizeNow, pid: process.pid }) + '\n', 'utf8')
      } catch {
        /* 日志失败不影响写入 */
      }
      void line
    }

    const last = this._chainOf(file)
    // 崩溃窗口去重：上一行就是同一条，不再写
    if (last && last.id === rec.id && last.seq === rec.seq) {
      this._advance(rec.session, rec.seq)
      this._sizes.set(file, sizeNow)
      return false
    }

    rec.prev = last?.hash || 'genesis'
    rec.hash = hashOf(rec)
    appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
    this.chain.set(file, { hash: rec.hash, seq: rec.seq, id: rec.id })
    try {
      this._sizes.set(file, statSync(file).size)
    } catch {
      /* 拿不到大小就算了，下次会当成"变过"重读一次，代价可接受 */
    }
    this._advance(rec.session, rec.seq)
    this.writes += 1
    return true
  }

  _advance(sessionId, seq) {
    this.cursors.sessions[sessionId] = seq
    // 游标必须立即落盘：它是幂等的唯一依据
    atomicWriteJson(this.cursorFile, this.cursors)
  }

  _chainOf(file) {
    if (this.chain.has(file)) return this.chain.get(file)
    if (!existsSync(file)) {
      this.chain.set(file, null)
      return null
    }
    try {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      // 旧版记录没有 hash：用内容摘要补上，保证新记录能接在它后面
      const value = last ? { hash: last.hash || hashOf(last), seq: last.seq, id: last.id } : null
      this.chain.set(file, value)
      return value
    } catch {
      return null
    }
  }

  /** 启动自检：最近 n 条 seq 严格递增、hash 链对得上（契约 §5.1 启动校验） */
  verifyLatest(n = 100) {
    const dir = join(this.dir, '10_archive', 'messages')
    if (!existsSync(dir)) return { ok: true, count: 0 }
    try {
      const names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
      if (!names.length) return { ok: true, count: 0 }
      const file = join(dir, names[names.length - 1])
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n)
      const records = []
      for (const line of lines) {
        try {
          records.push(JSON.parse(line))
        } catch {
          return { ok: false, count: records.length, reason: '最后一段有坏行' }
        }
      }
      return verifyChain(records)
    } catch (e) {
      return { ok: false, count: 0, reason: String(e?.message || e) }
    }
  }

  /** 测试与 dispose 用：等队列排空 */
  async idle() {
    await this.queue
  }
}
