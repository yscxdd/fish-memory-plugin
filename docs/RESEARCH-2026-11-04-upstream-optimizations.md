# 上游优化点清单 · 2026-11-04

> 读法：每条 = **现状证据（本仓库文件/函数）→ 外部依据（论文/项目 + 可核对的数字）→ 改法 → 代价 → 验收**。
> 只收"能落到这个库的架构上"的，不收"换个框架重写"的。
> 与本仓库 `PLAN-2026-11-04-gap-closure.md` 的关系：那份解决"库是空的"，这份解决"库里有了之后，能不能找回来、能不能证明找回来了"。

---

## 0. 先给三条判断

**判断一：存储层的方向，2026 年的主流已经反过来站到你这边了。**

Mem0 在 2025 版是 `ADD/UPDATE/DELETE/NOOP` 四操作、矛盾就硬删；2026 版改成了**单遍 ADD-only**——只新增、不覆盖，陈旧性用 0.3×–1.5× 的**软重排**处理，不删任何东西（LoCoMo 92.5 / LongMemEval 94.4，每次检索 <7K tok，全上下文方案 25K+）。Zep 则是"矛盾时写 `invalid_at`、保留历史"。你现在的 `10_archive` 逐字追加 + `30_points` 的 `invalid_at` + 墓碑，是同一套结论的另一种写法。**别改这条路。**

**判断二：真正落后的是检索和评估，不是存储。**

`lib/retrieve.js` 只有一条通道：`normalize()` 剥掉所有非 CJK/字母数字 → `bigrams()` 二字组 → 重合率过 0.8。我拿 6 组样本实测（见 A1 的表），**同义改述两路都是 0.00**——"这膝盖疼得要命" vs "关节不舒服"、"去拿体检报告" vs "医院的检查结果"。否定、指代、中英混写同理，`lib/goldset.js` 顶部自己把这四类写成"缺口"。而 2026 年的基准（LongMemEval / MemoryAgentBench / PersonaMem v2 / ANCHOR）测的恰好就是这几类。**你现在没有任何手段知道"她该想起来的时候想没想起来"。**

而且——分词救不了同义。所以这条判断的落点是**别名**，不是分词（A0 / A1 的顺序就是这么来的）。

**判断三（2026-11-04 修正：原文说错了，保留划线原文以便对照）：** ~~有一处设计现在是实打实吃亏的，不是取舍问题。~~

~~`lib/index.js:68` 声明 `inject = ['systemPrompt', 'skills', 'tools']`，记忆块进的是 **system prompt**（`ctx.systemPrompt.context({name, order, text})`）；而块内容每轮都在变（body 由 query 决定）。提示缓存是**前缀字节匹配**：system prompt 一变，整段对话的缓存全部作废。缓存读 0.1×、写 1.25×——同一段上下文，命中和不命中差一个数量级。Claude Code 那条经验说得最直白："static content first, dynamic content last"，并且**把更新放进 message，不要改 system prompt**。本地推理不吃这个亏；接云端 API 就是真金白银。见 B6。~~

实测结论相反：DSH 的 `deepseek-flash` 目录条目声明了 `systemPromptUpdate: in-history`，**改系统提示词是追加到历史尾部，不是重写开头**，前缀继续命中。本机 13 个会话实测命中率 93.6%–99.7%，最长那个 2698 轮是 **99.5%**。记忆块 447 tok，只占每轮提示词（p50 43 万）的 **0.10%**。所以 B6 不做——详见 [RESEARCH-2026-11-04-b6-prompt-cache-evidence.md](./RESEARCH-2026-11-04-b6-prompt-cache-evidence.md) 与下方 B6 段。

---

## A 档 · 不动架构，1–3 天，能立刻量出效果

### A0. 别名半自动：唯一能把"同义=0"从 0 挪开的东西 —— **✅ v0.48.0 已实现**

- **现状**：`aliases` 字段是通的（`store.js:209` 把 aliases 并进 tags 一起算分），但只能手写。库里有 200 个点时，靠人记得给每个点加别名，不现实。
- **依据**：LongMemEval 的 **fact-augmented key expansion**（用同一事实的不同表述扩索引键）；A-MEM 的 note attributes（keywords/tags 是生成出来的，不是抄的）；HippoRAG 2 建图时专门做了 **synonym phrase 节点**——三家的共同动作都是"把同义显式连起来"，而不是指望模型自己懂。
- **改法（实际落地的版本）**：`lib/alias.js` 从 `10_archive` 里**数**候选词，三条硬条件：① 与该点已有的词**同条消息共现**；② 至少 `minSupport`（默认 3）条**不同**消息都这样共现；③ 不在点词表里、也不包含点里的词。排序按共现条数 → 他说的条数，**不按 idf**（稀有词多是错别字）。**不写 `40_pending`**：别名不是记忆点，不参与 validate/check/promote 那条流水，直接由 `memory alias accept` 写回点的 `aliases:` 一行。全程零模型调用，每个候选都能指回具体的 message。
- **代价**：`lib/alias.js` 约 300 行 + 4 条 CLI（`propose|list|accept|reject`）+ 15 条测试；front matter 写回要处理行内/块状/无键三种现状并保持 CRLF（`setAliasesInText`）。
- **验收（已通过）**：`test/alias.test.js` 端到端用例——`关节不舒服` 对 `他膝盖疼` 本来 0 命中，`accept 关节` 之后命中；共现/条数/词表/拒绝四条规则各有独立用例；accept 幂等；写回后正文逐字不变。

### A1. ~~加一条词级通道 + RRF 融合~~ —— **实测后撤销（v0.48.0 已量，不做）**

- **原假设**：`bigrams()` 是唯一打分通道，加一条词级通道（`Intl.Segmenter`）用 RRF 融合，能救回改述查询。依据是 Zep 的三路检索 + RRF，以及 LongMemEval 的 fact-augmented key expansion。
- **第一层实测**（`overlap()` 原样调用，`Intl.Segmenter('zh',{granularity:'word'})` 分词）：

  | 记忆标题 | 查询 | 字级 | 词级 |
  |---|---|---|---|
  | 这膝盖疼得要命 | 关节不舒服 | 0.00 | 0.00 |
  | 台风天看海 | 那天看的那个海 | **0.25** | **0.00** |
  | 每天下午几点喝咖啡 | 他习惯下午三点喝咖啡 | 0.50 | **0.60** |
  | 去拿体检报告 | 医院的检查结果 | 0.00 | 0.00 |
  | 她讨厌香菜 | 我不讨厌香菜 | **0.75** | 0.67 |
  | 上次那个医院 | 上周三去的那家医院 | 0.20 | **0.33** |

  两个发现：① **分词不稳定**——`台风天看海` 切成 `台风/天/看海`，查询里是 `看/海`，词级反而归零；② **同义改述两路都是 0**，分词治词形和切分，治不了"换个说法"。

- **第二层实测（决定性的一步）**：把插件**真实**的打分函数 `rankHybrid`（含单字兜底、稀疏补权）直接跑金标，而不是跑我剥出来的简化版：

  | 打分器 | 金标 top-1 | 金标 top-3 | 未准入 |
  |---|---|---|---|
  | `rankHybrid`（现行，含单字兜底） | **20/20** | **20/20** | **0** |
  | 剥掉单字兜底的字级通道 | 17/20 | 17/20 | 3 |
  | 词级通道（阈值 0.8 / 1.0） | 20/20 | — | 0 |

  结论：**金标上词级通道相对现行打分器是净零收益**——被它"救回"的三条（海边 / 忌口 / 火锅）本来就由单字兜底救回了。我第一轮看到的 17/20 是**测量口径错误**（剥掉了兜底），不是插件缺陷。这条写在这里，是为了避免以后有人照着"17/20 有待改进"重做一遍。

- **第三层实测（代价）**：词级通道唯一的可见影响是**多出误命中**。用 12 条对抗负例（与某条点共享一个实义词，但库里没有该事实：`今天膝盖有点酸` / `窗户该擦了` / `香菜多少钱一斤` …）测：

  | 通道 | 误命中（22 条负例中） |
  |---|---|
  | 字级（现行） | 7 |
  | 词级（min 归一，阈值 0.8~1.0） | 9 |
  | 词级（query 归一，阈值 0.9） | 4（但金标掉到 17/20） |

  词级归一化靠 `min(Σidf)` 做分母，短字段会饱和到 1.0——"共享一个稀有词"就足以过线。这个误命中模式**不是词级独有的**（字级也有 7 条），但词级没有把它变好，也没有把它变坏的余地。

- **结论：不做。** 真正卡住召回的是"他说的词和她记的词不是同一个词"，那是别名的活（A0，v0.48.0 已实现），不是通道数量的事。RRF 只有在两条通道**各自有独立胜负**时才赚——这里第二条通道的胜负是第一条的子集。

- 顺带记一笔：金标已经**饱和**（20/20、margin 靠边）。饱和的基准测不出任何改进，所以下一步的优先级不是改打分器，而是**让基准变难**（见 C 档）。

### A2. 重排注入块：重要的放两头，易变的放后面

- **现状**：`render.js:491-505` 的推送顺序是 `core → status → question → emotion → work → ghosts → key → due → return → habits → index → ability → body`。"改变过你的事"（`key`，永远全文）被夹在中间；每轮都在变的 `question/emotion/due/return/habits` 排在"基本不变的 index"前面。
- **依据**：Lost in the Middle（Liu et al. 2023）的 U 形曲线；Chroma《Context Rot》(2025-07，18 个模型) 的结论是长度上升可靠性非均匀下降、**一个语义相近的干扰项就能拉低准确率**。
- **改法**：顺序改成 `header → core → status → key → index → [volatile: question/emotion/due/return/habits/work/ghosts] → ability → body → related → footer`。理由：稳定且最重的两头（core/key），易变的挤中间，正文贴尾。
- **代价**：纯重排，0 新逻辑；但 `inject-diff` 的基线要重录一次。
- **验收**：`inject-diff` 显示只有顺序变化、token 总数不变；`preview.mjs` 里最关键那条仍在前 1/3。

### A3. 相对时间先说人话（"上周三""上次那个"）

- **现状**：`lib/time.js` 处理的是日期格式与相对日；检索侧对"上周三"没有查询扩展，goldset 自己写着"没有跨会话时序"。
- **依据**：LongMemEval 五能力里的 **temporal reasoning**（Zep 在这项上从 45.1% → 62.4%）；其**time-aware query expansion** 就是"先把查询里的时间约束解析出来，再带着时间窗去检索"。
- **改法**：查询进 `rankHybrid` 前先过一层：抽 `上周三/前天/上个月/去年冬天` → 换算成闭区间；命中时间窗内的点给一个**名次加成**（不是分数加成，配合 A1 的 RRF）。
- **代价**：`lib/time.js` + 20 行；中文相对时间词典约 40 条（"大前天""上上周末"）。
- **验收**：新增 4 条时序查询（"上周三聊的那个""上个月她提过的体检"）能召回；窗外的同主题点不被拉进来。

### A4. 每条注入都带"日期 + 来源"，且缺字段不该被判 0

- **现状**：`renderPoint` 的 full/摘要/索引行三档里，日期有时在有时不在；`retrieve.js:81` 那段注释自己写了"摘要权重只有 1，怎么算都过不了 0.8——不是该点不重要，是它没那个字段"。
- **依据**：Mem0 2026 的检索提示**强调时间戳**，并要求"矛盾时按新鲜度裁决"；LongMemEval 的 reading 阶段证明"结构化呈现（带时间的 JSON）"优于直接拼接。
- **改法**：① 三档渲染统一 `2026-10-31 · 他说的 · 医院` 这样的前缀（≤8 tok）；② `rankHybrid` 的字段缺失不要按 0 计，改成**只在存在的字段间归一**（`rebalanceWeights` 已有，只是默认关——把它默认打开并测一遍）。
- **代价**：每条约 +8 tok，正文 300 tok 的预算意味着少放 1 条；需要一次 `stats` 前后对比。
- **验收**：`memory stats` 的 body 命中条数下降 ≤1；带时间前缀后 A3 的时序查询提升可复现。

---

## B 档 · 补结构，1–2 周

### B1. 实体共现边，然后走一步（HippoRAG 的极简版）

- **现状**：`lib/entities.js` 有注册表（`addEntity/entitiesIn/entityCandidates`）、有 `20_state/entities.index.json`，但**没有边**——实体只是"别名到 id 的查找表"。
- **依据**：HippoRAG 2（ICML 2025）用 **Personalized PageRank** 在"实体 + 段落"图上检索，关联记忆任务比最强 embedding 高 7%，且**不需要向量**；它的关键不是图有多复杂，是"从种子节点在图上扩散"。
- **改法**：写入点时，把同一条记忆里出现的实体两两连边（权重 = 共现次数，落在 `20_state/` 派生层，不改真相层）；检索命中一个实体后，按边权做**一步**扩散，扩散到的点进候选但名次打折（比如 ×0.6）。**不做迭代 PPR**，一步就够这个库的规模（200 点上限）。
- **代价**：新模块约 150 行；每次 `promote` 多一次实体抽取（现有 `entitiesIn` 就能用）。
- **验收**：新增 6 条"跨条关联"查询（"那次去医院是不是也提过失眠"）召回 ≥4；不带扩散时 ≤2。

### B2. 记忆演化：新点让旧点"重新被理解"（写派生层）

- **现状**：`invalid_at` 只处理"这条不成立了"；没有"这条现在看起来是另一回事"。
- **依据**：A-MEM(NeurIPS 2025) 的消融显示，去掉 **memory evolution** 后 temporal F1 掉得最多；它用 1.2K tok 拿到 32.86 多跳 F1（MemGPT 17K tok / 30.36）。
- **改法**：新点写入时，取同簇/同实体的最近 3 条，生成一行"现在看"（≤30 字）存进 `20_state/evolve.json`，注入时附在原点索引行后面（**不改 `30_points` 的正文**，否则真相层被污染）。
- **代价**：需要一个生成者——插件不调 LLM，只能由她在 `fish-remember` 时顺带产出，或 CLI 手动 `memory evolve --apply`。这是本清单里唯一"必须有人/模型参与"的一条，所以排在 B 档后段。
- **验收**：`audit` 能列出"被演化过"的点；关掉演化时 A 档指标不下降（证明它是加法而不是依赖）。

### B3. 摘要树：几千个点时，别每轮 stat 全目录

- **现状**：`indexPoints` 30s TTL + 每轮全目录读；索引预算 700 tok，装不下多少行。
- **依据**：Graphiti 用 **label propagation 聚社区 + 社区摘要节点**；RAPTOR/PageIndex 的共同点是"先粗后细的树"——LongMemEval 的 **session decomposition** 也是同一思路（值粒度分层）。
- **改法**：`30_points` 之上加一层 `25_digest/{day,week,month}.md`（只读、可重建、带 `source ids`）。检索先打摘要层（粗），命中后下钻到点（细）。摘要层不参与"真相"，删了能重建。
- **代价**：一个新脚本 `memory digest`（周/月各一次），加 `render` 的一个可选块（≤120 tok）。
- **验收**：造 500 个假点，`preview` 的耗时不随点数线性涨；`digest` 重建幂等（连跑两次字节相同）。

### B4. 写入门控要分"来源信任级"，并且要定期复检

- **现状**：**这是你比大多数实现做得好的地方**——`check` 要求 `source` 必须在档案里逐字存在，`source.kind` 只收 user/model，注入出口有 `sanitizeForPrompt`。但**没有信任分级**，也没有"这条事实现在还成不成立"的复检（`audit` 查的是结构）。
- **依据**：OWASP 2025-12 把 **ASI06 Memory & Context Poisoning** 单列为一类（"把提示注入变成有状态攻击"）；MINJA（NeurIPS 2025）仅靠正常对话就能注入，98.2% 写入成功 / 76.8% 下游成功；防御侧 A-MemGuard（2025-10）用"多邻居共识 + 教训库"把攻击成功率从 100% 降到 ~2%。
- **改法**：① 点加 `trust: direct|reported|inferred|external`（他亲口说 / 他转述 / 她自己想通 / 网页与素材）；② 注入时 `external` 永不进 `key` 块，`inferred` 不进 `QUOTE`；③ `memory audit` 增加一节"6 个月未复检的 `reported` 点"——复检就是拿 `source` 回档案里再核一次逐字（你已经有这个能力，只是没定时跑）。
- **代价**：schema 加一个可缺省字段（老点默认 `direct`），迁移走现有 `POINT_MIGRATIONS`。
- **验收**：新增 5 条测试（`external` 不进 key / `inferred` 不进 QUOTE / 缺字段按 direct / 复检列出过期 / 删来源后点降级）；现有 587 条不回归。

### B5. 删除要能级联，但只在"没人再支持它"时删

- **现状**：`memory erase` 按 id 精确删 + 重算链 + 墓碑。它不知道"这条点是从哪几条消息来的"，所以删一条消息不会影响任何点。
- **依据**：Graphiti/Zep 的 `remove_episode` 语义——删来源时，**只有没有其他来源支持时**才删派生事实；共享事实要活下来。
- **改法**：`erase <msgId>` 时反查引用该消息的点；若该点是唯一引用 → 一起进墓碑；若还有别的引用 → 只减引用计数。
- **代价**：`erase.js` + `source` 索引（现在 `source` 是字符串，得建反向表）。
- **验收**：三角测试——同一事实由两条消息支持，删一条后点仍在；删第二条后点进墓碑；`verify` 通过。

### B6. 把每轮必变的东西挪出 systemPrompt —— **❌ 已证伪，不做（2026-11-04）**

> 详细证据与复现方法：[RESEARCH-2026-11-04-b6-prompt-cache-evidence.md](./RESEARCH-2026-11-04-b6-prompt-cache-evidence.md)

- **原假设**：`inject = ['systemPrompt', ...]`，块每轮字节都不同 → 前缀缓存每轮作废 → 应该把 `body` 拆出来、或冻住、或走 message。
- **假设错在哪**：DSH 的 `deepseek-flash` 目录条目声明了 `systemPromptUpdate: "in-history"`（`dsh-llm-deepseek/lib/index.js:24`）。`dsh-agent-loop` 的 `project()`（`lib/index.js:272`）在这种情况下**把变化后的整段系统提示追加到历史尾部**，不动开头的系统消息——前缀照样命中。这正是上游（Anthropic 文档 "static first, dynamic last"、arXiv 2601.06007、kelivo #1202、context-chef 的 `before_history_tail`）教人手动做的事，宿主在协议层做了。
- **实测**（`node scripts/cache-audit.mjs`，只读）：
  - 13 个本机会话命中率 **93.6%–99.7%**；2698 轮那个是 **99.5%**，零缓存轮 0。
  - 每轮提示词 p50 **432,444** tok；每轮未命中输入 p50 **248** tok。
  - 记忆注入块 **447** tok = 每轮提示词的 **0.10%**。
  - B6 第一步的"连续 5 轮里块字节不变"：真实库 76 个窗口**全是 4/4**；换成有 3 个点的库跑 80 条真实提问，body 只命中 2 轮。
- **为什么不做**：447 tok 全价 ≈ ¥0.00045/轮，全命中 ≈ ¥0.00001/轮，差额 **≈ ¥4 / 万轮**——上限比改动成本（拆块 + 宿主口子 + 测试 + 全闸门）低两个数量级。真正贵的是 43 万 token 的上下文本身，不是这 0.1%。
- **什么情况下回头做**（写死，别凭感觉）：
  1. 库填满后连续 100 轮真实会话，命中率**跌破 90%**，且 `system/message` 事件数接近轮次数（说明块真在每轮变）；
  2. 换到**没有** `systemPromptUpdate: in-history` 的模型/供应商（缺省即 `leading-only`）；
  3. 宿主改成"一个 name 一块、按 order 拼前缀"，块边界才重新有意义。
- **唯一未闭合的缺口**：本机没有"库已填满 + 块每轮变"的会话，所以"变了也不掉"是从机制推的、不是直接观测的。等 P0-1 把库填起来，顺手跑一次 `cache-audit` 就能闭合，成本为零。

---

## C 档 · 评估与互操作，2–4 周（决定了前面所有改动是不是在自嗨）

### C1. 用公开基准的**子集**当回归闸门，别自己造尺子

- **依据**：LongMemEval（ICLR 2025，500 题，5 能力：信息抽取 / 跨会话推理 / 时序 / 知识更新 / **拒答**）；MemoryAgentBench（ICLR 2026，4 能力，其中"选择性遗忘/冲突解决"多跳准确率最高只有 ~7%——**全场最差的一项，恰好是你用 `invalid_at` 在解的那项**）。
- **改法**：各抽 30–50 题，构造"离线回放"：把题面当用户消息喂 `retrieve`，只看召回的证据里有没有 ground-truth 的 session。**不接 LLM 判分**，先只测**召回率**——这一步零成本、可进 CI。
- **验收**：`npm run eval:recall` 输出五项分项数字，写进 `docs/`；任何改动前后差 >3% 必须解释。

### C2. 三个"专治陪伴型记忆"的基准，比 LoCoMo 更贴你

| 基准 | 测什么 | 为什么贴 |
|---|---|---|
| **PersonaMem v2**（COLM 2025） | 1000 个人设、20k 偏好；**隐式偏好**（没明说过，要从多次交互里推） | 前沿模型只有 37–48% —— 你的"她想通的"分类正好对这块 |
| **ANCHOR**（2026-08, Salesforce） | 人格崩塌 + 行为漂移，分开测"问卷里知不知道"和"逐轮像不像"；轨迹回忆平均 44.4%，用户状态回忆接近四选一瞎猜 | 它证明"记住事实"≠"演得住人设"；你现在只有 `EVAL-emotion.md`，没有这个 |
| **REMP**（EMNLP 2026） | 关系-情绪-记忆-人格四维，80 条轨迹 × ~60 会话 | 结论是**记忆完整性与情绪一致性是瓶颈**——你有情绪状态机，但没测过它跨会话稳不稳 |

- **改法**：不跑全套。每个基准抄 10 条最有代表性的 case，转成"她应该怎么回"的断言，进 `memory audit`。
- **验收**：每个基准 ≥10 条 case；失败项能指到具体模块（检索 / 演化 / 情绪 / 人设）。

### C3. 报 `pass^k`，别只报一次过

- **依据**：记忆评估的通行做法是同一探针跑 k≥4 次看稳定性（`pass^k`），因为"最新写入是否胜出"这种事，一次过可能是运气。
- **改法**：`memory gold` 加 `--repeat 4`，输出"4 次都中"的比例。你的检索引入了 tick/attention，天然有非确定性。
- **验收**：`gold --repeat 4` 的稳定率 ≥90%；低于这个数的条目列出来。

### C4. 通过 MCP 暴露，别把库焊死在 DSH 上

- **依据**：`basic-memory`（~4k star，Markdown 知识图谱 + MCP）、`mcp-memory-service`（~2k）走的都是"文件是真相、MCP 是门"；2026 年这片的标准接口就是 MCP。
- **改法**：只读三件套先做——`search(query)` / `read(id)` / `timeline(range)`；写仍然只走 CLI 的 `check/promote`。
- **代价**：一个 `scripts/mcp.mjs`（stdio，零依赖也能写 JSON-RPC）。
- **验收**：任何 MCP 客户端能查到点；写入路径不变（防止第二个写入口绕过审计）。

### C5. 三件工程债（都不难，但不做会疼）

1. **启动校验是 O(全库)**：`integrity.js:127 checkArchive` 每次启动按文件比 `{count, firstHash, lastHash, bytes}`，随年份线性变慢。改成"只校验最近 N 天 + 每月一次全量"。
2. **跨进程写不是锁，是自愈**：`withLock` 只用在 store flush；档案追加靠"文件大小变过就重读链头"。补一个 `O_EXCL` + 心跳过期的锁（proper-lockfile 的做法），把交错窗口关掉。
3. **`pack/unpack` 是搬家不是同步**：append-only 哈希链天然拒绝两路合并。要跨设备就按天并集 + 冲突报告（冲突不自动合，列出来给人看）。

---

## D. 明确不建议做的

| 不做 | 理由 |
|---|---|
| **默认开 embedding / 向量库** | 引一个 300MB 模型就破了"零依赖、可迁移、能塞进 Obsidian 库"。要做就做**可选旁路**（`retrieval.semantic = off\|http`，默认 off，失败回落字面），且必须先有 C1 的数字证明值得 |
| 抄 Mem0 的 `DELETE` 硬删 | 和你的 append-only 审计链直接冲突；它自己 2026 也改成 ADD-only 了 |
| 引入 Neo4j / 图数据库 | 200 点上限的库，邻接表就够；B1 的一步扩散不需要图引擎 |
| 多租户 / 多角色隔离 | 单库单关系是这套设计的前提；加隔离要重做 `resolveMemoryDir` 和全部路径假设 |
| 追 BEAM（10M token）这类大基准 | 你的库按天分文件、按点检索，量级差三个数量级；追它只会把架构拉变形 |

---

## E. 优先级与建议版本

| 版本 | 内容 | 依据 | 改动面 | 验收 |
|---|---|---|---|---|
| **v0.48.0** ✅ | A0 别名半自动（A1 实测撤销，见上） | 三家都靠"显式同义" | `alias.js`（新）、`toolkit.js`、`memory.mjs` | 同义 0.00→命中（端到端已钉）；20 正例 20/20 不降；610 测试 |
| **v0.48.1** | A2 重排 + A4 日期与来源前缀 | Lost in the Middle；Context Rot | `render.js` | `inject-diff` 顺序变、token 不变 |
| **v0.49.0** | A3 相对时间 + B1 实体扩散 | LongMemEval temporal；HippoRAG 2 | `time.js`、`entities.js`、`retrieve.js` | 时序 4 条、关联 6 中 4 |
| **v0.50.0** | B4 信任分级 + 复检 + B5 删除级联 | OWASP ASI06；Graphiti remove_episode | `schema`、`audit`、`erase` | 5 条新测试 + 587 不回归 |
| **v0.51.0** | C1/C2/C3 评估三件 | LongMemEval、MemoryAgentBench、PersonaMem v2、ANCHOR、REMP | `scripts/eval-*.mjs`、`ci.yml` | 分项数字进 docs，CI 有门槛 |
| v0.52+ | B2 演化、B3 摘要树、~~B6 缓存前缀~~（已证伪，见 B6）、C4 MCP、C5 工程债 | A-MEM；Graphiti communities；basic-memory | — | — |

**如果只做一件：A0。** 它是我在这份清单里唯一实测到"从 0.00 变成能命中"的动作（v0.48.0 已实现，`test/alias.test.js` 的端到端用例钉住：`关节不舒服` 本来 0 命中，写回别名后命中）。

**A1 已撤销**：量完发现现行打分器在金标上已是 20/20，词级通道净收益为 0、误命中还多 2 条（详见 A1 段）。这不是省了一件事，而是纠正了一个原本会白做的判断——它也说明这份清单里**最该先补的是基准，不是通道**。

---

## F. 顺手要修的零碎

- **`docs/` 下两个文件名是乱码**：`ÕÅæթâÕê¦GitHub.md`、`ÕÅæթâÕîà.md`（内容是《第一次上传到 GitHub》和《发布包》）。像是 GBK 文件名被当 UTF-8 打包，重新 `git mv` 成 ASCII 名即可。
- **`lib/retrieve.js` 的默认阈值 0.8 是历史产物**：注释里自己记了"天"字误中的事故。A1 上 RRF 后，这个阈值应该退化成"名次门槛"，别留着两个旋钮。
- **`settings.TUNABLES` 与 `config.BOOLEAN_RULES` 的默认值要单源**（v0.46.1 已修，注意别再手写一遍）。

---

## 参考（按引用顺序）

1. Mem0 2026 算法（ADD-only + Memory Decay 0.3–1.5×，LoCoMo 92.5 / LongMemEval 94.4）— <https://mem0.ai/library/agent-memory/ai-memory-management-for-llms-and-agents>
2. Zep: A Temporal Knowledge Graph Architecture for Agent Memory（双时态、`invalid_at`、search→RRF/MMR→construct，context 115K→1.6K tok）— arXiv:2501.13956；<https://signals.aktagon.com/articles/2026/07/zep-a-temporal-knowledge-graph-architecture-for-agent-memory>
3. LongMemEval（ICLR 2025，五能力；session decomposition / fact-augmented key expansion / time-aware query expansion）— arXiv:2410.10813
4. MemoryAgentBench（ICLR 2026，四能力；选择性遗忘多跳 ≤7%）— <https://github.com/HUST-AI-HYZ/MemoryAgentBench>
5. BEAM（ICLR 2026，10 项能力、最长 10M token）— 见 <https://www.cognee.ai/ai-memory-benchmarks>
6. HippoRAG 2（ICML 2025，PPR + passage 节点，关联记忆 +7%）— arXiv:2502.14802；<https://github.com/OSU-NLP-Group/HippoRAG>
7. A-MEM（NeurIPS 2025，链接生成 + 记忆演化；1.2K tok vs MemGPT 17K）— arXiv:2502.12110
8. Graphiti / Zep 的 provenance 与 `remove_episode` 级联 — <https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory>
9. OWASP Top 10 for Agentic Applications（2025-12，ASI06 Memory & Context Poisoning）；MINJA（NeurIPS 2025，98.2%/76.8%）；A-MemGuard（2025-10，攻击成功率 100%→~2%）
10. Chroma《Context Rot》（2025-07，18 模型、长度与干扰项）— <https://research.trychroma.com/context-rot>
11. Lost in the Middle（Liu et al. 2023）— U 形位置效应
12. Anthropic《Lessons from building Claude Code: prompt caching is everything》— 前缀字节匹配、static first / dynamic last、更新走 message
13. PersonaMem v2（COLM 2025，隐式偏好，前沿 37–48%）；ANCHOR（2026-08，轨迹回忆 44.4%）；REMP（EMNLP 2026，记忆完整性与情绪一致性是瓶颈）
14. sqlite-vec（7.4k star，60KB 纯 C）与 SQLite FTS5 + RRF 混合检索模式 — 若将来做"可选语义旁路"，这是最省的做法；Node 22 内置 `node:sqlite` 已可用 FTS5（本机实测，带 experimental 警告）
15. 2026 生态盘点（Mem0 ~65k / Graphiti ~31k / Cognee ~31k / supermemory ~30k / Letta ~25k；basic-memory ~4k、mcp-memory-service ~2k 是"文件优先 + MCP"这一支）— <https://github.com/vnsavitri/ai-memory/blob/main/docs/research-2026-landscape.md>
