# 竞品对照：3×10 个仓库 + 5 篇公开设计 → v0.72.0 的优化单

> 2026-11-07。对象：`fish-memory-plugin-v0.72.0.zip`（861 测试）。
> 方法：GitHub 三个维度各取 10 个（去重后 27 个仓库），19 个下载完整源码解包读，
> 8 个超大仓库（150MB+）只取 README 与目录树；另读 5 篇公开设计文章。
> 每条结论都对应到具体的仓库/文章，以及本仓的 `文件:行`。
>
> **先说清楚一件事**："大肥鱼记忆库"本身没有公开资料（它是你的私有插件），
> 所以"互联网上的设计思路"取的是**同类 AI 伴侣 / Agent 记忆系统**的公开设计。

---

## 0. 口径

| 维度 | 怎么排 | 为什么这么排 |
|---|---|---|
| **星数** | `api.github.com/search/repositories` 四组关键词（ai companion memory / llm long term memory / agent memory / ai memory sqlite），合并后按 stars 降序取前 10 | 代表"社区认可度" |
| **下载量** | GitHub **不提供**仓库下载数，所以用包管理器：PyPI 月下载（pypistats）+ npm 周下载（api.npmjs.org）折算成月（周×4.3） | "下载量"在记忆系统这个品类里唯一可得的真数字 |
| **创建时间最近** | `created:>2026-04-01` + 按 stars 降序取前 10 | 看"这一年新出来的做法" |

去重后 27 个仓库；三个榜单之间有 3 处重合（mem0、cognee 同时在星榜与下载榜，MemPalace 同时在星榜与新榜）。

---

## 1. 维度 A：按星数（10 个）

| # | 仓库 | 星 | 建仓 | 一句话设计核心（据 README/代码） |
|---|---|---|---|---|
| 1 | `affaan-m/ECC` | 298,937 | 2026-01 | 跨 7 个 harness 的"能力包"：skills + instincts + memory + 安全，一个插件喂所有 agent |
| 2 | `bytedance/deer-flow` | 85,107 | 2025-05 | 超级 agent harness：子 agent + **memory** + 沙箱，靠可扩展 skill 编排 |
| 3 | `ruvnet/ruflo` | 81,139 | 2025-06 | agent 元 harness：swarm + hooks + memory + 自带 MCP server，`init` 一次接管项目 |
| 4 | `mem0ai/mem0` | 68,554 | 2023-06 | 记忆层。2026 算法：**单次 ADD-only 抽取**（不 UPDATE/DELETE）+ 实体链接 + 语义/BM25/实体三路融合 + 时间推理；LoCoMo 92.5、7K token |
| 5 | `MemPalace/mempalace` | 60,450 | 2026-04 | **逐字存储，不摘要不抽取**；索引结构化成 wings/rooms/drawers（人/项目=翼，主题=房间），检索可限定范围；后端可换（默认 ChromaDB），**零 API 调用**，LongMemEval R@5 96.6% |
| 6 | `vectorize-io/hindsight` | 59,652 | 2025-10 | 不只"记得"，要"学会"：自带 decision/rerank/embedding 模型，开源权重 |
| 7 | `DeusData/codebase-memory-mcp` | 48,281 | 2026-02 | 把代码/文档/基础设施连成一张本地持久图，给编码 agent 做代码智能 |
| 8 | `zhayujie/CowAgent` | 47,829 | 2022-08 | 个人助理：**记忆三层（context → daily → core）** + 自动 "Deep Dream" 蒸馏 + 关键词/向量混合检索 |
| 9 | `volcengine/OpenViking` | 41,740 | 2026-01 | 把 agent 的一切做成**虚拟文件系统** `viking://`：知识/记忆/技能统一命名空间，每个目录带生成式摘要，可 `ls/tree/grep`，检索限定到目录 |
| 10 | `topoteretes/cognee` | 33,121 | 2023-08 | 自托管知识图谱记忆平台，强调**本体（ontology）**与可定制数据模型 |

**这个榜单告诉我们什么**：前十里 6 个是"harness/平台"而不是"记忆库"。记忆正在从"一个库"变成"harness 的一个子系统"——这和大肥鱼"插件形态"是一致的，但也意味着**接口**（MCP / skill / HTTP）比库本身更决定能不能被用起来。

## 2. 维度 B：按下载量（10 个）

| # | 仓库 | 包与下载 | 设计核心 |
|---|---|---|---|
| 1 | `mem0ai/mem0` | `mem0ai` PyPI **2,020,516/月**；npm **278,125/周**（≈1.2M/月） | ADD-only 抽取、实体链接、三路融合、时间推理 |
| 2 | `modelcontextprotocol/servers` | npm `@modelcontextprotocol/server-memory` **293,428/周**（≈1.26M/月） | 最小可用记忆：**知识图谱三件套（entities / relations / observations）**，一个 JSON 文件，MCP 暴露 |
| 3 | `supermemoryai/supermemory` | npm `supermemory` **179,104/周**（≈770k/月） | 事实抽取 + 用户画像 + **矛盾处理/过期遗忘** + 混合检索，95% Recall@15、99.4% 上下文缩减 |
| 4 | `langchain-ai/langmem` | `langmem` **773,504/月** | 热路径记忆工具（agent 自己记/查）+ **后台 memory manager 自动抽取、去重、合并** + prompt 优化 |
| 5 | `getzep/graphiti` | `graphiti-core` **619,128/月** | **双时间知识图**：边带 `valid_at/invalid_at`，事实变化可追溯；增量更新不重算全图；provenance 回源 |
| 6 | `getzep/zep` | `zep-cloud` **292,185/月** | 企业上下文层：Context Graph + 从 agent 任务里长出的 Skills |
| 7 | `topoteretes/cognee` | `cognee` **86,048/月** | 知识图谱 + 本体 |
| 8 | `basicmachines-co/basic-memory` | `basic-memory` **27,770/月** | Markdown 笔记即记忆：observation / relation 从笔记里抽，SQLite 索引，MCP 接入 |
| 9 | `letta-ai/letta` | `letta` **15,031/月** | MemGPT 血脉：core / recall / archival 三层 + **agent 自己编辑记忆** |
| 10 | `memodb-io/memobase` | `memobase` **2,503/月** | **用户画像 + 事件时间线**，每用户一个缓冲批量处理，在线 <100ms，系统里"没有 agent"以控成本 |

**这个榜单告诉我们什么**：下载量最高的两个（mem0、MCP 官方 memory server）恰好代表两条路——"重算法"和"极简协议"。MCP 那个只有 entities/relations/observations 三个概念，却有 29 万周下载：**能被 agent 直接调用的最小接口，比复杂的记忆算法更容易被采用**。

## 3. 维度 C：按创建时间（2026-04 之后，10 个）

| # | 仓库 | 星 | 建仓 | 设计核心 |
|---|---|---|---|---|
| 1 | `MemPalace/mempalace` | 60,450 | 2026-04-05 | 逐字存储 + 结构化索引 + 可换后端（见上） |
| 2 | `TencentCloud/TencentDB-Agent-Memory` | 30,609 | 2026-04-07 | **团队级**记忆中心：MemoryCore / MemoryKnowledge / MemoryPanel / Proxy 四件套，多 agent 共享一个服务 |
| 3 | `akitaonrails/ai-memory` | 15,312 | 2026-05-21 | 跨 20+ harness 的共享记忆；**交接是类型化协议：有 owner、只能被申领一次**；能带"会话本体"而不只是摘要 |
| 4 | `tigerless-labs/agent-memory` | 4,310 | 2026-09-01 | **markdown 是唯一真源、SQLite 索引只是可删缓存**；检索返回**路径**而不是正文；写入在会话边界触发；**睡眠期按价值整合与遗忘** |
| 5 | `Ar9av/obsidian-wiki` | 3,697 | 2026-04-06 | 把学到的东西**编译成互相链接的 markdown wiki**（Karpathy 的 LLM Wiki 思路），session hooks 自动捕获 |
| 6 | `mnemosyne-oss/mnemosyne` | 3,600 | 2026-04-05 | 零云、单 SQLite、单依赖；带 sync 与明确的安全/隐私模型 |
| 7 | `Asymptote-Labs/agent-beacon` | 3,369 | 2026-05-12 | 捕获**完整会话轨迹**（prompt/工具/命令/审批/token），把"纠正与调试模式"提炼成可复用知识，人工 review 后共享 |
| 8 | `VictorTaelin/OptMem` | 2,380 | 2026-07-25 | 426 token 的提示 + 一个脚本：`LOG.txt` 只追加，`TREE/` 是可重建的**二分摘要树**；`wake/note/nap/recall/zoom/forget` 六个命令 |
| 9 | `MemTensor/memmy-agent` | 2,203 | 2026-07-16 | 跨 agent 任务连续性 + 桌面端 + 数据安全，主打"接着上次干" |
| 10 | `memorax-ai/memorax-code` | 2,020 | 2026-08-01 | 面向编码 agent 的共享记忆，明确支持 **DeepSeek Harness**，有独立 ARCHITECTURE.md |

**这个榜告诉我们什么**：2026 年新项目**几乎不再自己造向量库**，而是"文件/日志做真源 + 索引可重建"。`agent-memory` 那句话几乎是大肥鱼的自述：
> "Markdown files in one store are the single source of truth, the SQLite index beside them is a cache you can delete at any time."

---

## 4. 互联网上的公开设计（5 篇，只取和我们有关的结论）

| 来源 | 关键结论 | 对我们的意义 |
|---|---|---|
| **MemoryBank**（论文/综述） | 三层：逐条日志 → **日摘要** → 用户画像；遗忘用 Ebbinghaus `R=e^(-t/S)`，每次召回增强 S 并把 t 归零 | 我们的 `strength.js` 已经是这个模型（`retrievability(S, days)` + `applyReview`），**不比它差**；但"日摘要层"我们没有 |
| **ZifaMem**（arXiv 2607.17564） | 四层：L1 轮次缓冲 / L2 会话摘要 / L3 情节记忆（重要度≥0.5 或情绪峰值才升层）/ L4 合并后的用户模型；情绪标签**内嵌在记忆里**而不是独立模块；四骨干平均 +11.4%；**额外加一个情绪状态机在五个端点上都没有可测增益** | 两个信号：① 分层摘要值得做（R1）；② **我们该对情绪状态机做一次对照实验**——如果真没增益，tier 那套的复杂度就该砍 |
| **AI 伴侣记忆四形态**（flirton / aicompanionguides） | 窗口 / 摘要 / 事实检索 / **用户可编辑**；2026 基线是"事实检索 + 用户可编辑" | 我们有事实检索，缺"可编辑界面"（M4） |
| 同上的"五种机制"批评 | **定时整合会"不给你看 diff 就改掉你的历史"**；"忘了"通常等于"没检索到"，换个说法再问就出来了 | ① 验证了我们 tidy 只提醒、不改写；② 需要"近失记录"（R7） |
| 掘金《AI 陪伴硬件角色系统架构》 | 记忆三层落地为：用户画像（结构化+向量）/ **事件记忆（带时间戳的情节日志，语义+时间混合检索）** / 内容记忆（图谱）；人格要"结构化状态对象"而不是每次塞 prompt | 我们的"关系状态 + 核心层"就是结构化状态（做对了）；缺事件层（R1 的一部分） |

---

## 5. 横向矩阵：八维度看 27 个仓库

| 维度 | 主流做法（代表） | 大肥鱼 v0.72.0 | 判断 |
|---|---|---|---|
| **真源** | 云库（mem0/zep）/ SQLite（letta/mnemosyne）/ markdown（basic-memory、agent-memory、Obsidian） | markdown 点 + 逐字 JSONL 档案 + hash 链 | **少见的好**：档案是逐字、可验链；多数竞品只存抽取结果 |
| **写入** | LLM 自动抽取（mem0/memobase/langmem）/ agent 自编辑（letta）/ 人工（Obsidian） | 她写草稿 → 人 promote；**代码永不自动写点** | 保守，但对"人格"是对的；缺"人编辑界面" |
| **摘要层级** | L1–L4（ZifaMem）、日/全局（MemoryBank）、树（OptMem）、目录摘要（OpenViking） | 只有 事实点 + 核心层，**没有日/周/事件层** | **最大差距（R1）** |
| **检索** | 向量（mem0/MemPalace/basic-memory）/ 图（graphiti/cognee）/ 混合（mem0 三路） | bigram+IDF+实体并池+时间意图+时间窗+FSRS 权重，**无向量** | 中文短查询够用（19/20），语义改写是真短板；零依赖是有意的 |
| **返回粒度** | 正文块（mem0）/ **路径/句柄**（agent-memory、OpenViking） | 预算内给正文 + 一个 `memory_recall` 全文工具 | 可升级为"索引行优先 + zoom"（R2） |
| **遗忘** | 衰减（MemoryBank/mem0）/ 过期（supermemory）/ 价值整合（agent-memory） | FSRS R + 沉睡层 + 真删 + 墓碑 | **做得最完整的一档** |
| **身份/人格** | persona prompt（多数）/ 无（mem0） | 磁盘核心层 + 漂移检测 + 篡改账本 + 锚点 | **独有**：27 个仓库的 README 与主要代码里**没有**把"她变了"做成可告警的机制（只有 persona 文本） |
| **隔离** | 多租户（mem0/zep/TencentDB）/ user_id（memobase） | scope（已补写侧）+ visibility 三级 | 结构对齐；缺通道 |
| **出口** | MCP（MCP servers、MemPalace、agent-memory、memorax）/ HTTP（TencentDB）/ SDK | 本地 HTTP + CLI + DSH 工具 | **缺 MCP（R5）**，这是最便宜的杠杆 |

---

## 6. 先划清：这些是我们已经领先的，别抄丢

1. **证据链**：`source` 硬约束 + 逐条消息 `hash/prev` + `memory evidence <id>` 打回原文。graphiti 有 provenance，但不逐条验链；mem0 的 ADD-only 干脆不保留原文。
2. **身份漂移检测**：`guard.js` 的 bigram Dice 阈值 + 三条不可删锚点 + `tamper.log` 每轮指纹。27 个仓库里没有同类机制（只有静态 persona 文本）。
3. **注入的结构化预算**：核心层/索引/正文/状态/到期分档，前缀稳定有测试（`test/budget.test.js`）。竞品都在讲"token 效率"，没人管"prompt 的结构长什么样"。
4. **整理机只提醒不改写**：正好避开公开文章点名的"定时整合偷偷改历史"。
5. **零依赖、离线、中文优先**：MemPalace 要 ChromaDB，mem0 要云/向量库；我们一个 `node` 就够。

---

## 7. 优化项 R1–R8

### R1 分层摘要树：日 → 事件 → 画像（P0，最大差距）

**借自**：ZifaMem 的 L2/L3（会话摘要/情节记忆，重要度≥0.5 或情绪峰值才升层）、MemoryBank 的日摘要、OpenViking 的"每个目录带生成摘要"、OptMem 的 `TREE/`（可重建的二分摘要）。

**现状**：只有 档案(原文) → 点(事实) → 核心层。中间那层没有——所以"上个月那周我们在干嘛"只能靠原文检索碰运气。

**改法**：
- 新增 `10_diary/YYYY-MM.md`：每天一节（≤200 字），只写"发生了什么"，每句可带 `(见 seq:1203)`；
  命令叫 `memory diary`——`digest` 这个名字已经被"切段备料"占用（`scripts/memory.mjs:436`），别抢；
- 新增 `11_episodes/<E-id>.md`：一场事件一页（现有的 `event: E-YYYYMMDD-NN` 已经给了 id 约定），从当天日记里挑，**重要度 ≥0.5 或情绪 tier≥2 才升级**（照 ZifaMem 的门槛）；
- 两者都是**派生/可重建**：`memory diary rebuild` 能从日记与点重出；要进备份得显式加进 `lib/pack.js:31` 的 `PACK_INCLUDE`（现在只有 10_archive 等 10 个目录）；
- 注入只加两档：最近 3 天日记 + 事件索引行（`- 2026-10-28 她第一次说想去那条河`），总预算 ≤300 tok，写进 `test/budget.test.js`；
- **谁写**：她写（remember 技能加一个 `diary` 草稿类型），人审后 `memory diary commit`；代码只备料和校验 seq 指向——纪律不变。

**验收**：`test/diary.test.js`：① 日记里 `(见 seq:x)` 对不上档案时 check 报 warn；② 预算裁剪正确（`test/budget.test.js` 同步钉 300 tok）；③ `rebuild` 前后字节一致。
**风险**：摘要会"越写越像结论"。规则写死：只允许"谁做了什么"，不允许"她觉得很…"（那属于点的 `[旁白]`）。

### R2 索引行优先 + zoom（P1，省 token）

**借自**：`agent-memory`"检索返回路径而不是贴正文，agent 按需要打开到多深"；OptMem 的 `WAKE_LINES` 是**阅读预算**而不是存储预算；OpenViking 先扫摘要再决定读谁。

**现状**：注入时在预算内直接给正文（`render.js` 的 `sum/body` 两档），她想知道更多只能调 `memory_recall` 搜词——按 id 取全文的能力没有。

**改法**：
- `memory_recall` 增加 `id` 参数（`M-…` / `E-…` / `seq:1203`），按句柄展开；
- 预算紧张或 `scope=group:*` 时，默认降到 `idx` 档（标题 + 一句），并在块尾提示"要细节就 recall(id)"；
- 记一个 `zoom.log`：她实际展开了哪些点——这是"哪些记忆真的有用"的第一手信号（比注入计数更硬）。

**验收**：同一 query 下 token 下降 ≥20%，金标 20 题命中不降（`npm run gold`）。

### R3 双时间轴：`date`（何时发生）与 `learned_at`（她何时知道）（P1，半天）

**借自**：graphiti 的 bi-temporal（`valid_at/invalid_at` + 记录时间分开）；Zep 的"historical queries"。

**现状**：点有 `date`、`valid_from`、`invalid_at`，档案有 `ts`；但"**她是什么时候才知道这件事的**"没记。于是"你上周才告诉我，其实去年就离职了"这种，检索只能按发生时间排。

**改法**：点新增可选 `learned_at`（默认取档案里 `source` 第一条的 `ts`），渲染时对"知道得比发生晚很多"的点加一句 `（2026-11 才知道）`；`memory timeline` 增 `--by learned`。

**验收**：`test/time.test.js` 加两例：发生早/知道晚的点在"问过去"时排位正确；老点缺字段按 `date` 兜底。

### R4 睡眠期"待整理候选"（P2，1 天）

**借自**：`agent-memory` 的"sleep-time pass consolidates and forgets by value"；CowAgent 的 Deep Dream；但我们只取"算候选"，不取"自动改"。

**现状**：`sleep.js` 只结算情绪/习惯/索引，不做任何记忆侧体检；`tidy` 只按条数提醒。

**改法**：睡眠结算时（每天最多一次）算四类候选写 `50_log/tidy-candidates.md`：
① 90 天未被提及但 `salience≥4` 的点；② 互相 `contradicts` 但都没 refute 的对；③ 标题/摘要相似度 >0.85 的近似重复；④ `source` 为空或指向已删消息的点。
`tidy` 的提醒行带上条数（`（另有 7 条待看：4 条久未提及、2 条矛盾、1 条无证据）`）。

**验收**：空库不报错；四类各造一条样本能各命中一次；不写任何点文件（测试断言目录 mtime 不变）。

### R5 MCP 只读出口（P1，1 天，最便宜的杠杆）

**借自**：`@modelcontextprotocol/server-memory`（29 万周下载，只有 entities/relations/observations 三个概念）、MemPalace/agent-memory/memorax 都自带 `.mcp.json`。

**现状**：只有 DSH 工具 + 本地 HTTP（`serve.mjs`）；`grep -r mcp` 只有一处注释（`render.js:259`），没有任何协议实现。

**改法**：新增 `scripts/mcp.mjs`（stdio JSON-RPC，零依赖），暴露四个只读工具：
`memory_search(query, limit)`、`memory_get(id)`、`memory_context(q, scope)`、`memory_evidence(id)`；
写操作一律不暴露（要写走 `40_pending` 的现有闸门）。附 `mcp.json` 片段与一行安装说明。

**验收**：`test/mcp.test.js` 用假 stdin 跑一轮 `initialize → tools/list → tools/call`；工具返回结构稳定；`memory_context` 在 `scope=group:*` 时不返回 private 正文。
**风险**：MCP 客户端会把它当"全知记忆"，返回必须带"这是本地库、可能为空"的说明。

### R6 矛盾 diff 视图（P2，半天）

**借自**：supermemory 的"矛盾处理"、公开文章对"整合不给 diff"的批评；我们已有 `contradicts` 与 `refute`，但**看不见两版差别**。

**改法**：`memory diff <idA> <idB>`：并列打两版 front matter 关键字段（title/quote/date/salience/source）与正文首段，标出冲突字段；`refute --by` 时提示先跑一次 diff。

### R7 召回近失记录（P2，半天）

**借自**："忘了通常等于没检索到"——换个说法再问就出来了。

**现状**：`retrieval.log` 记了 `rendered/dropped/reasons`，但没记"最接近但没过线"的分数。

**改法**：日志加 `top: {id, score}` 与 `threshold`；`memory near-miss` 列出 0.7–0.8 之间的查询（默认阈值 0.8），按出现次数排序——这是补别名/加同义词最直接的清单。

### R8 档案冷存（P2，1 天，与审计 M5 合并）

**借自**：MemPalace 的"逐字但不臃肿"、OpenViking 的目录摘要；本质是"原文不必永远以最贵的形式躺着"。

**改法**：`memory compact --before 2025-11`：把整月 `messages/YYYY-MM-*.jsonl` 打成 `.jsonl.gz`，`readArchive` 认 `.gz`（`zlib.gunzipSync`，仍是零依赖），`integrity` 对压缩包记"解压后哈希"。备份包体积随之下降。

**验收**：压缩前后 `checkArchive` 都通过；`memory evidence` 能打回压缩档案里的原文；`fmb` 导出/恢复往返一致。

---

## 8. 不做（这次明确不抄）

1. **不引向量库/embedding**：MemPalace 96.6% 的成绩靠 ChromaDB + 逐字检索，但那就不是"零依赖、单文件、能塞进 DSH 插件"的形态了。语义检索可以作为**可选外部适配器**（单独文档），不进主干。
2. **不让代码自动写摘要/自动合并**：ZifaMem、langmem 都自动，但那需要模型调用 + 会悄悄改历史；我们的等价物是"备料 + 提醒 + 人审"。
3. **不做多租户/云服务**：TencentDB、zep 那条路是团队产品，和"养一条鱼"是两种东西。
4. **不追 benchmark 分数**：mem0 的 92.5 / MemPalace 的 96.6 是它们自己选的尺子；我们的尺子是 `gold` 20 题 + `fidelity` 两格 + `voice-metrics`，换尺子就没法比。
5. **不照搬"agent 自己编辑记忆"**（letta）：她会把自己写成她想要的样子，那是人设表演，不是记忆。

---

## 9. 顺序

| 顺序 | 项 | 理由 | 估 |
|---|---|---|---|
| 1 | **R1 摘要树** | 唯一的"结构性缺失"，也是三份外部材料同时指向的缺口 | 2–3 天 |
| 2 | **R5 MCP** | 一天换一个生态位：让 Claude Code/Codex 也能查鱼库 | 1 天 |
| 3 | **R3 双时间轴 + R7 近失** | 都是小改，直接提升"问过去"的准头 | 1 天 |
| 4 | **R2 索引优先** | 要动预算与渲染，放 R1 之后一起调 | 1–2 天 |
| 5 | **R4 睡眠候选 + R6 diff** | 纯增量，随时插 | 1.5 天 |
| 6 | **R8 冷存** | 等档案过 10MB 再做也不迟 | 1 天 |

## 10. 附录：数据与复现

```bash
# 榜单（本次实际用的查询）
curl -s "https://api.github.com/search/repositories?q=ai+companion+memory&sort=stars&per_page=15"
curl -s "https://api.github.com/search/repositories?q=llm+long+term+memory&sort=stars&per_page=15"
curl -s "https://api.github.com/search/repositories?q=agent+memory&sort=stars&per_page=15"
curl -s "https://api.github.com/search/repositories?q=ai+memory+sqlite&sort=stars&per_page=15"
curl -s "https://api.github.com/search/repositories?q=ai+memory+created:%3E2026-04-01&sort=stars&per_page=30"

# 下载量
curl -s "https://pypistats.org/api/packages/mem0ai/recent"
curl -s "https://api.npmjs.org/downloads/point/last-week/@modelcontextprotocol/server-memory"

# 落盘位置（本次）
# 仓库解包：D:\tmp\fm-research\repos\<owner>_<name>\
# 摘要：D:\tmp\fm-research\digest.md（27 个 README 摘录）
```

**口径提醒**：npm 是"周下载"，表里折算成月（×4.3）；PyPI 是"月下载"。两者不能直接相加，表里分别标注。

---

## 11. 一句话总结

这 27 个仓库里，**没有一个是"给一个具体的人养一条具体的鱼"**——它们解决的是"给任意 agent 加记忆"。
所以值得抄的不是算法，是**形态**：分层摘要（R1）、按需展开（R2）、一个 MCP 出口（R5）。
而我们的证据链、身份漂移、只提醒不改写，是这批项目里没有的东西，别在追新的时候弄丢。
