// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * dsh-fish-memory — 大肥鱼的薄插件（v0.5.10）
 *
 * 只做三件事：
 *   ① 收消息 → 追加档案（user + assistant 双向，seq 幂等）
 *   ② 每轮生成前 → 检索 → 拼「核心层 + 工作记忆 + 索引层 + 正文」注入
 *   ③ 注册 remember 技能，让她自己往 40_pending/ 写草稿
 *
 * 不做：压缩 / 遗忘 / 归并 / 审计 / 唤醒包。那些都在文件上，插件挂了记忆库不受影响。
 *
 * **宿主口子全在 `lib/host.js`。** 本文件不写 `ctx.`（hostcheck 会查），
 * 需要宿主能力时从 `host` 上取——DSH 版更时改的是 host.js，不是这里。
 *
 * 设计依据：《大肥鱼-总设计》v2.15 §6.3、§7.1；《插件接口契约》v1.0 §2–§5、§8
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ArchiveWriter, extractText, isArchivable } from './archive.js'
import { GAP_GRACE_MS, attachHost } from './host.js'
import { recordSurface, bootAdjustedSurface, reportApplyFailure, autopsyDir } from './compat.js'
import { checkArchive } from './integrity.js'
import { privacyReport } from './privacy.js'
import { MemoryStore } from './store.js'
import { bigrams, isGated, mergeWeights, pickByEvent, rankHybrid, sameTopic, wasMentioned } from './retrieve.js'
import { DEFAULT_BUDGET, assemble } from './render.js'
import { buildGapDraft, writeGapDraft } from './gaps.js'
import { autoPack, healCore } from './heal.js'
import { canaryHits, isInjectionSuspect, reanchorBlock } from './guard.js'
import { contextWindowOf, ensureSegmentPacket, pressureNote, pressureRatio } from './pressure.js'
import { SELF_TOPIC, dueForSelf, latestSelf, renderSelfBlock } from './self.js'
import { buildHandoff, takeHandoff } from './handoff.js'
import { dormantPoints } from './inspect.js'
import { renderRecall, searchArchive } from './recall.js'
import {
  detectMode,
  layoutAbilities,
  needsRelationshipRecall,
  rankAbilities,
  renderTools,
  scanAbilities,
} from './mode.js'
import { normalizeConfig } from './config.js'
import { estTokens, fingerprintDir, localDay } from './util.js'

export const name = 'fish-memory'
// agents 只是事件来源（ctx.on），不需要注入；可选服务一律走 ctx.get()
export const inject = ['systemPrompt', 'skills', 'tools']

/**
 * 现在跑的到底是哪一版插件。
 *
 * 为什么要读：这个项目反复栽在"改了源码但没生效"上（v0.6.1 实测四组），
 * 而 `sync` 只拷 lib/ 和 package.json，`selfcheck` 比的是磁盘上的两份——
 * 都回答不了"**进程里**加载的是哪一版"。所以每次加载写进 host.log，重启后一眼可查。
 * 读不到就写 unknown，不编。
 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

const DEFAULTS = {
  threshold: 0.8,
  recallLimit: 20,
  maxEvents: 3,
  rebalance: true,
  idf: false,
  idfMode: 'min',
}
const ASSEMBLE_CACHE_MS = 1500
const BACKUP_EVERY_MS = 6 * 3600_000

/**
 * 记忆库根目录。**纯函数，便于单测。**
 *
 * 优先级：显式配置 / 环境变量 → 当前会话的 cwd → workingDirectory 服务 → 进程 cwd。
 */
export function resolveMemoryDir({ explicit, sessionCwd, serviceCwd, cwd = process.cwd() }) {
  const base = sessionCwd || serviceCwd || cwd
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(base, explicit)
  return join(base, 'fish-memory')
}

// ── remember 技能 ──────────────────────────────────────────────

const SKILL_CONTENT = [
  '# fish-remember — 把值得记住的事写进记忆库',
  '',
  '记忆库在 resource base 指向的目录。你只往 `40_pending/` 写草稿，**永不直接写 `30_points/`**。',
  '',
  '## 什么时候写',
  '- 情绪峰值（吵架、和好、大哭、大笑）',
  '- 形成固定习惯或梗',
  '- 明确表达了偏好或态度',
  '- 做出了承诺、约定',
  '- 触碰了边界',
  '- 用户说「记住这个」',
  '',
  '**不要写**：一次性闲聊、能从当前对话直接看到的状态、天气时间这类琐事。',
  '**一段对话最多 3 条。** 无信息量的日常不产记忆点，只留档案。',
  '',
  '## 文件格式',
  '路径：`40_pending/M-YYYY-MM-DD-NNN.md`（NNN 是当天序号，从 001 开始）',
  '',
  '**第一段** front matter（三条横线包起来）：',
  '',
  '    id       M-YYYY-MM-DD-NNN',
  '    version  1（schema 版本；老点没这个字段也按 1 读）',
  '    title    事件名，短，好检索',
  '    quote    关键原话，逐字，≤30 字；没有就写 null',
  '    quote_by her / him（谁说的；判不出就不写这个字段）',
  '    date     YYYY-MM-DD',
  '    salience 1-5',
  '    type     event / preference / boundary / habit / promise / conflict',
  '    cluster  主题簇',
  '    event    E-YYYYMMDD-NN，同一场事件共用一个',
  '    tags     [标签1, 标签2]',
  '    status   pending',
  '    source   [msg-...]，指向档案里真实存在的消息',
  '    links    []',
  '',
  '**第二段** SUM 块（`<!-- SUM -->` 与 `<!-- /SUM -->` 之间）：',
  '55 字以内。只写两样：发生了什么（一个动作或场景）、她的情绪（一个词）。不要把原话塞进 SUM。',
  '',
  '**第三段** 正文。**只有第一节必填，其余没有内容就整节不写——绝不编造。**',
  '',
  '    事件类        ## 发生了什么     [事实] 只写可验证的；[原话·他]/[原话·她] 逐字引用',
  '    偏好/边界类   ## 他说过什么     [事实] + [原话·他]',
  '    可选          ## 她当时想       [旁白 v1] 她没回应就删掉这一节',
  '    可选          ## 为什么重要     [系统] 管线会自动补，可以不写',
  '',
  '## 四条硬规矩',
  '1. **顺序**：先写 QUOTE 和 SUM，再写全文。先写全文会让摘要膨胀到 150 字以上。',
  '2. **不编造**：只记对话里真的发生过的。想不起来就不写。',
  '3. **原话逐字**：不许润色、不许补全、不许改写。否定词、数字、时间必须保留。',
  '4. **旁白不是事实**：`[旁白]` 永远不能写成「发生了什么」。',
  '',
  '## salience 五级',
  '- 5 改变关系走向 / 触碰底线 / 永不再有',
  '- 4 形成固定习惯或梗 / 强烈情绪峰值',
  '- 3 明确表达了偏好或态度',
  '- 2 普通但有细节的日常',
  '- 1 可完全由档案重建',
  '',
  '## 写完',
  '告诉用户你写了哪几条（标题 + 一句为什么重要），让他审核。',
].join('\n')

// ── 入口 ───────────────────────────────────────────────────────

/**
 * 入口 = **一层保险**。v0.5.11 那次 rc.5 事故，`apply` 抛错 → 整根 fiber failed →
 * 注入、技能、记档全停，而且**外面一点痕迹都没有**（DSH 不存主进程日志）。
 * 所以这里做三件事，任何一件做到都能把"她静默失忆"变成"有人看得见"：
 *   ① 崩了写尸检报告（lib/compat.js，只用 fs，不依赖 ctx）
 *   ② 崩了还能注入一行降级公告（systemPrompt 还在的话），让她别假装记得
 *   ③ 崩了也往宿主 stderr 喊一声（宿主抓不抓是它的事，我们尽力）
 */
export function apply(ctx, config = {}) {
  // 宿主只在这里碰一次：之后所有能力都从 host 上拿（见 lib/host.js）
  let host = null
  try {
    host = attachHost(ctx)
    return applyInner(ctx, config, host)
  } catch (e) {
    const dir = autopsyDir(config)
    const entry = reportApplyFailure(dir, e, host?.surface)
    try {
      host?.logger?.error?.(
        `fish-memory: 加载失败（记忆会缺失）：${e?.message || e}${entry ? ` · 详见 ${dir}\\50_log\\compat.log` : ''}`,
      )
    } catch {
      /* logger 也可能是个会抛的 getter */
    }
    try {
      // 最后一条命：能注入就注入一行，告诉她这轮别装记得
      let shown = false
      attachHost(ctx).inject({
        name: 'fish-memory-degraded',
        order: -299,
        text: () => {
          if (shown) return ''
          shown = true
          return [
            '<!-- 记忆降级 -->',
            `记忆插件这次没能加载（${String(e?.message || e).slice(0, 120)}）。`,
            '这轮你确实不记得任何事，不要假装记得；细节在 50_log/compat.log。',
            '<!-- /记忆降级 -->',
          ].join('\n')
        },
      })
    } catch {
      /* 连注入都不行，那就只剩日志了 */
    }
    return undefined
  }
}

/**
 * 真正的装配。拆出来只为了外面能整体包 try/catch——
 * `apply` 里任何一处抛错，都会让 host 认为整个插件挂了。
 */
function applyInner(ctx, config, host) {
  const logger = host.logger
  const cfg = normalizeConfig(config, logger)
  const budget = { ...DEFAULT_BUDGET, ...(cfg.inject || {}) }
  const explicit = cfg.memoryDir || process.env.FISH_MEMORY_DIR || ''
  const perAgent = new Map()

  // 目录、store、archive 全部延迟到「第一次拿到会话 cwd」时再建；
  // 之后只有会话 cwd 真的变了才重建（多工作区不再串库）
  let dir = ''
  let store = null
  let archive = null
  let skillDispose = null
  let backupStop = null
  let backupStarted = false
  let backupNow = () => {}
  let privacyChecked = false

  // 技能要跟着库走：resourceBase 指向哪套库，草稿就该写进哪套
  function registerSkill() {
    try {
      skillDispose?.()
    } catch {
      /* ignore: 卸载技能失败不影响启动 */
    }
    skillDispose = null
    const dispose = host.skill({
      name: 'fish-remember',
      description: '把值得长期记住的事写进大肥鱼记忆库的 40_pending/ 草稿区',
      whenToUse:
        '当一段对话出现值得跨会话保留的事（情绪峰值、形成习惯、明确表态、约定、冲突、触碰边界），或用户说「记住这个」时',
      content: SKILL_CONTENT,
      source: 'dsh-fish-memory',
      resourceBase: { kind: 'directory', path: dir },
    })
    if (!dispose) logger?.info?.('fish-memory: 宿主没有 skills.register，fish-remember 技能未注册')
    skillDispose = dispose
  }

  /** 建（或重建）某个库的 store / archive / 自检 / 备份 / 技能 */
  function initDir(next) {
    store?.dispose()
    dir = next
    store = new MemoryStore(dir, { logger })
    archive = new ArchiveWriter(dir, { logger })
    // 只打目录名（v0.14.1）：宿主日志可能被存档/上报，绝对路径里有用户名。
    // 「库解析跑偏」用目录名也能看出来（跑到一个叫 profiles 的空库就说明解析错了）。
    logger?.info?.(`fish-memory: lib=${basename(dir)}`)

    const check = archive.verifyLatest(100)
    if (!check.ok) logger?.warn?.(`fish-memory: 档案链自检失败：${check.reason || '未知'}（${check.count} 条）`)

    // 档案完整性（v0.8.0）：verifyLatest 只看最后一个文件，这里对全部文件比指纹。
    // 旧档案被改 → 记一条 archive-integrity.log；不崩、不拦对话。
    try {
      const integ = checkArchive(dir)
      if (integ.firstRun) {
        logLine('archive-integrity.log', {
          at: new Date().toISOString(),
          event: 'baseline',
          files: integ.checked,
          bytes: integ.bytes,
        })
      } else if (!integ.ok) {
        logger?.warn?.(
          `fish-memory: 档案完整性异常（改过 ${integ.changed.length} / 丢了 ${integ.missing.length} / 坏链 ${integ.broken.length}）` +
            `：${[...integ.changed, ...integ.missing, ...integ.broken.map((b) => b.file)].join(', ')}`,
        )
        logLine('archive-integrity.log', {
          at: new Date().toISOString(),
          event: 'integrity-failed',
          changed: integ.changed,
          missing: integ.missing,
          broken: integ.broken,
          badLines: integ.badLines,
          sampled: integ.sampled,
          note: '只报告不改写：档案只追加，怎么处理由人决定',
        })
      }
    } catch (e) {
      logger?.warn?.(`fish-memory: 档案完整性检查失败: ${e?.message || e}`)
    }

    // 非正常退出检测：boot.json 还在 = 上次没走 dispose
    try {
      const bp = join(dir, '20_state', 'boot.json')
      const prev = existsSync(bp) ? JSON.parse(readFileSync(bp, 'utf8')) : null
      if (prev?.at) {
        logger?.warn?.(`fish-memory: 上次非正常退出（${prev.at}）`)
        logLine('boot.log', { at: new Date().toISOString(), event: 'unclean-exit', previous: prev })
      }
      mkdirSync(join(dir, '20_state'), { recursive: true })
      writeFileSync(bp, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), 'utf8')
    } catch {
      /* 标记失败不影响启动 */
    }

    // 兜底①：核心层缺失时从 versions/ 恢复（治"她把 soul.md 删了"）
    try {
      const heal = healCore(dir)
      if (heal.restored.length) logger?.warn?.(`fish-memory: 核心层缺失，已从快照恢复：${heal.restored.join(', ')}`)
      if (heal.missing.length) logger?.error?.(`fish-memory: 核心层缺失且无快照：${heal.missing.join(', ')}`)
    } catch (e) {
      logger?.warn?.(`fish-memory: 核心层自愈失败: ${e?.message || e}`)
    }

    // 兜底②：每天一份迁移包，落在记忆库外面（同一天只打一次）
    if (!backupStarted) {
      backupStarted = true
      backupNow()
      backupStop = host.every(BACKUP_EVERY_MS, () => backupNow())
    }

    // 宿主口子自检：每次建库（≈每次加载插件）记一行，版更后第一眼看这里
    // 有 missing 不代表坏了——optional 的缺了只是少一块功能；requiredMissing 才算坏。
    try {
      logLine('host.log', {
        at: new Date().toISOString(),
        ok: host.surface.ok,
        // 引擎版本也记一笔：DSH 版更常带 Node 大版本变化，插件只用到 node:fs/path/crypto
        node: process.versions.node,
        // 插件版本：回答"进程里加载的是哪一版"（sync 只保证磁盘一致，不保证进程已重载）
        plugin: pluginVersion(),
        // lib/ 指纹：版本号会说谎（只 bump 版本不动代码 / 动了代码不 bump），指纹不会。
        // `selfcheck` 的「运行时版本」拿它和磁盘比：一致就说明进程跑的就是磁盘这份代码。
        lib: fingerprintDir(import.meta.dirname),
        verifiedAgainst: '见 lib/host.js 的 VERIFIED_AGAINST',
        missing: host.surface.missing,
        requiredMissing: host.surface.requiredMissing,
        note: '事件名与数据形状静态验不了；若只见 session 事件、不见 inbox，会另记 channel-gap',
      })
      if (host.surface.requiredMissing.length) {
        logger?.warn?.(`fish-memory: 宿主缺少必需口子 ${host.surface.requiredMissing.join(', ')}（见 50_log/host.log）`)
      }
    } catch {
      /* 自检日志失败不影响启动 */
    }

    // 版更对比（v0.6.0）：与上一份快照比，少了口子 = 这次版更动到了我们依赖的东西
    try {
      // 刚起来那几十秒 service-* 可能还没挂上（实测过，会误报 regressed）：
      // 宽限期内按下不表，但 host.log 里仍记原始探测
      const { surface: snap, deferred } = bootAdjustedSurface(host.surface, Date.now() - host.stats.attachAt)
      if (deferred.length) {
        logger?.info?.(`fish-memory: 启动早期这些服务还没就绪，暂不计入快照：${deferred.join(', ')}`)
      }
      const diff = recordSurface(dir, snap)
      if (diff.kind === 'regressed' || diff.kind === 'mixed') {
        logger?.warn?.(
          `fish-memory: 宿主口子比上次少：${diff.regressed.join(', ')}（只改 lib/host.js；memory compat 看详情）`,
        )
        logLine('compat.log', {
          at: new Date().toISOString(),
          event: 'surface-regressed',
          regressed: diff.regressed,
          recovered: diff.recovered,
          requiredMissing: diff.requiredMissing,
        })
      } else if (diff.kind === 'recovered') {
        logLine('compat.log', { at: new Date().toISOString(), event: 'surface-recovered', recovered: diff.recovered })
      } else if (diff.kind === 'first') {
        logLine('compat.log', { at: new Date().toISOString(), event: 'surface-first', found: snap.found.length })
      }
    } catch (e) {
      logger?.warn?.(`fish-memory: 版更对比失败: ${e?.message || e}`)
    }

    // 隐私体检（v0.9.0）：库在工作区里、全是明文，先看它会不会被 git 带走。
    // 只记一次、只写日志，不改用户的仓库——要改得显式跑 memory privacy --write。
    if (!privacyChecked) {
      privacyChecked = true
      try {
        const p = privacyReport(dir, cfg.backupDir || process.env.FISH_MEMORY_BACKUP)
        if (p.repo && (!p.memoryIgnored || !p.backupIgnored)) {
          logger?.info?.(
            `fish-memory: 这个库在 git 仓库 ${p.repo} 里且未被忽略（跑 memory privacy 看详情，--write 可自动加忽略块）`,
          )
          logLine('privacy.log', {
            at: new Date().toISOString(),
            event: 'git-exposed',
            repo: p.repo,
            memoryIgnored: p.memoryIgnored,
            backupIgnored: p.backupIgnored,
            hint: 'memory privacy / memory privacy --write',
          })
        } else {
          logLine('privacy.log', {
            at: new Date().toISOString(),
            event: 'ok',
            repo: p.repo,
            memoryIgnored: p.memoryIgnored,
            backupIgnored: p.backupIgnored,
          })
        }
      } catch (e) {
        logger?.warn?.(`fish-memory: 隐私体检失败: ${e?.message || e}`)
      }
    }

    registerSkill()
    return dir
  }

  backupNow = () => {
    if (!dir) return
    try {
      const r = autoPack(dir, cfg.backupDir || process.env.FISH_MEMORY_BACKUP, { keep: cfg.backupKeep })
      if (r) {
        logger?.info?.(`fish-memory: 已备份 ${r.files} 个文件 → ${r.dest}`)
        if (r.pruned?.removed?.length) {
          logger?.info?.(`fish-memory: 按保留策略清掉 ${r.pruned.removed.length} 份旧备份`)
          logLine('backup.log', {
            at: new Date().toISOString(),
            event: 'pruned',
            removed: r.pruned.removed,
            kept: r.pruned.kept,
            skipped: r.pruned.skipped,
          })
        }
      }
    } catch (e) {
      logger?.warn?.(`fish-memory: 自动备份失败: ${e?.message || e}`)
    }
  }

  function memoryDir(sessionCwd) {
    const serviceCwd = host.serviceCwd()
    const next = resolveMemoryDir({ explicit, sessionCwd, serviceCwd })
    if (!dir) return initDir(next)
    if (next === dir) return dir
    // 拿不到会话 cwd（比如装配上下文里没有 agent）时，绝不把已确定的库切走，
    // 否则会在「会话目录」和「默认目录」之间来回抖，等于两套库轮流写。
    if (!explicit && !sessionCwd) return dir
    logger?.warn?.(`fish-memory: 记忆库切换 ${dir} → ${next}`)
    return initDir(next)
  }

  // 会话 cwd 的读法在 host 里（[HOST: data-session-header]）
  const sessionCwdOf = (agentOrSession) => host.sessionCwd(agentOrSession)

  const stateOf = (id) => {
    if (!perAgent.has(id))
      perAgent.set(id, {
        current: '',
        previous: { query: '', ids: [] },
        lastText: '',
        lastAt: 0,
        lastLogTick: -1,
        mode: 'daily',
        reasons: [],
        reanchor: false,
        lastAssistant: '',
        pressure: false,
        pressureRatio: null,
        selfDue: false,
        selfNotified: '',
        lastAbilityNames: [],
        handoffChecked: false,
        handoffText: null,
      })
    return perAgent.get(id)
  }

  // 检索日志：50_log/retrieval.log，一行一次装配（契约 §4.2）
  function logRetrieval(entry) {
    try {
      const p = join(dir, '50_log', 'retrieval.log')
      mkdirSync(join(dir, '50_log'), { recursive: true })
      appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      /* 日志失败不影响对话 */
    }
  }

  function logLine(file, entry) {
    try {
      mkdirSync(join(dir, '50_log'), { recursive: true })
      appendFileSync(join(dir, '50_log', file), JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      /* ignore: 日志失败不该影响对话（刻意的） */
    }
  }

  // ① 记档：用户消息（幂等由 seq 游标保证）
  host.effect(() => {
    const stop = host.onInbox(({ agent, message }) => {
      try {
        // [HOST: data-message-shape] 只认 source.kind === 'user'（宿主上下文走同一条通道）
        if (message?.source?.kind !== 'user') return
        memoryDir(sessionCwdOf(agent))
        const text = extractText(message)
        const st = stateOf(agent?.id || '')
        const lastAssistant = st.lastAssistant
        st.current = text
        st.lastAt = 0 // 新消息到达：上一轮的注入缓存立即失效

        // 模式判定（宁宽勿严）：这条消息要不要进任务模式
        const modeInfo = detectMode(text, { lastAssistantText: lastAssistant })
        st.mode = modeInfo.mode
        st.reasons = modeInfo.reasons

        // 提示注入隔离：不拦，标记；下一轮做一次锚点重注
        if (isInjectionSuspect(text)) {
          st.reanchor = true
          logLine('guard.log', { at: new Date().toISOString(), session: agent?.id, action: 'injection-suspect', text: text.slice(0, 80) })
        }

        // 空窗点：距上一条消息 > 24h，直接写草稿（不用模型）
        const prev = store.lastMessage()
        if (prev && message?.id) {
          const draft = buildGapDraft({
            dir,
            prev,
            next: { id: message.id, ts: new Date().toISOString() },
          })
          if (draft && writeGapDraft(draft)) {
            logLine('consolidation.log', { at: new Date().toISOString(), action: 'gap-draft', id: draft.id, days: draft.days })
          }
        }

        // 一轮 = 一条用户消息：重复衰减的 tick
        store.bumpTick()
        // 先建会话文件（同时记下「上一个会话」），否则首轮取不到工作记忆
        if (agent?.id) store.ensureSession(agent.id)
      } catch (e) {
        logger?.warn?.(`fish-memory: inbox 处理失败: ${e?.message || e}`)
      }
    })
    return () => stop?.()
  }, 'fish-memory.inbox()')

  // ② 记档：双向。她的回复走 session/event（不是 frozenMessages）
  host.effect(() => {
    const stop = host.onSessionEvent((session, event) => {
      try {
        if (!session?.id || !event) return
        // 子 agent 的工作对话不是「她和他」的记忆，不入档（[HOST: data-session-header]）
        if (host.delegationDepth(session) > 0) return
        memoryDir(sessionCwdOf(session))
        archive.handle(session.id, event)
        // 通道体检：host.log 里有 session 事件、却没有 inbox 事件 = inbox 那个事件名
        // 很可能在版更里改了。这是"事件名报错"唯一能被发现的地方——它不抛错。
        //
        // 但**不能一见就报**：插件中途重载时，宿主会先补发一批 session/event（补档，seq 都过游标），
        // 那一刻 inbox 还没轮到。v0.5.11 第一次上机就误报过一次（sawSession:4, sawInbox:0）。
        // 判定条件：过了宽限期 + ≥2 条新用户消息 + inbox 一次都没来过。
        if (event.type === 'user/message' && Number(event.seq) > archive.cursorOf(session.id)) {
          host.stats.userSeen += 1
          const gap =
            host.stats.inbox === 0 &&
            !host.stats.missingNoticed &&
            host.stats.userSeen >= 2 &&
            Date.now() - host.stats.attachAt > GAP_GRACE_MS
          if (gap) {
            host.stats.missingNoticed = true
            logger?.warn?.('fish-memory: 只见 session/event、不见 agent/inbox/inserted（宿主事件名可能变了，见 50_log/host.log）')
            logLine('host.log', {
              at: new Date().toISOString(),
              event: 'channel-gap',
              missing: 'event-inbox',
              sawSession: host.stats.session,
              sawInbox: host.stats.inbox,
              freshUserMessages: host.stats.userSeen,
              fix: 'lib/host.js 的 EVENTS.inbox',
            })
          }
        }
        // 宿主开始压缩 = 上下文到上限：先落一份"换窗交接包"
        // [HOST: event-compaction] 它不是独立事件，是 session/event 里的一个 type
        if (event.type === 'compaction/start') {
          try {
            const h = buildHandoff(dir, store.session(session.id))
            if (h) logLine('handoff.log', { at: new Date().toISOString(), session: session.id, tail: h.tail, threads: h.threads })
          } catch (e) {
            logger?.warn?.(`fish-memory: 交接包失败: ${e?.message || e}`)
          }
        }
        // 工作记忆与档案用同一个判据：宿主塞进来的上下文不进 tail
        if (isArchivable(event)) {
          // [HOST: data-event-shape] user/message 的 data 是消息本体；assistant/message 的在 data.message 里
          const msg = event.type === 'assistant/message' ? event.data?.message : event.data
          const text = extractText(msg)
          const ts = new Date(event.time || Date.now()).toISOString()
          if (text) {
            store.touchSession(session.id, {
              role: event.type === 'assistant/message' ? 'assistant' : 'user',
              text,
              ts,
            })
          }
          // 全局最后一条消息：空窗检测用
          if (msg?.id) store.setLastMessage({ id: msg.id, ts })

          // 金丝雀：她自称 AI → 记日志，不阻断
          if (event.type === 'assistant/message' && text) {
            const st = stateOf(session.id)
            st.lastAssistant = text
            // 复述回血：只有终稿才算。中间步骤（带 tool-call）不算"她提到了"，
            // 否则第一次工具调用就把 lastInjected 清空，后面真回复漏计。
            const isFinal = !(Array.isArray(msg?.content) && msg.content.some((b) => b?.type === 'tool-call')) // [HOST: data-message-shape]
            if (isFinal && st.lastInjected?.length) {
              for (const p of st.lastInjected) if (wasMentioned(p, text)) store.reinforce(p.id)
              st.lastInjected = []
            }
            // 能力记忆 applied：终稿里提到她刚被注入的技能名 → 记一次 used
            if (isFinal && st.lastAbilityNames?.length) {
              const used = st.lastAbilityNames.filter((n) => text.includes(n))
              logLine('ability.log', {
                at: ts,
                session: session.id,
                event: used.length ? 'used' : 'injected',
                names: st.lastAbilityNames,
                used,
              })
              st.lastAbilityNames = []
            }
            const hits = canaryHits(text)
            if (hits.length) {
              logLine('canary.log', {
                at: ts,
                session: session.id,
                seq: event.seq,
                excerpt: text.slice(0, 120),
              })
            }
          }
        }
      } catch (e) {
        logger?.warn?.(`fish-memory: session/event 处理失败: ${e?.message || e}`)
      }
    })
    return () => stop?.()
  }, 'fish-memory.archive()')

  // ②b 上下文压力：回合结束看用量，抢在宿主压缩前把原文包落地
  host.effect(() => {
    const stop = host.onTurnStopping(({ agent } = {}) => {
      try {
        if (!agent?.session || !dir) return
        const st = stateOf(agent.id)
        // 本月有内容但还没写自述：每天提醒一次（让她在收工后的空闲时间写）
        if (dueForSelf(dir)) {
          const today = localDay(new Date())
          if (st.selfNotified !== today) {
            st.selfDue = true
            st.selfNotified = today
            logLine('self.log', { at: new Date().toISOString(), session: agent.id, action: 'due' })
          }
        }
        const ratio = pressureRatio(
          host.tokenMeasure(agent.session), // [HOST: service-token-meter]
          contextWindowOf(agent.session, cfg.pressure?.contextWindow),
        )
        if (ratio == null || ratio < 0.7) return
        const seg = ensureSegmentPacket(dir)
        st.pressure = true
        st.pressureRatio = ratio
        logLine('pressure.log', {
          at: new Date().toISOString(),
          session: agent.id,
          ratio: +ratio.toFixed(2),
          segment: seg?.id || null,
          wrote: Boolean(seg?.wrote),
        })
      } catch (e) {
        logger?.warn?.(`fish-memory: 压力检测失败: ${e?.message || e}`)
      }
    })
    return () => stop?.()
  }, 'fish-memory.pressure()')

  // ③ 注入
  host.effect(() => {
    const dispose = host.inject({
      name: 'fish-memory',
      order: -300, // 核心层必须最靠前（总设计 §3.8 规则 1）
      text: (context) => {
        try {
          // 子 agent（工具人）不注入她的记忆：它不是她（[HOST: data-session-header]）
          if (host.delegationDepth(context?.agent) > 0) return ''
          memoryDir(sessionCwdOf(context?.agent))
          if (!existsSync(dir)) return ''
          const agentId = context?.agent?.id || ''
          const st = stateOf(agentId)
          const now = Date.now()
          // 同一步里可能多次装配：2 秒内复用，避免重复记 inj10
          if (st.lastText && now - st.lastAt < ASSEMBLE_CACHE_MS) return st.lastText

          const t0 = Date.now()
          const tick = store.state().tick
          const query = st.current
          // 配置终于生效：retrieval.threshold / recallLimit / maxEvents
          const rc = { ...DEFAULTS, ...(cfg.retrieval || {}) }
          // 打分只读轻量索引；正文只给最终选中的 ≤3 条 hydrate
          const points = store.indexPoints()
          const task = st.mode === 'task'
          let picked = []

          // 任务模式里只有"涉及过去"才检索关系记忆（能力记忆设计 §4.3 例外）
          const recall = !task || needsRelationshipRecall(query)
          if (recall && !isGated(query)) {
            const qs = bigrams(query)
            if (st.previous.ids.length && sameTopic(qs, bigrams(st.previous.query))) {
              const byId = new Map(points.map((p) => [p.id, p]))
              picked = st.previous.ids.map((id) => byId.get(id)).filter(Boolean)
            } else {
              // 先用倒排取候选，再打分；候选过大/为空则退回全量
              const cand = store.candidates(query)
              let pool = points
              if (cand) {
                const m = new Map(points.map((p) => [p.id, p]))
                pool = cand.map((id) => m.get(id)).filter(Boolean)
              }
              picked = pickByEvent(
                rankHybrid(pool, query, {
                  threshold: rc.threshold,
                  limit: rc.recallLimit,
                  weight: (p) => store.memoryWeight(p), // 弱记忆更难被想起
                  // 权重来自配置（retrieval.weights），缺的键由 mergeWeights 补默认值
                  weights: rc.weights,
                  // 稀疏补权（默认开）：没标签的点不该白丢 3 份权重
                  rebalance: rc.rebalance !== false,
                  // IDF（默认关）：量过本库金标零增益，留着给大语料用
                  idf: rc.idf ? store.idf() : undefined,
                  idfMode: rc.idfMode || 'min',
                }),
                rc.maxEvents,
              )
              st.previous = { query, ids: picked.map((p) => p.id) }
            }
          }
          picked = picked.map((p) => store.fullPoint(p)).filter(Boolean)
          st.lastInjected = picked
          // 场景展开：同 event 的其它点 + 沿 links 一跳（只做 idx 行，≤3 条）
          const pickedIds = new Set(picked.map((p) => p.id))
          const byId = new Map(points.map((p) => [p.id, p]))
          const related = []
          const addRelated = (q) => {
            if (!q || pickedIds.has(q.id) || related.some((r) => r.id === q.id)) return
            related.push(q)
          }
          for (const p of picked) {
            if (p.event) for (const q of points) if (q.event === p.event) addRelated(q)
            for (const l of p.links || []) addRelated(byId.get(l))
          }
          const relatedTop = related.slice(0, 3)
          // 到期复习：没有强命中、非任务模式时，拉一条快掉出阈值的记忆（≤60 tok）
          let review = ''
          if (!task && picked.length === 0) {
            const due = store.dueReview(new Date(now))
            const rp = due ? points.find((p) => p.id === due.id) : null
            if (rp) {
              const full = store.fullPoint(rp) || rp
              review = `- ${full.date || ''} ${full.title}：${String(full.summary || '').slice(0, 80)}`
              store.markReviewed(rp.id, new Date(now))
            }
          }
          const t1 = Date.now()

          // 任务模式：装能力记忆（预算 2400，按分数装，不按条数）
          let ability = ''
          let abilityPicked = []
          if (task) {
            const cand = rankAbilities(scanAbilities(dir), query)
            const laid = layoutAbilities(cand, 2400)
            const tools = renderTools(dir)
            const inner = [tools, laid.text].filter(Boolean).join('\n\n')
            if (inner) {
              ability = [
                '<!-- 你会做的事 -->',
                '以下是你会的事。用之前先确认前提条件，不适用就直说。',
                inner,
                '<!-- /你会做的事 -->',
              ].join('\n\n')
            }
            abilityPicked = laid.picked
            // 记一次"注入过"，供能力记忆的 applied 统计
            st.lastAbilityNames = cand.filter((a) => laid.picked.includes(a.id)).map((a) => a.name)
          }

          const keyPoints = points
            .filter((p) => p.key)
            .slice(0, 3)
            .map((p) => store.fullPoint(p))
            .filter(Boolean)
          // 有印象但想不起来：dormant 的点只给一行标题
          const ghosts = dormantPoints(dir).slice(0, 5)

          const result = assemble({
            store,
            query,
            sessionId: agentId,
            budget,
            mode: task ? 'task' : 'daily',
            ability,
            keyPoints,
            ghosts,
            related: relatedTop,
            retrieve: () => picked,
          })
          let text = result.text
          // 到期复习：快掉出阈值的记忆，拉一次
          if (review && text) text = `<!-- 复习 -->\n${review}\n<!-- /复习 -->\n\n${text}`
          // 新会话第一轮：读一次上一个窗口的交接包（同一会话不读自己）
          if (!st.handoffChecked) {
            st.handoffChecked = true
            const h = takeHandoff(dir, agentId)
            if (h) st.handoffText = h
          }
          if (st.handoffText && text) {
            text = `${st.handoffText}\n\n${text}`
            st.handoffText = null
          }
          // 上一轮检测到注入 → 这一轮做一次锚点重注（不占预算）
          if (st.reanchor && text) {
            text = `${reanchorBlock()}\n\n${text}`
            st.reanchor = false
          }
          // 上一轮上下文压力 → 提醒先压（只贴一次）
          if (st.pressure && text) {
            text = `${pressureNote(st.pressureRatio)}\n\n${text}`
            st.pressure = false
            st.pressureRatio = null
          }
          // 自述到期：提醒一次（收工后的空闲时间写，不打断当前对话）
          if (st.selfDue && text) {
            text = `${[
              '<!-- 自述提醒 -->',
              '这个月还没写自述。等这轮结束、你收工后的空闲时间再写——不要现在打断。',
              '素材包用 `memory self-pack` 生成到 `40_pending/_self/`（高显著度点 + 原话）；',
              '草稿写 `40_pending/_self/YYYY-MM.draft.md`：五节（最后一节是「和核心层对照」）、≤400 字；',
              '写完用 `memory self-promote YYYY-MM` 提上来——不合格会被挡回，`15_self/` 不动。他过目后才算数。',
              '<!-- /自述提醒 -->',
            ].join('\n')}\n\n${text}`
            st.selfDue = false
          }
          // 话题涉及情绪/关系/变化 → 带最近一篇自述（默认不进每轮）
          if (SELF_TOPIC.test(query)) {
            const self = latestSelf(dir)
            if (self) text = `${text}\n\n${renderSelfBlock(self.slice(0, 1600))}`
          }
          const tokens = estTokens(text)
          if (result.rendered.length) store.recordInjection(result.rendered, tick)
          if (st.lastLogTick !== tick) {
            st.lastLogTick = tick
            logRetrieval({
              at: new Date(now).toISOString(),
              // 只记目录名，不记绝对路径（v0.14.1）：这条日志会随库被云盘/备份带走，
              // 而绝对路径里有 Windows 用户名。目录名足够看出"库解析有没有跑偏"。
              lib: basename(dir),
              session: agentId,
              tick,
              query: String(query).slice(0, 60),
              gated: isGated(query),
              mode: task ? 'task' : 'daily',
              // 生效的打分参数也记一行：改配置没生效时，看这里就知道用的是哪一组
              weights: rc.weights ? mergeWeights(rc.weights) : undefined,
              scoring: { rebalance: rc.rebalance !== false, idf: Boolean(rc.idf), idfMode: rc.idfMode || 'min' },
              reasons: st.reasons,
              ability: abilityPicked,
              rendered: result.rendered,
              dropped: result.dropped,
              coreDropped: result.coreDropped,
              tokens,
              ms: { retrieve: t1 - t0, total: Date.now() - t0 },
            })
          }
          if (result.rendered.length) {
            logger?.info?.(
              `fish-memory: 注入 ${result.rendered.length} 条 / 约 ${tokens} tok` +
                (result.dropped.length ? ` / 预算丢弃 ${result.dropped.length}` : ''),
            )
          }
          st.lastText = text
          st.lastAt = now
          return text
        } catch (e) {
          logger?.warn?.(`fish-memory: assemble failed: ${e?.message || e}`)
          return ''
        }
      },
    })
    return () => dispose?.()
  }, 'fish-memory.inject()')

  // ③b 翻档案工具：想不起来时去查原文，而不是编
  host.effect(() => {
    const dispose = host.tool({
      name: 'memory_recall',
      description:
        '在长期记忆的原始档案里查原话。当你对某件事的细节没把握时用它核对；返回带消息 id 的原文片段。找不到就明说没有，不要据此猜测。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要查的词或短语（尽量短）' } },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        const q = String(args?.query || '').trim()
        if (!dir) return { text: '记忆库还没就绪。' }
        if (!q) return { text: '要给一个词或短语。' }
        return { text: renderRecall(searchArchive(dir, q, { limit: 5 })) }
      },
      timeoutMs: 3000,
    })
    return () => dispose?.()
  }, 'fish-memory.recallTool()')

  // ④ 退出前落盘
  host.effect(
    () => () => {
      try {
        skillDispose?.()
      } catch {
        /* ignore: 卸载技能失败不影响退出 */
      }
      try {
        backupStop?.()
      } catch {
        /* ignore: 停备份失败不影响退出 */
      }
      try {
        unlinkSync(join(dir, '20_state', 'boot.json'))
      } catch {
        /* ignore: boot.json 删不掉就算了，下次启动会覆盖 */
      }
      store?.dispose()
    },
    'fish-memory.flush()',
  )

  // 测试挂钩：不参与业务（[HOST: test-hook] 经 host 转手，生产无影响）
  host.testHook('fishMemory', () => ({ store, archive, dir, host, get ready() { return Boolean(dir) } }))
}
