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

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appendLog } from './logfile.js'
import { atomicWriteJson, atomicWriteText as writeUtf8, localDay, readJsonSafe, sha8 } from './util.js'
import { redactText } from './redact.js'
import { looksLikeWork } from './textkind.js'
import { noteArchived } from './tidy.js'

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
// v0.66.0（E2）：会话当时是什么模式。
// 用一张登记表而不是 import store —— archive 是真相层，不该依赖上层状态，
// 而且 store → archive 已经有依赖，反向 import 会成环。
const sessionModes = new Map()
export function setSessionMode(sessionId, mode) {
  if (sessionId) sessionModes.set(String(sessionId), mode === 'task' ? 'task' : 'daily')
}
const modeOfSession = (id) => sessionModes.get(String(id)) || null

export function buildRecord(sessionId, event, now = new Date()) {
  if (!sessionId || !isArchivable(event)) return null
  const msg = messageOf(event)
  if (!msg || typeof msg.id !== 'string' || !msg.id) return null
  const role = event.type === 'assistant/message' ? 'assistant' : 'user'
  const sourceKind = String(msg.source?.kind || 'unknown')
  // v0.31.0：**入库前**脱敏——档案里从此没有明文密钥/手机号/身份证
  const redacted = redactText(extractText(msg))
  const text = redacted.text
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
    // v0.78.0（审计 P3-11）：档案也要带归属。现在没有群通道，一律 dm:master；
    // 接群那天写入方要按通道传 scope——**事后补要比现在补贵得多**（历史档案要迁移）。
    scope: 'dm:master',
    // v0.66.0（E2）：这条消息发生时是什么模式。老记录没有 → 读方 fail-open。
    // v0.67.1（F4）：会话第一条消息往往"还没人给它登记 mode"（登记发生在 noteUserMessage，
    // 比入档晚一拍）→ 以前这里写 null，于是纸条过滤在真库上覆盖率是 0。
    // 兜底：没登记就用内容判一次（保守：像工作的算 task）。
    mode: modeOfSession(sessionId) || (looksLikeWork(text) ? 'task' : 'daily'),
    msgid_plat: msg.id,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    part: '1/1',
    reply_to: null,
    recalled: false,
    backfilled: false,
    ...(redacted.hits.length ? { redacted: redacted.hits } : {}),
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
export function verifyChain(records, { requireHead = true } = {}) {
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
    // F4（审计 v0791，P1）：以前 `if (r.hash && ...)`——**把 hash 字段删掉就免检**。
    // 现在：有 seq 的记录（非 legacy）必须带 hash，缺了就是"缺 hash"。
    if (!r.hash) return { ok: false, at: i, reason: '缺 hash（记录被改过或不是这个库写的）' }
    if (r.hash !== h) return { ok: false, at: i, reason: 'hash 对不上' }
    // F4：首条必须是链头。以前 i===0 直接放过，于是"从开头删掉 N 条"永远验不出来。
    // 抽样验尾巴时用 requireHead: false 跳过这一条（那段本来就不是文件头）。
    if (i === 0) {
      if (requireHead && (r.prev || 'genesis') !== 'genesis') return { ok: false, at: 0, reason: '首条不是链头' }
      prev = r.hash
      lastSeqOf.set(sid, r.seq)
      continue
    }
    if ((r.prev || 'genesis') !== prev) return { ok: false, at: i, reason: 'prev 对不上' }
    prev = r.hash
    lastSeqOf.set(sid, r.seq)
  }
  return { ok: true, count: valid.length }
}

/**
 * 按**天文件**的跨进程写锁（v0.78.0，审计 P1-3）。
 *
 * 为什么需要：`_append` 的"读链尾 → 算 prev → 追加"这三步跨进程不安全。
 * 两个窗口同时首写同一天的档案时，都会读到空的链尾、都算出 `prev: genesis`，
 * 于是写出**两条并列的链头**——链断了。实测 4 进程 × 60 条：240 行、`prev 对不上`、
 * race 日志 228 行。
 *
 * 为什么不直接用 `lib/lock.js`：那是**全局**库锁（20_state/.lock），粒度太粗——
 * 两个窗口正常聊天会互相等。这里只要锁住"同一天的档案"这一件事，抢不到的代价是几十毫秒。
 *
 * 拿不到锁怎么办：等（最多 `waitMs`）；还拿不到就**照写**并留 race 日志——
 * **丢消息比链断更糟**，链可以用 `memory rechain` 修。
 */
const DAY_LOCK_WAIT_MS = 2000

/**
 * 进程启动时间（毫秒），用来识别 pid 复用（F7）。
 *
 * - 本进程：`Date.now() - process.uptime()*1000`（够用，判等时留 2 秒容差）；
 * - 别的进程（Windows）：拿不到精确值，返回 0 表示"不比较"，行为退回旧逻辑；
 * - Linux/macOS：读 `/proc/<pid>/stat` 或 `ps` 太贵，这里也用 0——
 *   **判活这件事，宁可多等一会儿，也不要误抢活锁**。
 */
function processStartMs(pid = null) {
  if (pid && pid !== process.pid) return 0
  return Math.round(Date.now() - process.uptime() * 1000)
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function withDayLock(dir, file, fn, { waitMs = DAY_LOCK_WAIT_MS } = {}) {
  const lock = `${file}.lock`
  const start = Date.now()
  let fd = null
  while (fd === null) {
    try {
      fd = openSync(lock, 'wx')
      try {
        // F7：写成 `pid|进程启动时间`。只写 pid 的话，持锁进程死后 pid 被复用 →
        // 判活为真 → 一直在等一个已经不存在的进程。
        writeSync(fd, `${process.pid}|${Math.round(processStartMs())}`)
      } catch (we) {
        // 建了锁但写不进 pid：把自己那把锁清掉再重试，别留一个"空 pid 锁"
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        fd = null
        try {
          unlinkSync(lock)
        } catch {
          /* ignore */
        }
        throw we
      }
    } catch (e) {
      // v0.79.0（R3）：释放改用**改名**而不是删除——这台机器上删文件 ~240ms/次，
      // 每条消息都要付一次，等于把 12ms/条 拖到 125ms/条（审计 v0781 实测）。
      // 改名的成本是 1.7ms。残骸由 sweepLocks() 清：本进程第一次构造 writer 时清一次。
      // Windows 上"别的进程正在删这个锁"会短暂抛 EPERM/EACCES/EBUSY——
      // 那不是致命错误，是"现在拿不到，等一下"。当成 EEXIST 处理。
      // （不这么做的后果：_append 抛出去 → 队列 catch 吞掉 → **静默丢一条消息**。）
      const transient = e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY'
      if (!transient) throw e
      // 残留锁（持锁进程已经死了）直接接管，别让一次崩溃把当天档案永久锁死
      try {
        const raw = readFileSync(lock, 'utf8').trim()
        const [pidPart, startPart] = raw.split('|')
        const holder = Number(pidPart) || 0
        const holderStart = Number(startPart) || 0
        let alive = false
        if (holder > 0) {
          try {
            process.kill(holder, 0)
            alive = true
          } catch (err) {
            alive = err?.code === 'EPERM'
          }
          // pid 活着，但"启动时间对不上" = pid 被复用了，持锁的其实是另一个人
          if (alive && holderStart > 0) {
            const nowStart = processStartMs(holder)
            if (nowStart > 0 && Math.abs(nowStart - holderStart) > 2000) alive = false
          }
        } else {
          // pid 读不到：可能是对方刚 create 还没 write。看 mtime，超过 30 秒才敢接管。
          const age = Date.now() - statSync(lock).mtimeMs
          alive = age < 30_000
        }
        if (!alive) {
          unlinkSync(lock)
          continue
        }
      } catch {
        /* 锁刚被释放，重试 */
      }
      if (Date.now() - start > waitMs) {
        // 等不到：照写（丢消息比链断更糟），但留痕
        try {
          appendLog(dir, '50_log/archive-race.log', { at: new Date().toISOString(), file, event: 'lock-timeout', waitedMs: Date.now() - start, pid: process.pid })
        } catch {
          /* ignore */
        }
        return fn({ locked: false })
      }
      sleepMs(5)
    }
  }
  try {
    return fn({ locked: true })
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    // R3：释放 = 把锁**挪走**（改名 ~1.7ms），不是删除（这台机器删除 ~240ms/次）。
    // 挪到 20_state/lock-trash/ 而不是留在 messages/——那里的每个文件都会被当成档案读。
    // 真正的删除由 sweepLocks 做：本进程第一次构造 writer 时清一次，`memory rechain` 也会清。
    try {
      // 注意 `dir` 是 withDayLock 的参数（不是 this）——锁是纯函数，不挂在 writer 上。
      const trash = join(dir, '20_state', 'lock-trash')
      mkdirSync(trash, { recursive: true })
      // 目标名固定（不带时间戳）：之后每次改名都是"替换"，trash 不会随消息条数堆积。
      const target = join(trash, `${basename(lock)}.${process.pid}`)
      try {
        renameSync(lock, target)
      } catch (e) {
        // 极少数文件系统不允许 rename 覆盖：先把旧的目标删掉再改名（这一步会慢，但不常见）
        if (e.code === 'EEXIST' || e.code === 'EPERM') {
          try {
            unlinkSync(target)
          } catch {
            /* ignore */
          }
          renameSync(lock, target)
        } else {
          throw e
        }
      }
    } catch {
      try {
        unlinkSync(lock)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 清掉改过名的锁残骸（R3）。只删**自己进程**留下的，别人的不动。
 * 在 CLI 启动时跑一次就够——它不是热路径。
 */
/**
 * 清掉 lock-trash 里的残骸（R3 的收尾，N4 修的是"谁来清"）。
 *
 * 为什么要有上限：这里每个文件都是一次 unlink，而这台机器 unlink ~240ms。
 * 堆到几万个再清，就是一次几分钟的卡顿——**清理工具不该变成新的卡点**。
 * 所以单次最多清 `max` 个，剩下的下次继续。
 */
export function sweepLocks(dir, { max = 5000 } = {}) {
  let n = 0
  const trash = join(dir, '20_state', 'lock-trash')
  try {
    for (const f of readdirSync(trash)) {
      if (n >= max) break
      try {
        unlinkSync(join(trash, f))
        n += 1
      } catch {
        /* 删不掉就下次再说 */
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return n
}

/** 同一个进程对同一个库，只在第一次构造 writer 时清一次（不是每条消息都扫目录） */
const SWEPT = new Set()

export class ArchiveWriter {
  constructor(dir, { logger, now = () => new Date() } = {}) {
    this.dir = dir
    // N4（审计 v079）：锁残骸得有人清。以前只有 `memory rechain` 调 sweepLocks，
    // 而宿主（index.js / serve.mjs）从不调——注释却写着"下次启动时清"。
    // 现在：本进程第一次给这个库建 writer 时清一次（trash 里都是已释放的锁，安全）。
    if (!SWEPT.has(dir)) {
      SWEPT.add(dir)
      try {
        sweepLocks(dir)
      } catch {
        /* 清不掉不影响写入 */
      }
    }
    this.logger = logger
    this.now = now
    this.queue = Promise.resolve()
    // 老的单文件（v0.78 之前）：只读兼容，不再写
    this.cursorFile = join(dir, '20_state', 'cursors.json')
    // 新的：一个会话一个文件，跨进程不会互相覆盖
    this.cursorDir = join(dir, '20_state', 'cursors')
    const raw = readJsonSafe(this.cursorFile, null)
    this.cursors = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
      ? { version: 1, sessions: { ...raw.sessions } }
      : { version: 1, sessions: {} }
    this.chain = new Map() // dayFile -> { hash, seq, id }
    this._sizes = new Map() // dayFile -> 我们上次写完之后的大小（V5 竞态检测）
    this.writes = 0
    this.races = 0
  }

  /** 游标文件（按会话分；会话 id 里的 `:` `/` 之类换成 `_`） */
  _cursorPathOf(sessionId) {
    const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_') || '_'
    return join(this.cursorDir, `${safe}.json`)
  }

  /**
   * 上一个会话里已入档的最大 seq；-1 表示没有。
   *
   * 先看按会话分的那份（它是权威），没有再退回内存里从老的 cursors.json 读到的值。
   */
  cursorOf(sessionId) {
    // P3（评审 v0.80.1）：原来是"先读盘、再退回内存"——每条消息多一次同步 readFileSync，
    // 而本进程就是游标的写入方（_advance 同时更新内存与盘）。
    // 现在：内存命中直接返回；没有才读盘，并且与内存取 max（跨进程时盘上可能更大）。
    const mem = this.cursors.sessions[sessionId]
    const memOk = Number.isFinite(mem) ? mem : -1
    if (memOk >= 0) return memOk
    try {
      const raw = readJsonSafe(this._cursorPathOf(sessionId), null)
      if (raw && Number.isFinite(raw.seq)) return raw.seq
    } catch {
      /* 读不到就用内存里的 */
    }
    return memOk
  }

  /** 单写者队列（契约 §6.1） */
  handle(sessionId, event) {
    const rec = buildRecord(sessionId, event, this.now())
    if (!rec) return Promise.resolve(false)
    if (rec.seq <= this.cursorOf(sessionId)) {
      return Promise.resolve(false)
    }
    this.queue = this.queue.then(() => this._append(rec)).catch((e) => {
      this.logger?.warn?.(`fish-memory: archive failed: ${e?.message || e}`)
      // 没有 logger 的调用方（测试、CLI）以前什么都看不到——**丢消息必须留痕**。
      try {
        appendLog(this.dir, '50_log/archive-fail.log', { at: new Date().toISOString(), seq: rec.seq, session: rec.session, error: String(e?.message || e), code: e?.code || null, pid: process.pid })
      } catch {
        /* 日志写不上就只能靠 logger 了 */
      }
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
        appendLog(this.dir, '50_log/archive-race.log', { at: new Date().toISOString(), file, expected, actual: sizeNow, pid: process.pid })
      } catch {
        /* 日志失败不影响写入 */
      }
      void line
    }

    // v0.78.0（P1-3）：把"读链尾 → 算 prev → 追加"放进**按天文件**的跨进程锁。
    // 锁内必须重读链头（别人可能刚写过），否则缓存里的 hash 会让两条记录并列。
    return withDayLock(this.dir, file, () => {
      this.chain.delete(file)
      const last = this._chainOf(file)
      // 崩溃窗口去重：上一行就是同一条，不再写。
      // v0.78.0：**必须连 session 一起比**——buildRecord 的 id 是 `msg-<seq>-<msgid 后 6 位>`，
      // 不含会话；两个会话同 seq、msgid 后 6 位又撞上时，会被误判成"同一条"丢掉。
      if (last && last.id === rec.id && last.seq === rec.seq && String(last.session || '') === String(rec.session || '')) {
        this._advance(rec.session, rec.seq)
        try {
          this._sizes.set(file, statSync(file).size)
        } catch {
          /* ignore */
        }
        return false
      }

      rec.prev = last?.hash || 'genesis'
      rec.hash = hashOf(rec)
      // 追加也可能被别的程序短暂占用（Windows 上最常见的是索引/杀毒）。
      // 重试三次，仍然失败才抛——**"这条没写进去"必须是最后的选项**。
      let appended = false
      for (let attempt = 0; attempt < 3 && !appended; attempt++) {
        try {
          appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
          appended = true
        } catch (e) {
          const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'
          if (!transient || attempt === 2) throw e
          sleepMs(10 * (attempt + 1))
        }
      }
      // A6（v0.72.0）：追加是 OS 缓冲的，掉电会丢最后几条——这是可以接受的代价，
      // 但"丢一整天"不是。每 **20 条**落一次盘；游标也走 fsync 的原子写，
      // 顺序是"先档案、后游标"，所以最坏情况是重放几条（幂等），不会丢。
      this._appendedSinceSync = (this._appendedSinceSync || 0) + 1
      if (this._appendedSinceSync >= 20) {
        this._appendedSinceSync = 0
        try {
          const fd = openSync(file, 'r+')
          try {
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
        } catch {
          /* 拿不到 fd 就算了，下次再试 */
        }
      }
      this.chain.set(file, { hash: rec.hash, seq: rec.seq, id: rec.id })
      try {
        this._sizes.set(file, statSync(file).size)
      } catch {
        /* 拿不到大小就算了，下次会当成"变过"重读一次，代价可接受 */
      }
      this._advance(rec.session, rec.seq)
      this.writes += 1
      // v0.68.0（T1）：整理机的节拍来源。**只是计数**，不触发任何整理动作。
      noteArchived(this.dir, 1)
      return true
    })
  }

  _advance(sessionId, seq) {
    // 只往前挪，绝不回退（两个窗口同一会话时，后写的不能把游标拖回去）
    const cur = this.cursorOf(sessionId)
    const next = Math.max(cur, seq)
    this.cursors.sessions[sessionId] = next
    // 游标必须立即落盘：它是幂等的唯一依据。
    // **写自己的文件**，不再整表覆盖 cursors.json。
    try {
      mkdirSync(this.cursorDir, { recursive: true })
      atomicWriteJson(this._cursorPathOf(sessionId), { version: 1, session: String(sessionId), seq: next, at: new Date().toISOString() })
    } catch {
      /* 落盘失败：本次进程内的幂等仍然成立（内存游标已更新） */
    }
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
      // F4：这是"最后 n 条"，不是文件头——所以不要求首条是 genesis
      return verifyChain(records, { requireHead: false })
    } catch (e) {
      return { ok: false, count: 0, reason: String(e?.message || e) }
    }
  }

  /** 测试与 dispose 用：等队列排空 */
  async idle() {
    await this.queue
  }
}
/**
 * 扫一遍已经入库的档案，把明文换成标记（v0.31.0，维护操作）。
 *
 * **这会改档案**——契约 §11 #1 的第三个例外（另两个是 `erase` 与开养前 `reset`）。
 * 改完必须重算同一文件内的 prev/hash 链，否则 `verify` 会红；
 * 命中数量写进 `50_log/redaction.log`，所以"改了什么"有据可查。
 */
export function redactArchive(dir, { dry = false } = {}) {
  const messagesDir = join(dir, '10_archive', 'messages')
  const out = { scanned: 0, changed: 0, hits: [] }
  if (!existsSync(messagesDir)) return out
  const tally = new Map()
  for (const name of readdirSync(messagesDir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const file = join(messagesDir, name)
    // F2（审计 v0791，P0）：以前这里"读 → 逐条脱敏 → 重算链 → rename 覆盖"整段**不持锁**。
    // 而宿主写入方只拿按天锁（withDayLock）——于是一个 11 秒的脱敏窗口里，
    // 并发写进来的消息会被 rename 覆盖掉，且游标已经前移，**永远找不回来**。
    // 修法照 R1：锁内重读，写前复核文件没长（长了就放弃这一轮）。
    const res = withDayLock(dir, file, () => {
    const sizeAtRead = existsSync(file) ? statSync(file).size : 0
    const lines = readFileSync(file, 'utf8').split('\n')
    let touched = false
    let prev = 'genesis'
    const next = lines.map((line) => {
      if (!line.trim()) return line
      out.scanned += 1
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        return line // 坏行不动，交给 verify 去报
      }
      if (typeof rec.text === 'string') {
        const { text, hits } = redactText(rec.text)
        if (hits.length) {
          touched = true
          out.changed += 1
          for (const h of hits) tally.set(h.kind, (tally.get(h.kind) || 0) + h.count)
          rec.text = text
        }
      }
      // 重接链：prev 指向前一条的 hash，hash 覆盖六项（不含 prev）
      rec.prev = prev
      rec.hash = hashOf(rec)
      prev = rec.hash
      return JSON.stringify(rec)
    })
    if (touched && !dry) {
      // 写前复核：读进来之后文件又长了 → 有人正在写，这一轮放弃（宁可这轮不脱敏，也不吃消息）
      const sizeNow = existsSync(file) ? statSync(file).size : 0
      if (sizeNow !== sizeAtRead) {
        appendFileSync(join(dir, '50_log', 'redaction.log'), JSON.stringify({ at: new Date().toISOString(), source: 'scan', file: name, skipped: 'rewrite-race', sizeAtRead, sizeNow }) + '\n', 'utf8')
        return { skipped: true }
      }
      writeFileSyncUtf8(file, next.join('\n'))
    }
    return { skipped: false }
    }, { waitMs: 30_000 })
    if (res && res.skipped) out.skipped = (out.skipped || 0) + 1
  }
  out.hits = [...tally.entries()].map(([kind, count]) => ({ kind, count }))
  if (!dry && out.changed) {
    mkdirSync(join(dir, '50_log'), { recursive: true })
    appendFileSync(
      join(dir, '50_log', 'redaction.log'),
      JSON.stringify({ at: new Date().toISOString(), source: 'scan', changed: out.changed, hits: out.hits }) + '\n',
      'utf8',
    )
  }
  return out
}

function writeFileSyncUtf8(file, text) {
  // 保持与其他写入一致的原子性：先写临时文件再改名
  const tmp = `${file}.redact.tmp`
  writeUtf8(tmp, text)
  renameSync(tmp, file)
}