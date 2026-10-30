// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * host.js — 宿主（DSH）的唯一出入口。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  DSH 版更后，只该改这个文件。改之前先看两处：
 *    ① 重启后看 `50_log/host.log` 的 `missing`（运行时真实缺了什么）
 *    ② `node scripts/memory.mjs hostcheck`（代码里还有哪些口子、各自在哪、坏了什么样）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 三条纪律，hostcheck 会机械地查：
 *   1. `lib/` 下**只有本文件**能写 `ctx.`。别处的 `ctx` 一律经这里转手——
 *      这样升级后要看的文件是 1 个，不是 21 个。
 *   2. 每个口子都打 `[HOST: …]` 标记（里面是口子名），与 HOST_POINTS 一一对应。
 *      加口子不登记 = hostcheck 失败；登记了找不到标记 = 也失败。
 *   3. **服务一律经 `ctx.get('名字')` 取，绝不要直接读 `ctx.<服务>`**——
 *      除非它写在 `inject` 里。cordis 4 对未声明的服务**当场抛**：
 *      `cannot get property "timer" without inject`。
 *      这条是 rc.5 实测撞出来的：v0.5.10 用 `ctx.interval` 拿定时器，
 *      升到 rc.5 后 apply() 抛错、整根 fiber 变 failed、她静默失忆。
 *      能直接读的只有核心成员：`logger` / `effect` / `on` / `get`，外加 inject 里的三个。
 *
 * 为什么不是"直接调 ctx 更简单"：这插件已经栽过三次了——v0.1 找她的回复找到
 * `frozenMessages`（是个 WeakSet），v0.4.3 在 `measure()` 的返回里找上下文上限
 * （宿主压根没这个字段），v0.5.10 直接读 `ctx.interval`（rc.5 起要 inject 才给）。
 * 三次都不是逻辑错，是"以为宿主是这样"。
 * 口子集中 + 能自检，才能在下一次版更时把"她失忆了"变成"host.log 里有一行 missing"。
 *
 * 实测基准：DSH desktop **0.2.1-rc.5**（cordis 4.0.5，195 个 entry，node 24.21.0）。
 */

/** 实测基准。每次对着新版本核对完，改这里的时间和结论——**别只改代码不改这个**。 */
export const VERIFIED_AGAINST = Object.freeze({
  at: '2026-10-30',
  build: 'DSH 0.2.1-rc.5 · cordis 4.0.5 · desktop profile · cordis 195 entries · node 24.21.0',
  note: '服务一律经 ctx.get 取；未 inject 的服务直接读会抛错（rc.5 实测，v0.5.10→v0.5.11 的修）',
})

/**
 * 宿主事件名（唯一的定义处）。
 *
 * [HOST: event-inbox] 收到他的话：`({agent, message})`
 * [HOST: event-session] 双向记档 + 她的回复：`(session, event)`
 * [HOST: event-turn-stopping] 回合结束：`({agent})`
 * [HOST: event-compaction] 压缩开始：**不是独立事件**，是 `session/event` 里的 `type`
 */
export const EVENTS = Object.freeze({
  inbox: 'agent/inbox/inserted',
  session: 'session/event',
  turnStopping: 'agent/turn-stopping',
  compaction: 'compaction/start',
})

/**
 * channel-gap 判定的宽限期。
 *
 * 为什么需要：插件被中途重载（或首次加载）时，宿主会**先补发一批** `session/event`
 * （补档用，seq 都大于游标），此刻 inbox 还没触发过——不是通道坏了，只是还没轮到它。
 * v0.5.11 第一次上机就栽在这：`sawSession:4, sawInbox:0` 被误报成"事件名变了"。
 * 所以判定要同时满足：过了宽限期 + 至少两条新用户消息 + inbox 一次都没来过。
 */
export const GAP_GRACE_MS = 10_000

/**
 * 口子清单。`kind`：
 *   api     调用一个方法           event   监听一个事件名
 *   service 取一个服务             data    读一个数据结构（最容易悄悄变的那类）
 *
 * `symptom` 写"坏了会怎样"，因为**症状比位置有用**：版更后你看到的是症状。
 */
export const HOST_POINTS = [
  {
    id: 'inject',
    kind: 'api',
    required: true,
    api: 'ctx.systemPrompt.context({ name, order, text })',
    symptom: '整块记忆消失：对话正常，但她什么都不记得（不报错）',
    fix: 'attachHost().inject()',
  },
  {
    id: 'event-inbox',
    kind: 'event',
    required: true,
    api: 'agent/inbox/inserted · ({ agent, message })',
    symptom: '新消息不触发检索：注入一直是上一轮的内容，档案只进她的回复',
    fix: 'EVENTS.inbox',
  },
  {
    id: 'event-session',
    kind: 'event',
    required: true,
    api: 'session/event · (session, event)',
    symptom: '档案全空、她的回复不入档、工作记忆永远没有「上次说到」',
    fix: 'EVENTS.session',
  },
  {
    id: 'event-turn-stopping',
    kind: 'event',
    required: false,
    api: 'agent/turn-stopping · ({ agent })',
    symptom: '上下文压力保护、自述到期提醒不再触发（对话不受影响）',
    fix: 'EVENTS.turnStopping',
  },
  {
    id: 'event-compaction',
    kind: 'event',
    required: false,
    api: "session/event 里 type === 'compaction/start'",
    symptom: '换窗交接包不生成：压缩后那一窗接不上',
    fix: 'EVENTS.compaction',
  },
  {
    id: 'effect',
    kind: 'api',
    required: true,
    api: 'ctx.effect(fn, label)',
    symptom: '整块不注册：插件像是没装（所有功能一起没）',
    fix: 'attachHost().effect()',
  },
  {
    id: 'tool-register',
    kind: 'api',
    required: false,
    api: 'ctx.tools.register(def)',
    symptom: 'memory_recall 消失：她想不起细节时只能瞎猜',
    fix: 'attachHost().tool()',
  },
  {
    id: 'skill-register',
    kind: 'api',
    required: false,
    api: 'ctx.skills.register({ name, description, whenToUse, content, resourceBase })',
    symptom: 'fish-remember 技能不注册：她不会主动往 40_pending 写草稿',
    fix: 'attachHost().skill()',
  },
  {
    id: 'timer',
    kind: 'api',
    required: false,
    api: "ctx.get('timer').interval(fn, ms)——别直接读 ctx 上的 interval 属性（未 inject 的服务在 cordis 4 里会抛错）",
    symptom: '每日备份不跑（有 setInterval 兜底，一般看不出来）；写错成 ctx.interval 则整个插件 failed',
    fix: 'attachHost().every()',
  },
  {
    id: 'logger',
    kind: 'api',
    required: true,
    api: 'ctx.logger.{info,warn,error}',
    symptom: '日志没了：出错时只剩静默（最难查的一种）',
    fix: 'attachHost().logger',
  },
  {
    id: 'service-working-directory',
    kind: 'service',
    required: false,
    api: "ctx.get('workingDirectory').defaultDirectory",
    symptom: '拿不到会话 cwd 时不再有兜底目录（显式配了 memoryDir 则无影响）',
    fix: 'attachHost().serviceCwd()',
  },
  {
    id: 'service-token-meter',
    kind: 'service',
    required: false,
    api: "ctx.get('tokenMeter').measure(session) → { totalTokens, ... }",
    symptom: '上下文压力检测失效：压缩前不再落原文包',
    fix: 'attachHost().tokenMeasure()',
  },
  {
    id: 'session-context-window',
    kind: 'data',
    required: false,
    api: 'session.requestContext().contextWindow',
    symptom: '压力分母拿不到 → 只能靠配置/环境变量兜底（v0.4.2 的坑）',
    fix: 'readContextWindow()',
  },
  {
    id: 'data-session-header',
    kind: 'data',
    required: true,
    api: 'session.header.{ cwd, delegationDepth }',
    symptom: '库定位错（在 profile 下另建空库）或子 agent 的对话混进她的档案',
    fix: 'attachHost().sessionCwd() / delegationDepth()',
  },
  {
    id: 'data-event-shape',
    kind: 'data',
    required: true,
    api: "event.{ type, seq, time, surfaceOp, data }；data 里 turn/step",
    symptom: '档案字段错位、幂等失效（同一条消息重复入库）',
    fix: 'lib/archive.js 的 messageOf/isAppend/buildRecord',
  },
  {
    id: 'data-message-shape',
    kind: 'data',
    required: true,
    api: "message.{ id, content: [{type:'text'|'image', text}], source.kind }",
    symptom: '把宿主上下文当成他说的话记进档案（比不工作更糟）',
    fix: 'lib/archive.js 的 extractText/ALLOWED_SOURCES',
  },
  {
    id: 'test-hook',
    kind: 'api',
    required: false,
    api: "Object.defineProperty(ctx, 'fishMemory', ...)（只给测试）",
    symptom: '单测拿不到内部状态（生产无影响）',
    fix: 'attachHost().testHook()',
  },
]

/**
 * 静态探针：能不能在 attach 之前就知道缺了哪个（事件名只能在运行时核对）。
 *
 * 探针本身也必须守纪律 3：只用 `ctx.get` 探服务，不直接读 `ctx.<服务>`——
 * 否则探针自己就会在 cordis 4 里抛错，把"体检"变成"事故"。
 */
const PROBES = {
  inject: (ctx) => typeof ctx?.systemPrompt?.context === 'function',
  'event-inbox': (ctx) => typeof ctx?.on === 'function',
  'event-session': (ctx) => typeof ctx?.on === 'function',
  'event-turn-stopping': (ctx) => typeof ctx?.on === 'function',
  'event-compaction': (ctx) => typeof ctx?.on === 'function',
  effect: (ctx) => typeof ctx?.effect === 'function',
  'tool-register': (ctx) => typeof ctx?.tools?.register === 'function',
  'skill-register': (ctx) => typeof ctx?.skills?.register === 'function',
  timer: (ctx) => typeof safeGet(ctx, 'timer')?.interval === 'function',
  logger: (ctx) => Boolean(ctx?.logger),
  'service-working-directory': (ctx) => typeof safeGet(ctx, 'workingDirectory') === 'object',
  'service-token-meter': (ctx) => typeof safeGet(ctx, 'tokenMeter')?.measure === 'function',
}

/** ctx.get 也可能抛（服务不存在/权限），探针一律包住 */
function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/** 读宿主属性一律包住：属性可能是 getter，而 getter 可能抛（cordis 的服务访问就是） */
function safeRead(fn, fallback) {
  try {
    const v = fn()
    return v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

/**
 * 现在这批口子有哪些在、哪些不在。
 * 事件名与数据形状没法静态验证——它们只能靠跑（见 host.log 的 channel-gap 告警）。
 *
 * @returns {{ok:boolean, found:string[], missing:string[], requiredMissing:string[], unprobeable:string[]}}
 */
export function probeSurface(ctx) {
  const found = []
  const missing = []
  const unprobeable = []
  for (const point of HOST_POINTS) {
    const probe = PROBES[point.id]
    if (!probe) {
      unprobeable.push(point.id)
      continue
    }
    // 探针自己也可能抛（宿主把它做成 getter 就可能）——那算"缺"，不是"崩"
    if (safeRead(() => probe(ctx), false)) found.push(point.id)
    else missing.push(point.id)
  }
  const requiredMissing = HOST_POINTS.filter((p) => p.required && missing.includes(p.id)).map((p) => p.id)
  return { ok: requiredMissing.length === 0, found, missing, unprobeable, requiredMissing }
}

/** [HOST: session-context-window] 单一读取处；拿不到就 undefined，不猜 */
export function readContextWindow(session) {
  try {
    const rc = session?.requestContext?.()
    const w = rc?.contextWindow
    return Number.isFinite(w) && w > 0 ? w : undefined
  } catch {
    return undefined // 会话可能还没请求头
  }
}

const noop = () => {}

/**
 * 把宿主包一层。**调用方拿到的东西不许再往下判断宿主在不在**——
 * 缺了就是这个函数返回 noop / null，别处只写业务。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} [externalLogger] 兜底 logger（测试或极端情况）
 */
export function attachHost(ctx, externalLogger) {
  // ctx 本身可能是个会抛的 Proxy（测试里就这么造），所以探针和 logger 都要包住
  const surface = safeRead(() => probeSurface(ctx), {
    ok: false,
    found: [],
    missing: HOST_POINTS.map((p) => p.id),
    requiredMissing: HOST_POINTS.filter((p) => p.required).map((p) => p.id),
    unprobeable: [],
  })
  // [HOST: logger] 宿主 logger 优先；没有就退到传入的，再没有就静默——但只有这一处决定，
  // 别在业务里到处写 logger?.warn?.()
  const logger = safeRead(() => ctx?.logger, undefined) || externalLogger || { info: noop, warn: noop, error: noop }

  // 运行时计数器：用来发现"两个通道只活了一个"（事件被改名时唯一的线索）
  const stats = {
    inbox: 0,
    session: 0,
    turnStopping: 0,
    userSeen: 0, // 过了游标的新用户消息条数（补发的历史不算证据，见 GAP_GRACE_MS）
    attachAt: Date.now(),
    missingNoticed: false,
  }

  const service = (name) => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  const read = (fn, fallback) => safeRead(fn, fallback)

  const host = {
    surface,
    stats,
    logger,
    events: EVENTS,

    /** [HOST: effect] 生命周期；宿主没给 effect 就直接执行一次（测试用假 ctx 也能跑） */
    effect(fn, label) {
      const has = read(() => typeof ctx?.effect === 'function', false)
      if (!has) {
        const d = fn()
        return typeof d === 'function' ? d : noop
      }
      try {
        const d = ctx.effect(fn, label)
        return typeof d === 'function' ? d : noop
      } catch (e) {
        logger?.warn?.(`fish-memory: ctx.effect(${label}) 失败: ${e?.message || e}`)
        return noop
      }
    },

    /** [HOST: event-inbox] */
    onInbox(fn) {
      return subscribe(EVENTS.inbox, fn, 'inbox')
    },

    /** [HOST: event-session] */
    onSessionEvent(fn) {
      return subscribe(EVENTS.session, fn, 'session')
    },

    /** [HOST: event-turn-stopping] */
    onTurnStopping(fn) {
      return subscribe(EVENTS.turnStopping, fn, 'turnStopping')
    },

    /** [HOST: inject] 注入；宿主没给 systemPrompt 就返回 noop 并已记进 surface.missing */
    inject(spec) {
      if (!read(() => typeof ctx?.systemPrompt?.context === 'function', false)) return noop
      try {
        return ctx.systemPrompt.context(spec) || noop
      } catch (e) {
        logger?.warn?.(`fish-memory: systemPrompt.context 注册失败: ${e?.message || e}`)
        return noop
      }
    },

    /** [HOST: tool-register] 缺了返回 null（调用方据此决定要不要挂工具） */
    tool(def) {
      if (!read(() => typeof ctx?.tools?.register === 'function', false)) return null
      try {
        return ctx.tools.register(def) || null
      } catch (e) {
        logger?.warn?.(`fish-memory: tools.register 失败: ${e?.message || e}`)
        return null
      }
    },

    /** [HOST: skill-register] 缺了返回 null */
    skill(def) {
      if (!read(() => typeof ctx?.skills?.register === 'function', false)) return null
      try {
        return ctx.skills.register(def) || null
      } catch (e) {
        logger?.warn?.(`fish-memory: skills.register 失败: ${e?.message || e}`)
        return null
      }
    },

    /**
     * [HOST: timer] 优先用宿主的 timer 服务；没有就用 Node 的（unref，不挡退出）。
     *
     * **必须经 ctx.get('timer')，不能写 ctx.interval**：cordis 4 里 timer 是服务，
     * 不在 inject 里就直接读会抛 `cannot get property "timer" without inject`。
     * 真要用 ctx.interval 也可以，但得把 'timer' 加进 inject——那会让"没有定时器"的
     * lazy 模式下整个插件不启动，代价太大。get 是"可选依赖"的正确写法。
     */
    every(ms, fn) {
      const timer = service('timer')
      if (typeof timer?.interval === 'function') {
        try {
          const d = timer.interval(fn, ms)
          if (typeof d === 'function') return d
        } catch {
          /* 落到下面的兜底 */
        }
      }
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    },

    /** [HOST: service-working-directory] 会话 cwd 的兜底来源 */
    serviceCwd() {
      const svc = service('workingDirectory')
      return svc?.defaultDirectory
    },

    /** [HOST: service-token-meter] 取这一轮的用量测量；拿不到返回 null */
    tokenMeasure(session) {
      const meter = service('tokenMeter')
      try {
        return meter?.measure?.(session) ?? null
      } catch {
        return null
      }
    },

    /** [HOST: session-context-window] */
    sessionContextWindow: readContextWindow,

    /** [HOST: data-session-header] 库定位用 */
    sessionCwd(agentOrSession) {
      return read(() => agentOrSession?.session?.header?.cwd || agentOrSession?.header?.cwd, undefined)
    },

    /**
     * [HOST: data-session-header] 子 agent 不是她。
     * 读不到时按 0 处理（当作她本人）：宁可多记一条，也不要因为宿主改了字段就把她的对话全丢掉。
     */
    delegationDepth(sessionOrAgent) {
      const n = Number(
        read(
          () => sessionOrAgent?.session?.header?.delegationDepth ?? sessionOrAgent?.header?.delegationDepth,
          0,
        ),
      )
      return Number.isFinite(n) && n > 0 ? n : 0
    },

    /** [HOST: test-hook] 只给单测用，生产不影响 */
    testHook(name, factory) {
      try {
        Object.defineProperty(ctx, name, { configurable: true, get: factory })
      } catch {
        /* ctx 可能是冻结对象，也可能是个会抛的 Proxy */
      }
    },
  }

  function subscribe(eventName, fn, counterKey) {
    if (!read(() => typeof ctx?.on === 'function', false)) return noop
    try {
      const stop = ctx.on(eventName, (...args) => {
        stats[counterKey] += 1
        return fn(...args)
      })
      return typeof stop === 'function' ? stop : noop
    } catch (e) {
      logger?.warn?.(`fish-memory: ctx.on('${eventName}') 失败: ${e?.message || e}`)
      return noop
    }
  }

  return host
}
