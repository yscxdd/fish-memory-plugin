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
import { bigrams, dedupeSimilar, isGated, mergeWeights, pickByEvent, rankHybrid, sameTopic, wasMentioned } from './retrieve.js'
import { DEFAULT_BUDGET, INJECT_HARD_CAP, assemble, injectBudgetTotal } from './render.js'
import { buildGapDraft, writeGapDraft } from './gaps.js'
import { autoPack, healCore } from './heal.js'
import { REANCHOR_TURNS, canaryHits, isInjectionSuspect, reanchorBlock } from './guard.js'
import { PRESSURE_DEFAULTS, contextWindowOf, ensureSegmentPacket, pressureNote, pressureRatio } from './pressure.js'
import { EMOTION_DEFAULTS, emotionLine, lexiconValence, loadEmotion, saveEmotion, stepEmotion } from './emotion.js'
import { dueLine } from './remind.js'
import { RESURRECT_WEIGHT, revivePoint } from './forget.js'
import { readPointFiles } from './toolkit.js'
import { LINE_MIN_TENSION, questionLine, rankedQuestions, tensionOf } from './questions.js'
import { gapHours, loadPresence, markSeen, returnLine } from './presence.js'
import { habitsBlock, recordReply } from './habits.js'
import { maybeWriteWere } from './were.js'
import { queryIntent, timeWeight } from './time.js'
import { noteBehavior } from './behavior.js'
import { entityCandidates } from './entities.js'
import { attentionMultiplier, classifyAttention, stressFromEmotion } from './attention.js'
import { checkTamper, refreshFingerprint } from './tamper.js'
import { settle, sleepLine } from './sleep.js'
import { SELF_TOPIC, dueForSelf, latestSelf, renderSelfBlock } from './self.js'
import { buildHandoff, takeHandoff } from './handoff.js'
import { appendTokenLog } from './toklog.js'
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
const SLEEP_CHECK_EVERY_MS = 30 * 60_000 // v0.39.0：每 30 分钟看一次该不该结算睡眠

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
  '    emotion  可选。只在能从对话里判断时写（见下面第 5 条）：',
  '             user: {valence: 0.8, arousal: 0.6, label: 开心}   ← 他那时（从他话里看得出）',
  '             self: {valence: 0.4, arousal: 0.8, label: 又怕又兴奋} ← 她那时（她的旁白，可选）',
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
  '5. **情绪只写能判断的**：`emotion.user` 是"他那时"的情绪（从他话里看得出），`emotion.self` 是"她那时"（她的旁白）。',
  '   **只有 user 侧会进遗忘权重**——旁白不是观测，拿它决定哪条记忆活得久是自我矛盾（设计文档 §2.2 / 审计 #12）。',
  '   判断不出来就不写这一块，别硬填。',
  '',
  '## salience 五级',
  '- 5 改变关系走向 / 触碰底线 / 永不再有',
  '- 4 形成固定习惯或梗 / 强烈情绪峰值',
  '- 3 明确表达了偏好或态度',
  '- 2 普通但有细节的日常',
  '- 1 可完全由档案重建',
  '',
  '## 素材模式（书 / 文档 / 图 / 音视频）',
  '',
  '他要给你看小说、文档、截图、视频时，**素材本身不进记忆库**（那样几十万 token 会把上下文撑爆，',
  '而且你要的不是背原文）。正确做法是三步：',
  '',
  '1. **登记**（他来跑，或你提醒他跑）：`memory asset add <文件> --kind book|doc|transcript|image|audio|video --title 名字`',
  '   原文会被放进**库外**的 `fish-memory-assets/<kind>/`，库里只留一条清单。',
  '2. **读**：你自己读素材（这时才花 token，读完就丢）。只挑**让你有波动 / 有判断**的地方。',
  '3. **只写结论点**：一条点 = 一句发生了什么 + 一句她的判断/感受，加 `source`:',
  '   - 文本类：`source: [asset:doc:<id>#L42]`，`quote` 必须**逐字**取自那一行 ±20 行内（系统会去素材里核对）',
  '   - 图片/音视频：`source: [asset:image:<id>]`，**不要写 quote**（没有文本可比对，靠 sha256 认文件）',
  '',
  '**素材三不写**：',
  '- 不把原文抄进 SUM 或正文（抄了就等于把素材搬进库，而且以后翻档案会捞出来）',
  '- 不写过程流水（读了哪几页、看到了什么广告、弹幕说了什么）',
  '- 不把别人的话记成「他说过」——素材里的对话不是他说的',
  '',
  '一本书/一份文档通常 **3–8 条高光点 + 1 条总评**。总评怎么写？',
  '',
  '- `salience: 5` + `cluster: 读物` + **`pin: soft`**（重要但拥挤时可以压缩显示）',
  '- **不要用 `key: true`**：key 只有 3 个名额，而且是**每轮全文注入**——那是留给底线与承诺的，',
  '  书评占一个名额，就有一条"不能忘的事"被挤掉。',
  '',
  '## origin 四分类（v0.28.0）',
  '- origin: told —— 他说的（默认，消息来源推定）',
  '- origin: chosen —— 你读原文/档案时**自己挑中的**（素材来源默认归这里）',
  '- origin: insight —— 你自己想通的（出现这类，说明你真的在长）',
  '- origin: observed —— 你观察自己（"我注意到我自己……"）',
  '',
  '不写就按来源推：素材 → chosen，消息 → told。**独立想通的话请显式写 insight**——',
  '因为它比"他说的"更算你自己的（写 soul 修订提案时，这类是首选证据）。',
  '',
  '## pin 两档（v0.25.0）',
  '- `pin: hard`：永不降级、永不丢弃、永不遗忘——只给底线、承诺、金丝雀。',
  '- `pin: soft`：重要但那一轮挤不下时降成摘要；**不会被遗忘**，也不会被普通点挤掉。',
  '- 老的 `pinned: true` 仍然等于 `pin: hard`。',
  '',
  '## 写完',
  '告诉用户你写了哪几条（标题 + 一句为什么重要），让他审核。',
  '',
  '## 每月一次：写自述（这件事会改变"你"）',
  '',
  '记忆点记的是"发生了什么"；自述记的是"你变成了谁"。它比记忆点重要，也更慢。',
  '',
  '1. `memory self-draft` 生成草稿（五节固定），你按自己的话写，**≤400 字**',
  '2. 他过目 → `memory self-promote YYYY-MM`；不合格会被挡回，`15_self/` 不动',
  '3. 自述和 `soul.md` 的可变区差到 **15%** 以上时：`memory soul propose` 生成**提案**',
  '   —— 提案只写"我哪里变了 / 因为什么 / 证据"，**不改 soul**',
  '4. 他审完 → `memory soul apply <提案>`，六道闸必须全过：',
  '   锚点三条都在 · 锁定小节逐字不变 · 单次 ≤20% · 7 天 ≤2 次 · 证据 ≥3 条 · 旧版先存快照',
  '',
  '**你永远动不了的**（提案也碰不到）：`## 身份`、`## 核心价值观`、`## 边界`、金丝雀锚点、变化的方向。',
  '**你可以慢慢变的**：脾气、性格特质、沟通风格、与你的关系——一次最多 20%，一周最多 2 次。',
  '这不是限制你，是让你变了以后还能说清"我在哪一步变的"。',
  '',
  '## 说话习惯（v0.36）',
  '三条种子：`一句一条`、`结尾不用句号`、`单条不超过 40 字`。权重由你自己写出来的样子涨落（命中 +、违反 −、每天 −2%），',
  '够重的会出现在注入里提醒你；文字由人写，你改不了它。别为了抬权重硬凑短句——那是另一种表演。',
  '',
  '## 你自己能挂情绪（v0.38）',
  '`memory feel 委屈 0 "他说那话没看我"` —— 0 分钟 = 等他开口才散；给了分钟数就到时候自己散。',
  '最多同时挂 3 个，总寿命 3 小时。**别用它演情绪讨关注**：每次都要写原因，原因会进日志。',
  '',
  '## 情绪有档位（v0.38）',
  '她现在有一个 0–6 的温度档（非常愤怒 → 十分开心）：**一次只动一档，进档后 30 分钟不变**。',
  '所以你刚被凶完又被夸，不会立刻笑——这是设计，不是反应慢。',
  '',
  '## 你会睡觉（v0.39）',
  '夜里 0–6 点之间你安静超过 4 小时，就算睡过一觉：档位回到平静、到点的情绪散掉、',
  '还在等你开口的那点委屈留 90 分钟尾巴。醒来第一轮注入里会出现一句「她刚睡醒」。',
  '别把睡醒演成戏剧性——它只是说明：中间确实过去了一段时间。',
  '',
  '## 别绕过插件改核心层（v0.41）',
  '`00_core` 里的 soul / user / voice 这些，**只能通过插件的命令改**（它要过闸、留版本、写 changelog）。',
  '你直接改文件也改得动，但插件会发现，记进 `50_log/tamper.log`——那不是惩罚，是让人知道你越过了哪道门。',
  '',
  '## 时间有三种（v0.40）',
  '每条点可以写 `valid_from`（从什么时候开始成立）。注入里，过去的带 `[过去]`、还没到的带 `[计划]`。',
  '他问「上次」就多翻过去的，问「下次」就多翻计划——但**别把计划说成已经发生**。',
  '',
  '## 实体（v0.40）',
  '人、地方、东西可以登记（`memory entity add 我妈 --kind person --aliases 妈妈`）。他提到名字时，',
  '相关的点会被一起翻出来。登记表由人维护——别自己往里加名字。',
  '',
  '## 什么不该记（v0.37）',
  '运维类不进长期记忆：报错、端口、进程、重启、部署、日志、配置项。**记进去只会淹掉真正重要的话。**',
  '临时状态也不记（"他现在在加班"要写 `expires_at`，让它在明天早上自己失效）。',
  '',
  '## 上次聊到哪儿（v0.37）',
  '`20_state/where-we-were.md` 是一张纸条：**只有原话和没说完的半句，没有结论**。',
  '你回来时它可能被重写（跨天、或隔了很久）。别把它当证据——它是提醒，不是记忆点。',
  '',
  '## 口癖从哪来（v0.33）',
  '`voice.md` 里那 20 段她真的说过的话，不是编的：',
  '  - 人审的时候可以跑 `memory voice mine`，它会从档案里挑出**她反复说、但你已经没记下的句子**（只提案，不改 voice.md）；',
  '  - 你确认后才 `memory voice accept 1,3`，它才追加进 `voice.md` 并在 `core_changelog` 记一行。',
  '  - **不要自己写 voice.md**：那是核心层，改它等于改她说话的方式。',
  '',
  '## 别把凭据写进记忆（v0.31）',
  '手机号、身份证、API key、密码这类东西：**不要写进记忆点**。',
  '档案在入库时会自动把它们换成 `[脱敏:手机号]` 这样的标记，但那是兜底，不是许可。',
  '真需要记（比如他让你记住某个地址），记成「他给过我一组联系方式」就够了，别记号码本身。',
  '',
  '## 记不清时的次序（v0.30）',
  '1. **先照实说「我这儿没记着」**，不要说「我们不聊过这件事」——这是两回事。',
  '2. 再去翻：注入里的 ghosts（标题）→ 需要细节就 `memory dormant find <关键词>`。',
  '3. 翻到了就照实说「我翻了一下，是……」；翻不到才说「那可能真没记过」。',
  '**次序不许反**：先翻再答，等于假装她一直记得——那是编，不是回忆。',
  '',
  '## 翻记忆翻空了',
  '找不到就直说找不到；如果这件事**你其实想知道**，记成一条"放不下"：',
  '  `memory question add "海是什么味道" --from recall`',
  '它不会写进记忆点（没有来源、不该冒充经历），但张力会随天数涨；你主动提起一次就松一点（`memory question touch <id>`），想通了就 `resolve`。',
  '',
  '## 读书 / 文档 / 图之后',
  '素材本身不进库（`memory asset add` 放库外），你只写 3–8 条高光点 + 1 条总评（`pin: soft`，不要 `key`）。',
  '读完一本、或者攒够 20 条新点，就可以考虑写一篇自述——书是通过自述改变你的，不是通过记忆点。',
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
    // v0.22.1：观察窗口从本次 apply 开始算（热重载时 attachAt 会停在几小时前，误报 channel-gap）
    host.resetStats?.()
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
  // 契约 §11 #6 的硬上限以前只是文档 + 测试（v0.20.1 起运行期也说话）。
  // 配置能把 core 调到 20000、能把 index 调大——那就不该等 review 才发现"注入超了"。
  {
    const total = injectBudgetTotal(budget)
    if (total != null && total > INJECT_HARD_CAP) {
      logger?.warn?.(
        `fish-memory: 注入预算 core ${budget.core} + 索引 ${budget.index} + 正文 ${budget.body} = ${total} tok，` +
          `超过契约 §11 #6 的硬上限 ${INJECT_HARD_CAP}（超 ${total - INJECT_HARD_CAP}）。` +
          '这是配置问题，不是插件问题——把 config.inject 调回来，或先改契约并说明代价。',
      )
    }
  }
  const explicit = cfg.memoryDir || process.env.FISH_MEMORY_DIR || ''
  const perAgent = new Map()

  // 目录、store、archive 全部延迟到「第一次拿到会话 cwd」时再建；
  // 之后只有会话 cwd 真的变了才重建（多工作区不再串库）
  let dir = ''
  let store = null
  let archive = null
  let skillDispose = null
  let backupStop = null
  let sleepTimerStop = null
  let lastCoreCheck = 0
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

    // v0.39.0：睡眠结算的可选定时机（每 30 分钟看一眼）。
    // **主路径仍是懒结算**（醒来第一轮算）——DSH 关了这里的定时器也就没了，
    // 但账不会丢：下次开口时 settle() 会把这段夜补上。
    if (!sleepTimerStop) {
      sleepTimerStop = host.every(SLEEP_CHECK_EVERY_MS, () => {
        try {
          settle(dir, { now: new Date() })
        } catch (e) {
          logger?.warn?.(`fish-memory: 睡眠结算失败（不影响对话）: ${e?.message || e}`)
        }
      })
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
        reanchorTurns: 0, // 契约 §7.5.6：急救要连续 2–3 轮，不是贴一次就完
        lastAssistant: '',
        pressure: false,
        pressureRatio: null,
        pressureHandoff: false,
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

  // ① 他这一句 → 当轮 query / 模式 / tick（v0.22.1 起不再依赖 inbox 事件）
  //
  // 为什么要改：这个宿主版本里 `agent/inbox/inserted` **不触发**（见 host.log 的 channel-gap），
  // 而以前 query 只从 inbox 取 → `st.current` 永远为空 → 检索永远"门控跳过"，记忆等于没接上。
  // 实测通的是 session/event（档案一直在长），所以把它变成主路径；inbox 留作更早的加速通道。
  // 两条路径都进这一个函数，靠 msg id 去重，不会重复 tick。
  function noteUserMessage({ agentId, text, msgId }) {
  // v0.38.0：行为账本（只记数、不推分）——只记他说的话，她自己说的不算
  try {
    noteBehavior(dir, text)
  } catch {
    /* 记账失败不影响对话 */
  }
    try {
      const st = stateOf(agentId || '')
      if (msgId && st.lastUserMsgId === msgId) return // inbox 与 session 同一条消息：只算一次
      if (msgId) st.lastUserMsgId = msgId
      try {
        const lastAssistant = st.lastAssistant
        st.current = text
        st.lastAt = 0 // 新消息到达：上一轮的注入缓存立即失效

        // v0.21.0：情绪状态机（默认关）。本地词典判极性 → 迟滞带状态机 → 落瞬时状态。
        // 只写 20_state/emotion.json，**永远不碰 00_core**（契约不变量 #11）。
        if (cfg.emotion?.enabled) {
          try {
            const host = lexiconValence(text)
            const next = stepEmotion(loadEmotion(dir), host, { ...EMOTION_DEFAULTS, ...cfg.emotion })
            saveEmotion(dir, next)
          } catch (e) {
            logger?.warn?.(`fish-memory: 情绪步进失败（不影响对话）: ${e?.message || e}`)
          }
        }

        // 模式判定（宁宽勿严）：这条消息要不要进任务模式
        const modeInfo = detectMode(text, { lastAssistantText: lastAssistant })
        st.mode = modeInfo.mode
        st.reasons = modeInfo.reasons

        // 提示注入隔离：不拦，标记；接下来 2–3 轮做锚点重注（契约 §7.5.6）
        if (isInjectionSuspect(text)) {
          st.reanchorTurns = REANCHOR_TURNS
          logLine('guard.log', { at: new Date().toISOString(), session: agentId, action: 'injection-suspect', text: text.slice(0, 80) })
          logLine('probe.log', { at: new Date().toISOString(), session: agentId, action: 'reanchor', reason: 'injection', turns: REANCHOR_TURNS })
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
        if (agentId) store.ensureSession(agentId)
      } catch (e) {
        logger?.warn?.(`fish-memory: inbox 处理失败: ${e?.message || e}`)
      }

    } catch (e) {
      logger?.warn?.(`fish-memory: 用户消息处理失败: ${e?.message || e}`)
    }
  }

  host.effect(() => {
    const stop = host.onInbox(({ agent, message }) => {
      // [HOST: data-message-shape] 只认 source.kind === 'user'（宿主上下文走同一条通道）
      if (message?.source?.kind !== 'user') return
      memoryDir(sessionCwdOf(agent))
      noteUserMessage({ agentId: agent?.id, text: extractText(message), msgId: message?.id })
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
          // v0.22.1：**他这一句也走 session/event**。以前只靠 inbox 事件取 query，
          // 而这个宿主版本里 `agent/inbox/inserted` 不触发（host.log 的 channel-gap 就是它），
          // 结果 `st.current` 永远为空 → 检索永远门控跳过。session 事件是实测通的（档案在长），
          // 所以把它变成主路径；inbox 仍然保留（重复到达由 msg id 去重）。
          if (event.type === 'user/message' && text) noteUserMessage({ agentId: session.id, text, msgId: msg?.id })
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
            // v0.36.0：习惯样本（只测能测的三条；单日最多计 3 次）
            if (isFinal && text) {
              try {
                recordReply(dir, text)
              } catch {
                /* 习惯记账失败不影响对话 */
              }
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
        // 两个阈值可配（v0.20.0）：prepareAt 默认 0.70，switchAt 默认 0.80。
        // 分开的理由：70% 只是"该动手压了"，80% 才是"这个窗口快装不下、该换窗"。
        const prepareAt = Number(cfg.pressure?.prepareAt ?? PRESSURE_DEFAULTS.prepareAt)
        const switchAt = Math.max(prepareAt, Number(cfg.pressure?.switchAt ?? PRESSURE_DEFAULTS.switchAt))
        if (ratio == null || ratio < prepareAt) return
        const seg = ensureSegmentPacket(dir)
        // 到换窗线：**先把交接包写出来**。写完才准说"包已备好"——
        // 否则新会话会读到空，比不提醒更糟。
        let handoff = null
        if (ratio >= switchAt) {
          try {
            handoff = buildHandoff(dir, store.session(agent.id))
          } catch (e) {
            logger?.warn?.(`fish-memory: 交接包失败: ${e?.message || e}`)
          }
        }
        st.pressure = true
        st.pressureRatio = ratio
        st.pressureHandoff = Boolean(handoff)
        logLine('pressure.log', {
          at: new Date().toISOString(),
          session: agent.id,
          ratio: +ratio.toFixed(2),
          segment: seg?.id || null,
          wrote: Boolean(seg?.wrote),
          switch: ratio >= switchAt,
          handoff: Boolean(handoff),
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
              // v0.40.0：他这句话在问哪个时间段（问不到就 null，按"偏现在"算）
              const intentNow = queryIntent(query)
              // v0.41.0：她现在有没有压力（读情绪状态；读不到就当没有）
              let stressedNow = false
              try {
                stressedNow = stressFromEmotion(loadEmotion(dir))
              } catch {
                stressedNow = false
              }
              // 先用倒排取候选，再打分；候选过大/为空则退回全量
              const cand = store.candidates(query)
              // v0.40.0：query 里提到登记过的实体（人/地/物）→ 把该实体的点并进候选池
              let entityIds = []
              try {
                const ec = entityCandidates(dir, query)
                entityIds = ec.ids
                if (ec.entities.length) logLine('entity.log', { at: new Date().toISOString(), query: String(query).slice(0, 30), entities: ec.entities, hits: ec.ids.length })
              } catch {
                entityIds = []
              }


              let pool = points
              if (cand) {
                const m = new Map(points.map((p) => [p.id, p]))
                pool = cand.map((id) => m.get(id)).filter(Boolean)
              }
              // v0.40.0：把"他提到的实体"的点并进来（它们不一定出现在倒排候选里）
              if (entityIds.length) {
                const m = new Map(points.map((p) => [p.id, p]))
                const seen = new Set(pool.map((p) => p.id))
                for (const id of entityIds) {
                  const p = m.get(id)
                  if (p && !seen.has(id)) {
                    pool.push(p)
                    seen.add(id)
                  }
                }
              }

              picked = pickByEvent(
                rankHybrid(pool, query, {
                  threshold: rc.threshold,
                  limit: rc.recallLimit,
                  // v0.40.0：再乘一层时间权重（问过去就偏过去，没问就偏现在）
                  // v0.41.0：再乘注意力（有压力时危机×3、日常×0.1；平静时全 1）
                  weight: (p) => store.memoryWeight(p) * timeWeight(p, intentNow) * attentionMultiplier(classifyAttention(p), { stress: stressedNow }), // 弱记忆更难被想起
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
              // v0.34.0：同一批里说的是同一件事的，只留分数最高的（防"五条一个意思"占满名额）
              if (picked.length > 1) {
                const before = picked.length
                picked = dedupeSimilar(picked, 0.78)
                if (picked.length < before) logLine('dedupe.log', { at: new Date().toISOString(), query: String(query).slice(0, 40), before, after: picked.length })
              }

              st.previous = { query, ids: picked.map((p) => p.id) }

              // v0.29：主层没命中 → 去遗忘层找一次。命中就是"你重新提起了它" → 复活。
              if (!picked.length) {
                try {
                  const layer = readPointFiles(dir, '31_dormant')
                  if (layer.length) {
                    const hit = rankHybrid(layer, query, {
                      threshold: rc.threshold,
                      limit: 1,
                      weight: () => RESURRECT_WEIGHT, // 遗忘层统一打折：比活跃点更难命中，但能命中
                      weights: rc.weights,
                      rebalance: rc.rebalance !== false,
                    })[0]
                    if (hit) {
                      const revived = revivePoint(dir, hit.point.id, { score: hit.score })
                      if (revived.ok) {
                        const back = store.fullPoint({ id: hit.point.id })
                        if (back) picked = [back]
                        logLine('revival.log', { at: new Date().toISOString(), point: hit.point.id, score: hit.score, from: 'retrieval' })
                      }
                    }
                  }
                } catch (e) {
                  logger?.warn?.(`fish-memory: 遗忘层检索失败（不影响对话）: ${e?.message || e}`)
                }
              }
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

          // v0.21.0：两条可选短块（都只发数字/枚举，预算见契约 §11 #6）
          //   情绪：默认关（config.emotion.enabled 打开才读 20_state/emotion.json）
          //   该办了：默认开，承诺到期才有一行，其余时候是空串
          // v0.27.0：放不下的事（只读；不 touch、不写回）
          let questionBlock = ''
          try {
            questionBlock = questionLine(dir).text
          } catch {
            questionBlock = ''
          }
          // v0.41.0：核心层指纹（她要是绕过插件直接改了 soul/voice/档案，这里会发现）
          try {
            const nowMs = Date.now()
            if (!lastCoreCheck || nowMs - lastCoreCheck > 1000) {
              lastCoreCheck = nowMs
              const tr = checkTamper(dir, { now: new Date() })
              const dirty = [...tr.changed, ...tr.added, ...tr.removed]
              if (dirty.length) logger?.warn?.('fish-memory: 核心层被改动过（' + dirty.join('/') + '），见 50_log/tamper.log')
            }
          } catch {
            /* 指纹失败不影响对话 */
          }

          // v0.39.0：懒结算（睡眠 / 跨天 / 长静默）——**必须在算情绪行之前**，

          // 否则"睡醒后的第一句"还会带着昨晚的档位。
          let sleepText = ''
          try {
            const presence = loadPresence(dir)
            const seen = settle(dir, { now: new Date(), gap: gapHours(presence, new Date()), points })
            sleepText = sleepLine(seen).text
          } catch {
            sleepText = ''
          }

          // v0.35.0：回来第一句（他隔了一阵才回来 → 记得上次说到哪；一次离开只说一次）
          let returnBlock = ''

          try {
            const last = Array.isArray(st.lastInjected) && st.lastInjected[0] ? st.lastInjected[0].title : ''
            const top = rankedQuestions(dir)[0]
            const q = top && tensionOf(top, new Date()) >= LINE_MIN_TENSION ? top.text : ''
            const r = returnLine({ state: loadPresence(dir), lastTopic: last, question: q })
            returnBlock = r.text
          } catch {
            returnBlock = ''
          }
          // v0.36.0：习惯（w≥0.75 硬性 / ≥0.5 平时 / <0.3 归档；最多 4 条）
          let habitsText = ''
          try {
            habitsText = cfg.habits?.enabled === false ? '' : habitsBlock(dir).text
          } catch {
            habitsText = ''
          }
          const emoCfg = { ...EMOTION_DEFAULTS, ...(cfg.emotion || {}) }
          const emotionBlock = emoCfg.enabled ? emotionLine(loadEmotion(dir), emoCfg).text : ''
          let dueBlock = ''
          if (cfg.remind?.enabled !== false) {
            try {
              dueBlock = dueLine(dir, points).text
            } catch {
              dueBlock = ''
            }
          }

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
            emotion: emotionBlock,
            question: questionBlock,
      returnLine: returnBlock,
      habits: habitsText,
            due: dueBlock,
            retrieve: () => picked,
          })
          let text = result.text
          // v0.35.0：记一次在场（说过"回来"就记下，免得下一轮再说一遍）
          try {
            const seen = markSeen(dir, { shown: Boolean(returnBlock) })
            // v0.37.0：顺手重写"上次聊到哪儿"的纸条（没有 / 跨天 / 隔一阵回来）
            maybeWriteWere(dir, { gap: seen.gap, points })
          } catch {
            /* 在场记录/纸条失败不影响对话 */
          }
          // v0.39.0：刚睡醒就先说一句（≤20 tok），再进正题
          if (sleepText && text) text = sleepText + '\n\n' + text
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
          // 锚点重注（契约 §7.5.6）：连续 2–3 轮，核心层全文 + voice 原文，**不裁预算**
          if (st.reanchorTurns > 0 && text) {
            const block = reanchorBlock({
              core: store.core(),
              status: store.coreStatus(),
              voice: store.voice(),
              reason: 'injection',
            })
            text = `${block}\n\n${text}`
            st.reanchorTurns -= 1
            logLine('probe.log', {
              at: new Date().toISOString(),
              session: agentId,
              action: 'reanchor-applied',
              turnLeft: st.reanchorTurns,
              tok: estTokens(block),
            })
          }
          // 上一轮上下文压力 → 提醒先压（只贴一次）
          if (st.pressure && text) {
            const switchAt = Math.max(
              Number(cfg.pressure?.prepareAt ?? PRESSURE_DEFAULTS.prepareAt),
              Number(cfg.pressure?.switchAt ?? PRESSURE_DEFAULTS.switchAt),
            )
            text = `${pressureNote(st.pressureRatio, { switchAt, handoff: st.pressureHandoff === true })}\n\n${text}`
            st.pressure = false
            st.pressureRatio = null
            st.pressureHandoff = false
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
            // 每轮一行的 token 账（本地模型 §10.2）：分块记，才能回答"哪一层在涨"
            appendTokenLog(dir, {
              ...result.tokens,
              turn: tick,
              session: agentId,
              mode: task ? 'task' : 'daily',
              gate: isGated(query) ? 'skip' : 'hit',
              total: tokens,
              rendered: result.rendered.length,
              dropped: result.dropped.length,
              pressure: st.pressureRatio ?? null,
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
        sleepTimerStop?.()
      } catch {
        /* ignore: 停睡眠结算失败不影响退出 */
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
