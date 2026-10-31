// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * store.js — 记忆库的读写层：记忆点扫描、核心层、索引层、状态、会话工作记忆。
 *
 * 纪律：
 *   - 读方只读快照，容忍一轮延迟（契约 §6.4）；记忆点扫描有 30s 缓存。
 *   - 状态与会话文件用「临时文件 + rename」（契约 §6.3）。
 *   - 任何读失败都返回空值，绝不把插件打挂（契约 §8）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { withLock } from './lock.js'
import { applyReview, weight } from './strength.js'
import { bigrams } from './retrieve.js'
import { makeIdf } from './idf.js'
import { join } from 'node:path'
import {
  atomicWriteJson,
  extractSection,
  extractSum,
  isHarnessContext,
  isInvalidated,
  normalizeEmotion,
  parseFrontMatter,
  readJsonSafe,
  stripFrontMatter,
  stripGuidance,
} from './util.js'

const POINTS_TTL_MS = 30_000
/** 核心层的文件顺序 = 注入顺序；优先级见 render.js 的 CORE_PRIORITY */
const CORE_FILES = ['soul.md', 'user.md', 'relation.md', 'rules.md']

/** 从正文里判断原话是谁说的；判不出就返回 null，绝不猜。 */
export function quoteSpeaker(meta, facts) {
  if (meta?.quote_by === 'her') return 'her'
  if (meta?.quote_by === 'him') return 'him'
  const f = facts || ''
  // 两种写法都认：[原话·他]…… / [原话] 他：「……」
  const m = f.match(/[\[【]原话([^\]】]*)[\]】]\s*([她他你])?/)
  if (m) {
    const tag = `${m[1] || ''}${m[2] || ''}`
    if (/她/.test(tag)) return 'her'
    if (/他|你/.test(tag)) return 'him'
  }
  return null
}

function toPoint(raw) {
  const { meta, body } = parseFrontMatter(raw)
  if (!meta.id) return null
  const facts = extractSection(body, '发生了什么') || extractSection(body, '他说过什么')
  return {
    id: String(meta.id),
    title: meta.title || '',
    quote: typeof meta.quote === 'string' ? meta.quote : '',
    quoteBy: quoteSpeaker(meta, facts),
    date: meta.date || '',
    // v0.21.0：该办日期（到期提醒用）。store 有自己的一套字段映射，
    // 漏掉这里就会出现"readPointFiles 认、store.points() 不认"的鬼故事。
    due: typeof meta.due === 'string' && meta.due ? meta.due : null,
    salience: Number(meta.salience || 0),
    type: meta.type || 'event',
    cluster: meta.cluster || '',
    event: meta.event || null,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
    key: meta.key === true,
    contradicts: Array.isArray(meta.contradicts) ? meta.contradicts : [],
    links: Array.isArray(meta.links) ? meta.links : [],
    status: meta.status || 'active',
    // v0.14.0：事实失效（标记，不是删除）；没写 = 仍然成立
    invalidAt: typeof meta.invalid_at === 'string' ? meta.invalid_at : null,
    pinned: meta.pinned === true,
    // v0.18.0：emotion.self / emotion.user（旧扁平字段保留，兼容老点）
    emotion: normalizeEmotion(meta.emotion, meta),
    valence: Number.isFinite(Number(meta.valence)) ? Math.max(-1, Math.min(1, Number(meta.valence))) : null,
    arousal: Number.isFinite(Number(meta.arousal)) ? Math.max(0, Math.min(1, Number(meta.arousal))) : null,
    mood: typeof meta.mood === 'string' ? meta.mood : null,
    source: Array.isArray(meta.source) ? meta.source : [],
    summary: extractSum(body),
    facts,
    thoughts: extractSection(body, '她当时想'),
    raw,
  }
}

export class MemoryStore {
  constructor(dir, { logger, now = () => new Date() } = {}) {
    this.dir = dir
    this.logger = logger
    this.now = now
    this._points = { at: 0, list: [] }
    this._state = null
    this._sessions = new Map()
    this._dirty = false
    this._sessionsDirty = new Set()
    this._flushTimer = null
  }

  path(...parts) {
    return join(this.dir, ...parts)
  }

  // ── 全局最后一条消息（空窗检测用）────────────────────────────

  lastMessage() {
    const v = readJsonSafe(this.path('20_state/last_message.json'), null)
    return v && typeof v === 'object' && v.id && v.ts ? v : null
  }

  setLastMessage(msg) {
    if (!msg?.id || !msg?.ts) return
    try {
      atomicWriteJson(this.path('20_state/last_message.json'), msg)
    } catch {
      /* 写失败不影响对话 */
    }
  }

  // ── 记忆点 ───────────────────────────────────────────────────

  points() {
    const t = Date.now()
    if (t - this._points.at < POINTS_TTL_MS) return this._points.list
    const out = []
    const skipped = []
    // 只认 30_points：`_samples/` 是搭基线时留下的**演示素材**，不是她的记忆。
    // v0.13.3 起不再读它——此前它参与检索，于是空库里她"记得"台风天看海这种没发生过的事
    // （2026-10-30 20:17 真实注入过一次，来源 `source: [msg-sample-*]`）。
    // 演示素材挪到了插件仓的 `samples/`；备份侧 `pack.js` 仍排除 `_samples`，防旧库还留着。
    for (const sub of ['30_points']) {
      const d = this.path(sub)
      if (!existsSync(d)) continue
      let names = []
      try {
        names = readdirSync(d)
      } catch {
        continue
      }
      for (const f of names) {
        if (!f.endsWith('.md') || /^TEMPLATE/i.test(f)) continue
        try {
          const p = toPoint(readFileSync(join(d, f), 'utf8'))
          // v0.14.0：读不出来的点**记下来**，不许静默消失（`store.skipped()` 给人看）
          if (!p) {
            skipped.push({ file: `${sub}/${f}`, reason: 'front matter 里没有 id（坏了或被截断）' })
            continue
          }
          // 只注入 active：merged / suppressed / dormant 都不该出现在她眼前
          if (p.status !== 'active') continue
          // v0.14.0：已失效的事实不再注入；但**点仍在库里**、审计仍看得见（失效是标记，不是删除）
          if (isInvalidated(p, this.now())) continue
          p.file = `${sub}/${f}`
          out.push(p)
        } catch (e) {
          skipped.push({ file: `${sub}/${f}`, reason: `读不出来：${e?.message || e}` })
        }
      }
    }
    this._skipped = skipped
    this._points = { at: t, list: out }
    return out
  }

  /** 上一次扫点时空过/坏掉的文件（v0.14.0）。给人看，不让它悄悄消失。 */
  skipped() {
    return this._skipped || []
  }

  invalidate() {
    this._points = { at: 0, list: [] }
    this._idx = null
    this._posting = null
    this._idf = null
  }

  /**
   * 语料的 IDF（v0.5.12）。给检索做"虚词二字组压权重"用。
   *
   * 缓存的失效条件是**同一份点列表**（indexPoints 每 30s 或目录变了会换新数组）。
   * 所以调用方可以每轮都问，不会重算统计。
   */
  idf() {
    const list = this.indexPoints()
    if (this._idf && this._idf.list === list) return this._idf.fn
    const fn = makeIdf(list)
    this._idf = { list, fn }
    return fn
  }

  // ── 倒排：bigram → 点 id（内存态，加载时建一次）────────────────
  // 查询先用倒排取候选（默认 ≤500），再只对候选打分；候选为空或过多时退回全量。

  _postingMap() {
    if (this._posting) return this._posting
    const map = new Map()
    for (const p of this.indexPoints()) {
      const grams = new Set([
        ...bigrams(p.title || ''),
        ...bigrams((p.tags || []).join('')),
        ...bigrams((p.aliases || []).join('')),
        ...bigrams(p.cluster || ''),
      ])
      for (const g of grams) {
        let arr = map.get(g)
        if (!arr) map.set(g, (arr = []))
        arr.push(p.id)
      }
    }
    this._posting = map
    return map
  }

  /** @returns {string[]|null} null = 退回全量 */
  candidates(query, limit = 1000) {
    const qs = bigrams(query)
    if (!qs.size) return null
    const ids = new Set()
    const map = this._postingMap()
    for (const g of qs) for (const id of map.get(g) || []) ids.add(id)
    if (!ids.size || ids.size > limit) return null
    return [...ids]
  }

  // ── 检索索引（轻量，不含正文）────────────────────────────────
  // 打分只用 title/tags/cluster/summary；正文按需 hydrate，避免每轮读全部 .md。

  indexPoints() {
    const t = Date.now()
    if (this._idx && t - this._idx.at < 30_000) return this._idx.list
    const mtime = this._dirMtime()
    const file = this.path('20_index', 'retrieval.json')
    const cached = readJsonSafe(file, null)
    if (cached && cached.mtime === mtime && Array.isArray(cached.points)) {
      this._idx = { at: t, list: cached.points }
      return cached.points
    }
    const light = this.points().map(({ raw, facts, thoughts, ...rest }) => rest)
    try {
      atomicWriteJson(file, { version: 1, mtime, points: light })
    } catch {
      /* 写失败不影响检索 */
    }
    this._idx = { at: t, list: light }
    return light
  }

  /**
   * 内容指纹：文件名 + mtime + size 的滚动哈希。
   * 只看目录 mtime 会漏掉「原地改一个点」（mtime 不变），导致检索一直用旧摘要。
   */
  _dirMtime() {
    let h = 0
    // 与 points() 保持一致：只有 30_points 影响"记忆点有没有变"（`_samples` 从 v0.13.3 起不参与）
    for (const sub of ['30_points']) {
      const d = join(this.dir, sub)
      let names = []
      try {
        names = readdirSync(d).sort()
      } catch {
        continue
      }
      for (const f of names) {
        if (!f.endsWith('.md')) continue
        try {
          const st = statSync(join(d, f))
          h = (h * 31 + Math.round(st.mtimeMs) + st.size + f.length) % 1e15
        } catch {
          /* 并发删除 */
        }
      }
    }
    return h
  }

  /** 轻量点 → 全文点（只给最终选中的 ≤3 条读文件） */
  fullPoint(p) {
    if (!p) return null
    if (p.facts !== undefined) return p
    try {
      const raw = readFileSync(join(this.dir, p.file || join('30_points', `${p.id}.md`)), 'utf8')
      return toPoint(raw) || p
    } catch {
      return p
    }
  }

  // ── 核心层 ───────────────────────────────────────────────────
  //
  // 按「块」返回，而不是拼好的一整段：装配时才有机会按优先级
  // 装到 budget.core 里（v0.4.2 之前 core 整块注入，预算键是死的）。

  coreParts() {
    const parts = []
    for (const rel of CORE_FILES) {
      const clean = stripGuidance(stripFrontMatter(this.read(`00_core/${rel}`)))
      if (clean) parts.push({ name: rel.replace(/\.md$/, ''), text: clean })
    }
    return parts
  }

  /**
   * 关系状态（【我们现在】）。总设计 §5.4：**常驻 60 tok，独立预算**。
   *
   * 所以它**不在** `coreParts()` 里：那个数组要一起吃 `budget.core`，超了按优先级丢块，
   * 而状态的优先级最低——于是她会"在最挤的那一轮最先忘掉我们现在什么状态"。
   * 现在由 `render.js` 的 `layoutStatus()` 单独装、单独计费。
   */
  coreStatus() {
    const st = readJsonSafe(this.path('00_core/relation_status.json'), null)
    if (!st || typeof st !== 'object' || !st.phase) return ''
    if (st.phase === '常态') return '【我们现在】常态。'
    return `【我们现在】${st.phase}。${st.since ? `从 ${st.since} 开始。` : ''}${st.note || ''}`
  }

  core() {
    return this.coreParts()
      .map((p) => p.text)
      .join('\n\n')
  }

  /**
   * 腔调样本（`00_core/voice.md` 的「## 现在」段）。
   *
   * **不进每轮注入。** 总设计 §5.4:658 写明 `voice_origin.md` 不注入；20 段 voice 属于
   * **唤醒包**（§11.1 的 `02_voice.md`）与**急救重注**（契约 §7.5.6）——只有这两处会读它。
   *
   * 读的时候过一遍 `stripGuidance`：那份文件是给人看的模板，`>` 说明行、`_（待填）_`
   * 占位句都不该进上下文。模板没填时返回空串（"她还没开口"，不是"她有 0 段样本"）。
   */
  voice() {
    const raw = this.read('00_core/voice.md')
    if (!raw) return ''
    const clean = stripGuidance(stripFrontMatter(raw))
    const i = clean.indexOf('## 现在')
    if (i < 0) return ''
    // 去掉「## 现在」这个给模板用的标题（调用方自己给标题），并**只取到下一个二级标题为止**：
    // 模板后面可能还有「## 之后」之类的小节，不该被当成样本读进来
    const rest = clean.slice(i + '## 现在'.length)
    const next = rest.search(/^## /m)
    return (next >= 0 ? rest.slice(0, next) : rest).trim()
  }

  // ── 索引层 ───────────────────────────────────────────────────

  index() {
    const clusters = []
    const raw = this.read('20_index/clusters.md')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('|') || /^\|[\s:|-]+\|$/.test(t) || /簇\s*\|/.test(t) || t.includes('待填')) continue
      clusters.push(t)
      if (clusters.length >= 8) break
    }
    const recent = []
    const rawRecent = this.read('20_index/recent.idx.jsonl')
    for (const line of rawRecent.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      recent.push(t)
      if (recent.length >= 25) break
    }
    return { clusters, recent }
  }

  read(rel) {
    try {
      const p = this.path(rel)
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    } catch {
      return ''
    }
  }

  // ── 状态（inj10 / tick）──────────────────────────────────────
  //
  // 注意：这里**不碰** 20_state/state.json。
  // 那个文件归遗忘/归并脚本（S/D/r/lc/ll），插件只负责「最近 10 轮注入了几次」，
  // 写在插件私有的 inj10.json 里，避免把别人的状态覆盖掉。

  state() {
    if (this._state) return this._state
    const raw = readJsonSafe(this.path('20_state/inj10.json'), null)
    // 契约 §8：状态损坏 → 重建为空 + 告警，不阻塞对话
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (raw !== null) this.logger?.warn?.('fish-memory: inj10.json 损坏，已重建为空')
      this._state = { version: 1, tick: 0, points: {} }
    } else {
      this._state = {
        version: 1,
        tick: Number(raw.tick) || 0,
        points: raw.points && typeof raw.points === 'object' ? raw.points : {},
      }
    }
    return this._state
  }

  /** 一轮 = 一条用户消息。返回新 tick。 */
  bumpTick() {
    const st = this.state()
    st.tick += 1
    this._dirty = true
    this._scheduleFlush()
    return st.tick
  }

  recordInjection(ids, tick) {
    if (!ids.length) return
    const st = this.state()
    const now = this.now().toISOString()
    for (const id of ids) {
      const s = st.points[id] || (st.points[id] = { inj: [] })
      const inj = Array.isArray(s.inj) ? s.inj : []
      // 同一轮内多次装配只算一次，否则一轮就触发了重复衰减
      s.inj = (inj.includes(tick) ? inj : inj.concat(tick)).filter((n) => n > tick - 10)
      s.ll = now
    }
    this._dirty = true
    this._scheduleFlush()
  }

  /** 最近 window 轮内这条被注入过几次 */
  injectionCount(id, tick, window = 10) {
    const s = this.state().points?.[id]
    if (!s || !Array.isArray(s.inj)) return 0
    return s.inj.filter((n) => n > tick - window).length
  }

  /** 到期复习：距上次复习 ≥ S 天且 R < 0.75，取 R 最低的一条 */
  dueReview(now = this.now()) {
    const st = this.state()
    let best = null
    for (const [id, s] of Object.entries(st.points || {})) {
      const S = Number(s.S) > 0 ? Number(s.S) : null
      const last = s.rv || s.ll
      if (!S || !last) continue
      const days = (now.getTime() - Date.parse(last)) / 86_400_000
      if (!Number.isFinite(days) || days < Math.max(1, S)) continue
      const R = Math.pow(1 + (19 / 81) * (days / S), -0.5)
      if (R >= 0.75) continue
      if (!best || R < best.R) best = { id, R, days }
    }
    return best
  }

  markReviewed(id, now = this.now()) {
    const s = this.state().points?.[id]
    if (!s) return
    s.rv = now.toISOString()
    this._dirty = true
    this._scheduleFlush()
  }

  // ── 记忆强度（R 加权 + 复述回血）──────────────────────────────

  /** 这条记忆的当前可提取度 R */
  retrievabilityOf(point, now = this.now()) {
    const st = this.state().points?.[point.id] || {}
    const S = Number(st.S) > 0 ? Number(st.S) : 1 + 3 * Math.max(1, point.salience || 1)
    const last = st.ll || point.date || now.toISOString()
    const days = Math.max(0, (now.getTime() - Date.parse(last)) / 86_400_000)
    if (!Number.isFinite(days)) return 0.5
    return Math.pow(1 + (19 / 81) * (days / S), -0.5)
  }

  /** 检索权重：六维强度（S/R/D/N/F/C），不再只是 0.5+0.5R */
  memoryWeight(point, now = this.now()) {
    return weight(point, this.state().points?.[point.id] || {}, now.getTime())
  }

  /** 复述回血：S' = S·(1+0.3(1-R))，r+1，提到则 D−，没提才 D+ */
  reinforce(id, now = this.now()) {
    const st = this.state()
    const s = st.points[id] || (st.points[id] = { S: 7, r: 0, inj: [] })
    const next = applyReview(s, this.retrievabilityOf({ id, salience: 3, date: s.ll || now.toISOString() }, now), {
      mentioned: true,
    })
    st.points[id] = { ...s, ...next }
    this._dirty = true
    this._scheduleFlush()
    return st.points[id]
  }

  // ── 工作记忆（会话层，契约 §5.7）──────────────────────────────

  sessionPath(id) {
    return this.path('20_state/sessions', `${id}.json`)
  }

  session(id) {
    if (this._sessions.has(id)) return this._sessions.get(id)
    const raw = readJsonSafe(this.sessionPath(id), null)
    const data =
      raw && typeof raw === 'object'
        ? {
            session_id: id,
            created_at: raw.created_at || this.now().toISOString(),
            last_active: raw.last_active || this.now().toISOString(),
            // 历史遗留：旧版把宿主上下文写进了 tail，读的时候清掉
            tail: (Array.isArray(raw.tail) ? raw.tail : [])
              .filter((m) => m && !isHarnessContext(m.text))
              .slice(-10),
            open_threads: Array.isArray(raw.open_threads) ? raw.open_threads : [],
            injected_work: raw.injected_work === true,
            previous: typeof raw.previous === 'string' ? raw.previous : null,
          }
        : null
    if (data) {
      this._sessions.set(id, data)
      if (Array.isArray(raw.tail) && raw.tail.length !== data.tail.length) this._markSessionDirty(id)
    }
    return data
  }

  ensureSession(id) {
    let s = this.session(id)
    if (!s) {
      // 先记下「上一个会话」再覆盖 last.json，否则首轮工作记忆永远取不到
      const prev = readJsonSafe(this.path('20_state/sessions/last.json'), null)?.current
      s = {
        session_id: id,
        created_at: this.now().toISOString(),
        last_active: this.now().toISOString(),
        tail: [],
        open_threads: [],
        injected_work: false,
        previous: prev && prev !== id ? prev : null,
      }
      this._sessions.set(id, s)
      this._markSessionDirty(id)
      this._writeCurrentSession(id)
    }
    return s
  }

  touchSession(id, message) {
    if (!id || !message) return
    const s = this.ensureSession(id)
    s.last_active = this.now().toISOString()
    s.tail.push({ role: message.role, text: String(message.text || '').slice(0, 600), ts: message.ts })
    if (s.tail.length > 10) s.tail = s.tail.slice(-10)
    this._markSessionDirty(id)
  }

  markWorkInjected(id) {
    const s = this.ensureSession(id)
    if (s.injected_work) return
    s.injected_work = true
    this._markSessionDirty(id)
  }

  /** 上一次活跃的会话（不含自己） */
  previousSession(excludeId) {
    const own = this._sessions.get(excludeId)
    const id = own?.previous || readJsonSafe(this.path('20_state/sessions/last.json'), null)?.current
    if (!id || id === excludeId) return null
    return this.session(id)
  }

  _writeCurrentSession(id) {
    try {
      atomicWriteJson(this.path('20_state/sessions/last.json'), { current: id })
    } catch {
      /* 写失败不阻塞 */
    }
  }

  // ── 冲盘 ─────────────────────────────────────────────────────

  _markSessionDirty(id) {
    this._sessionsDirty.add(id)
    this._scheduleFlush()
  }

  _scheduleFlush() {
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this.flush()
    }, 800)
    this._flushTimer.unref?.()
  }

  /** 立即落盘（dispose 时也调用）。失败只告警，不抛。 */
  flush() {
    try {
      withLock(this.dir, () => {
        if (this._dirty) {
          atomicWriteJson(this.path('20_state/inj10.json'), this.state())
          this._dirty = false
        }
        for (const id of this._sessionsDirty) {
          const s = this._sessions.get(id)
          if (s) atomicWriteJson(this.sessionPath(id), s)
        }
        this._sessionsDirty.clear()
      })
    } catch (e) {
      this.logger?.warn?.(`fish-memory: state flush failed: ${e?.message || e}`)
    }
  }

  dispose() {
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = null
    this.flush()
  }
}
