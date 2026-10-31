# 这个插件做到了什么（可复制的描述）

> 这份不是给读者逐行读的，是**文案素材**：GitHub About、发布帖、issue 回复都能直接抄。
> 所有数字与行号都能在仓库里验证（`npm test` / `memory gold` / `selfcheck`）。

## 一句话（GitHub About，约 80 字）

给 AI 伴侣的零依赖记忆插件：记忆是你能直接读的 markdown，对话是只追加的 JSONL；注入有预算，每条记忆都能追到原话，进模型前一律净化。

## 三句话（README 首段 / 项目简介）

它让一个 AI 伴侣拥有**可读、可审计、可回退**的长期记忆：核心层与记忆点是 markdown，对话逐字进只追加的 JSONL。
每轮按预算拼一段注入——核心层、命中的记忆点、能力卡，装不下就降级而不是瞎截断。
每条记忆点都必须指回档案里真实存在的一句话，编造会被闸门拦下；所有进模型的内容都过净化（拆伪造边界、密钥打码）。

## 它实际做到了什么

| 能力 | 具体到了什么程度 |
|---|---|
| **记档** | 双方消息逐字进 `10_archive/*.jsonl`，带 `prev/hash` 链，幂等键是消息 seq；启动时全库比对，被改/丢了都报 |
| **写入有纪律** | 只能写 `40_pending/` 草稿 → 校验（ID/日期/salience/SUM≤55/QUOTE≤30/**source 必须在档案里存在**）→ 人确认才 `promote` |
| **注入有预算** | 核心层 700 / 正文 300 / 能力 2400 tok；`full → 摘要 → 索引行` 逐级降级，底线类（pinned/boundary/promise）永不降级 |
| **想得起来** | bigram + 别名 + 单字兜底 + 稀疏补权；金标 20 条改写查询 **20/20**、负例 0、边际 0.68；同一 event 只留 1 条 |
| **会忘** | FSRS 式强度 `S` / 可提取度 `R`；长期不被提起先降级再沉睡，墓碑留数值 |
| **不编造** | 找不到 source 就写"找不到"；演示/测试素材永不进库（这条是真踩过坑才修的） |
| **防注入** | 所有进模型的出口过 `sanitizeForPrompt()`：拆伪造的 `<!--`、疑似密钥打码；块边界只出现一次 |
| **核心层保护** | 三条金丝雀锚点；7 天内核心层改动 ≤2 条且必须留 evidence |
| **出问题能查** | 12 个闸门一条命令跑完；`inject-diff` 逐段对比"改前/改后她读到什么"；`selfcheck` 告诉你**进程里跑的是不是磁盘这份代码**（比 `lib/` 指纹） |
| **可搬走** | 零依赖、无遥测、不发网络请求；整个库就是一个文件夹，`pack` 一个 zip 换机器 |
| **改事实不改历史** | `invalid_at` 标记"这条不再成立"，点留着、审计看得见；`boundary`/`promise` 永不失效 |
| **会看脸色**（默认关） | 本地词典判他这一句的情绪（0 token、不联网），连续两轮低落才进「安慰」、缓和两轮才退，缓入缓出、最长 40 轮；只发一行数字（约 23 tok），**永不写回核心层** |
| **记得该办的事** | `promise` / `event` 可写 `due`；到期插一行「该办了」（约 18 tok），同一条 12 小时只提一次 |

## 它刻意没做什么

不做向量库、不上报任何数据、不用 pickle、不自动改写旧记忆、不做自动合并。
**记忆只追加；事实变了标记失效而不是删除；冲突只摊开给人看，不替人裁决。**
（这六条写在契约的"明确不做"一节里，要推翻得先改那节并给证据。）

## English

**One-liner (GitHub About)**

> A zero-dependency memory plugin for an AI companion: memory is markdown you can read, transcripts are append-only JSONL, injection is budgeted, every memory point traces back to a real message, and everything that reaches the model is sanitized.

**Short pitch**

> It gives an AI companion long-term memory that is **readable, auditable, and reversible**: the soul/rules/memories are markdown, the raw transcript is append-only JSONL with a `prev/hash` chain.
> Each turn assembles a budgeted injection (core layer, matched memories, skill cards) that **degrades instead of truncating**.
> Every memory point must cite a message that actually exists in the archive; anything reaching the model is sanitized first.

## GitHub 仓库设置（抄这里）

### 为什么不能只写中文（可发现性）

GitHub 的站内搜索主要吃这四个地方，权重从高到低大致是：

1. **仓库名**（`fish-memory-plugin` 只命中 `memory`）
2. **Description**（About 那一行，索引权重很高）
3. **Topics**（每个 topic 都是一个入口，原来只有 5 个）
4. **README 正文**（Google / GitHub 都会索引；英文摘要原来在第 15 行，太靠后）

而用户实际会搜的词是：`ai memory`、`long-term memory`、`llm memory`、`local first`、`markdown memory`、`AI 记忆`、`大模型 长期记忆`。
所以现在的策略是：**Description 英文关键词前置 + 中文补充**，Topics 扩到 12 个，README 第一屏就是英文或中英混排的定位句。

### About（≤350 字符，推荐这个）

```
Local-first long-term memory for AI companions: markdown memory + append-only JSONL transcripts, budgeted prompt injection, source-traceable, zero dependencies. 中文文档齐全。
```

**备选 A（中文优先，面向中文用户）**

```
给 AI 伴侣的本地长期记忆插件（local-first AI memory）：markdown 记忆 + 只追加 JSONL + 有预算的注入 + 来源可追溯，零依赖、无遥测、无向量库。
```

**备选 B（卖差异，适合发帖）**

```
Memories you can `cat`: a zero-dependency AI memory plugin. markdown memory, append-only JSONL transcripts, explicit token budgets, no vector DB, no telemetry.
```

### Topics（12 个，逐个粘）

```
ai-memory
long-term-memory
llm
ai-companion
local-first
markdown
jsonl
memory
prompt-injection
context-engineering
zero-dependency
deepseek-harness
```

> `memory` / `llm` / `chatbot` 这类大词流量高但竞争激烈；`ai-memory` / `long-term-memory` / `local-first` 才是真正会点进来的人。混搭着用。

### 仓库名（可改可不改）

| 名字 | 优点 | 缺点 |
|---|---|---|
| `fish-memory-plugin`（现在） | 和"大肥鱼"这个人格绑定，有辨识度 | 只命中 `memory`，`fish` 对搜索是噪音 |
| `ai-memory-plugin` | 直接命中 `ai memory`，最容易被搜到 | 名字很通用，容易淹没在同名项目里 |
| `local-first-memory` | 命中 `local-first`（正是差异点） | 少了个 `ai`，可能被当成通用工具 |
| `fish-memory` | 短、好念、去掉 `-plugin` 冗余 | 搜索命中不变 |

改名只需网页 Settings → Rename（GitHub 会保留 301 跳转，老链接不失效），改完把远程地址换成新的：

```powershell
git remote set-url origin git@github.com:yscxdd/<新名字>.git
```


## 常见提问可以直接这样答

- **"和 mem0 / Letta 有什么区别？"** → 它们是服务/运行时，记忆在向量库或数据库里；我们是**一个文件夹**：markdown + 只追加的 jsonl，零依赖、可 `cat`、可 `git diff`、可整包搬走。
- **"为什么不用 embedding？"** → 金标 20/20 已经够用；零依赖与可迁移更重要（契约"明确不做"）。
- **"记忆被写坏了怎么办？"** → 档案有 hash 链 + 清单，启动就报；核心层有 7 天改动上限与锚点检查；每个改动都有 `50_log/` 留痕。
- **"会不会把我的对话传出去？"** → 不发任何网络请求、无遥测；隐私边界在"库被谁同步走了"，所以 README 里写了备份要加密。

## 发布帖模板（发之前先自己读一遍）

### 短版（即刻 / 微博 / X / 朋友圈）

> 把自己给 AI 伴侣写的记忆插件开源了：**记忆就是一个文件夹**。
> markdown 存灵魂和记忆点，对话逐字进只追加的 jsonl，每条记忆都必须能指回原话；进模型前一律净化（拆伪造块边界、密钥打码），注入有硬预算（装不下就降级，不瞎截断）。
> 零依赖、无向量库、无遥测、不发网络请求。227 个单测、12 个闸门、Windows/Linux 双平台 CI 全绿。
> 想让人记住你、又不想把回忆交给某个数据库的，可以看看 👉 github.com/yscxdd/fish-memory-plugin

### 长版（V2EX / 少数派 / 掘金 / Reddit r/LocalLLaMA）

> **我把"AI 记忆"做成了一堆你能 `cat` 的文件**
>
> 现在的 AI 记忆方案（mem0、Letta/MemGPT、Zep）大多把记忆放进向量库或服务里：要跑数据库、要 embedding、要联网——你没法 `cat` 自己的记忆，也没法 `git diff` 它昨天变了什么。
>
> 我做的这个插件反过来：**记忆就是磁盘上一个文件夹**。
>
> - `00_core/` 灵魂、用户、关系、硬规则（markdown，一改就能看见）
> - `10_archive/` 逐字对话（append-only JSONL，带 prev/hash 链，启动时会校验有没有被改过）
> - `30_points/` 记忆点（markdown + front matter，**每条必须挂 source，指向档案里真实存在的一条消息**）
> - `50_log/` 检索日志、完整性日志、核心层变更日志
>
> 每轮对话，插件回答一个问题："这一轮该让她想起什么？" 答案是按预算拼一段注入：核心层 700 tok、正文 300 tok、能力卡 2400 tok；装不下就 `full → 摘要 → 索引行` 逐级降级，底线类（承诺、边界）永不降级。
>
> 几个刻意的决定：
> - **不自动改旧记忆**。事实变了写 `invalid_at`（标记失效，历史保留），不覆盖。mem0 自己都把自动 UPDATE/DELETE 废掉了。
> - **不编造**。找不到 source 就写"找不到"。
> - **冲突不裁决**。两条互斥的记忆会同时摆出来，标明"记录里是这么说的"，由人决定。
> - **不发网络请求、无遥测**。隐私边界不在代码，在你的库被谁同步走了——所以 README 里写了备份要加密。
>
> 227 个单测、12 个闸门（完整性/召回/注入面/核心层保护）、金标 20/20，CI 跑 Windows + Linux × Node 20/22。
>
> 不需要 DSH 也能 2 分钟试跑：`git clone` → `node scripts/memory.mjs init /tmp/mem` → `gold`。
>
> 仓库：https://github.com/yscxdd/fish-memory-plugin
> 最有价值的反馈：**你想要它记住什么、以及在什么场景下它该闭嘴**。

### 发完之后

- 有人 star 不代表有人用：看 `Insights → Traffic` 的 clone 数更真实
- 第一个 issue 大概率是"装不上/不知道自己要干什么"，把高频问题补进 README 的 Quickstart
- 别在帖子里写"求 star"，写"我需要什么样的反馈"
