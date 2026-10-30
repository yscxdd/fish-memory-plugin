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

**About（≤350 字符）**

```
给 AI 伴侣的零依赖记忆插件：记忆是你能直接读的 markdown，对话是只追加的 JSONL；注入有预算，每条记忆都能追到原话，进模型前一律净化。
```

**Topics（5 个）**

```
ai-memory  long-term-memory  markdown  prompt-injection  deepseek-harness
```

**Description 英文备选**（如果想让国际用户搜到）

```
Zero-dependency long-term memory for AI companions: markdown memory + append-only JSONL transcripts, budgeted injection, source-traceable points, sanitized prompts.
```

## 常见提问可以直接这样答

- **"和 mem0 / Letta 有什么区别？"** → 它们是服务/运行时，记忆在向量库或数据库里；我们是**一个文件夹**：markdown + 只追加的 jsonl，零依赖、可 `cat`、可 `git diff`、可整包搬走。
- **"为什么不用 embedding？"** → 金标 20/20 已经够用；零依赖与可迁移更重要（契约"明确不做"）。
- **"记忆被写坏了怎么办？"** → 档案有 hash 链 + 清单，启动就报；核心层有 7 天改动上限与锚点检查；每个改动都有 `50_log/` 留痕。
- **"会不会把我的对话传出去？"** → 不发任何网络请求、无遥测；隐私边界在"库被谁同步走了"，所以 README 里写了备份要加密。
