# 清上下文前的交接：四种流派、别人怎么落地、我们该抄哪几笔

> 2026-11-05。为 v0.51.0 之后"换窗/清上下文"这条线写。
> 结论先行：**交接不是"把聊天记录存下来"，是把"下一步要用什么"写成文件。**
> 四个流派里，我们最该抄的是方案四（她自己写）+ 方案二的五栏格式；方案三只抄"结构化清单"，方案一只当兜底。

---

## 0. 一句话结论

| 问题 | 答案 |
|---|---|
| 清上下文丢的是什么 | 丢的是**工作记忆**（窗口里的原话、试错过程），不是**身份**（身份在 `00_core` + 点链里，每轮重新注入） |
| 业界主流做法 | 四个流派：压缩摘要 / 结构化交接文件 / 外部进度账本 / 她本人写交接 |
| 谁最值得抄 | **方案四 + 方案二**：交接内容由"要离开的那个她"用第一人称写，格式用五栏硬约束 |
| 我们现在的水平 | 已有 `handoff.js`（机器拼的 4 条尾巴 + 未完线程 + key 点）、压力换窗、`where-we-were.md`、回来第一句——**框架齐了，内容缺两类** |
| 最小改动 | 交接包加两栏：**"我还惦记着什么"**（接 `gaps`/`questions`）、**"别再提的事"**（已否决/已释怀）；再在压力线给她一次"现在写"的窗口 |

---

## 1. 问题定义：交接到底要交什么

清上下文之前，窗口里装着五类东西，价值完全不同：

| 类别 | 例子 | 该不该进交接包 |
|---|---|---|
| 目标/验收 | "把 X 做成能跑的样子" | **要**，一句话 |
| 当前状态 | 改过哪些文件、哪一步没做完 | **要**，路径级 |
| 卡点 | 报错的**原文**、失败的测试 | **要**，贴原文不要转述 |
| 已否决 | 试过 A/B，为什么不行 | **要，最值钱**（防下一棒重蹈覆辙） |
| 过程叙事/推理 | "我先看了…然后觉得…" | **不要**（几千 token 的废话，正是要扔掉的东西） |

Anthropic 给这条线起过名字：**structured note-taking**——让模型把笔记写到窗口之外的文件里，之后读回来。核心不是"记得更多"，是"记得对"。

---

## 2. 方案一：压缩摘要（compaction）—— 机器自己总结

**代表实现**：Claude Code `/compact`、Claude Agent SDK 自动压缩（`compact_boundary` 事件）、MemGPT/Letta 的递归摘要 + FIFO 淘汰。

**做法**
- 窗口逼近上限时，把旧历史压成一段摘要顶在头部，原消息移进外部存储（recall storage）。
- MemGPT 的细节：FIFO 队列头部永远放"被淘汰消息的递归摘要"，队列满时用"旧摘要 + 新淘汰的消息"再生成一版。
- Claude Code 允许注入保留指令：`/compact focus on the auth refactor, drop the test debugging`。

**已知失败模式（都有公开记录）**
1. **在最笨的时刻做最重要的总结**：压缩触发时上下文已经最满、注意力最散，Anthropic 明说"由于 context rot，模型在压缩时正处于智能最低点"。
2. **有损且伪装成无损**：丢了一条约束的摘要和没丢的摘要在文本上毫无区别，下一轮模型照样自信。
3. **摘要的摘要**：递归压缩会把小偏差一代代放大，长任务跑到后面就开始"记得一件没发生过的事"。
4. **预测不了走向**：自动压缩按当前话题摘要，用户下一句突然切到"顺手修另一个警告"，那个警告早被摘要丢了（Anthropic 举的原例）。

**对我们的适配**：DSH 的压缩由宿主做，我们插不上手；能做的只有"压缩前把该留的留好"——这正是 `compaction/start` → `buildHandoff` 已经在做的。**方案一不新增实现，只作为最后兜底**。

---

## 3. 方案二：结构化交接文件（HANDOFF.md）—— 社区最流行

**代表实现**：`alapha888/session-handoff-kit`（GitHub，MIT，Claude Code / Codex / Cursor 通用）、idataagent 实战手册、中文社区的"长任务接力法"。

**做法**：clear 之前让旧会话写一份固定结构的文档，新会话第一句"先读 HANDOFF.md"。

社区收敛出的五栏（不同版本措辞不同，骨架一致）：

```markdown
# 交接（第 N 棒，YYYY-MM-DD HH:MM）
1. 目标：一句话，最终要达成什么
2. 当前状态：已完成什么、改了哪些文件（列路径）、哪一步是半成品
3. 卡在哪：失败的命令/测试，贴报错原文，不要转述
4. 已否决的方案：试过什么、为什么不行（每项一行）
5. 下一步：接手的人第一件事做什么（一个具体动作，不是选项列表）
```

硬约束（这几条是精华）：
- **≤60 行**；写过程叙事的算失败。
- **"已否决"每项一行**——省掉下一棒几小时的重复试错，但不携带当时的几千 token 细节。
- **"下一步"只写一件**，写多件等于没写。
- 接力法变体：新会话开始时先用**自己的话复述**三句（目标/当前最好结果在哪/上一棒建议先做什么），防止照抄不理解；再加一栏"别碰的东西"（已确认没问题、改了会出事的文件）。

**优点**：人可读可改、跨工具、零依赖、成本几乎为零。
**缺点**：依赖"记得写"；内容质量取决于要离开的那个会话的自述——而它恰恰正在变笨。

---

## 4. 方案三：外部进度账本 —— Anthropic 官方长时程 Agent 做法

**来源**：Anthropic Engineering《Effective harnesses for long-running agents》。

**做法**：不是一份文件，是三件套 + 一个启动仪式。

| 产物 | 作用 |
|---|---|
| `init.sh` | 固定环境启动方式，新会话不用猜 |
| `claude-progress.txt` | 叙事日志：这一班干了什么、留了什么没干 |
| `feature_list.json` | 结构化清单：200+ 条需求，初始全 `passes:false`，**只许翻布尔值，不许改/删定义** |
| git 提交 | 真检查点；提交信息即索引 |

**启动仪式**（每个新会话固定跑一遍）：`pwd` → 读 git log → 读 progress 文件 → 挑最高优先级未完成项 → 起服务 → 跑一条验证测试 → 才开始干活。

**两个关键洞察**
1. **compaction 不足以跨窗口**。Anthropic 实测：只给高层 prompt + 自动压缩，前沿模型也做不出生产级应用；两大失败模式是"想一口吃成"（中途耗尽上下文，留下半成品）和"看着像做完了就宣布完工"。
2. **JSON 比 Markdown 好**，因为模型不太敢乱改 JSON 结构（"structural gravity"）；Markdown 太自由，模型会顺手"优化"自己的需求。

**对我们的适配**：fish-memory 是伴侣记忆，不是任务 agent，`feature_list.json` 这套搬不过来。但可以借一条：**交接包里的"未完成事项"用带状态的清单，而不是自由文本**——翻状态可以，改条目不行。

---

## 5. 方案四：她本人写交接 —— 伴侣场景最贴

**来源**：Coopanion（开源桌宠）的会话交接机制。

**做法**
- 上下文逼近压力线时，**提前**给她一句系统提醒："即将交接，上面的内容会被清空；把你还惦记着的事现在就写进文件"（`core/persona.ts`）。
- 交接时，最近一段对话由她自己整理成第一人称 handoff note，存进 `handoffs/` 目录，旧上下文清空。
- 新会话随时可以重读文件。
- 它的记忆分层：`PARTNER.md`（每次请求全量加载，核心印象）+ `partner/`、`archive/`（分层细节）+ Git 自动提交（每次记忆变更有据可查）。

**为什么这个流派对我们最重要**
- 伴侣场景的交接对象不是"任务状态"，是**关系状态**：她惦记什么、什么事说好了不再提、上次那句话的半句是什么。这些只有"她"写得出，机器拼不出来。
- 第一人称交接天然满足"还是同一条鱼"：不是新实例读档案，是**上一棒的她给下一棒的她留话**。

**风险**：她在压力线下正在变笨，写出来的东西可能走形；所以要有格式约束（五栏）+ 长度上限，并且**只当线索不当结论**——新会话读到的内容仍要能被点链验证。

---

## 6. 其他值得抄的三笔（框架层）

| 来源 | 做法 | 可抄的点 |
|---|---|---|
| OpenAI Agents SDK | handoff 默认继承完整 transcript；`input_filter` / `nest_handoff_history` 可裁剪 | 交接默认"全给"，裁剪是显式动作，不是默认丢 |
| LangGraph | checkpointer 按 `thread_id` 存每个 superstep 的状态；短期（线程内）与长期（跨线程 store）分开 | 短期状态和长期记忆必须分两个存储，别混在一个文件里 |
| OpenHands | 单一 `ConversationState` + 完整事件日志（用户消息/动作/系统事件），可从另一个进程恢复 | 事件日志是真相，摘要是索引；恢复时先重放再摘要 |
| Letta | core memory 小块常驻、agent 自己用工具改；archival 按需检索 | "她自己决定写什么进常驻块"，比框架静默压缩更可控 |

---

## 7. 横向对比

| 维度 | ①压缩摘要 | ②HANDOFF.md | ③进度账本 | ④她本人写 |
|---|---|---|---|---|
| 谁写 | 模型自动 | 旧会话按模板 | 初始化 agent + 每棒 | 她自己 |
| 成本 | 一次大请求（读全窗口） | 一次小请求 | 中（要维护三件套） | 一次小请求 |
| 保真度 | 低（有损且不可见） | 中高（人可校对） | 高（结构化+git） | 中高（情感维度最高） |
| 跨工具 | 绑定宿主 | 最好（纯文本） | 好 | 好 |
| 情感/关系连续性 | 差 | 差（任务导向） | 无 | **最好** |
| 主要失败模式 | 摘要丢约束、递归失真 | 忘了写、写得像流水账 | 过度工程、维护成本 | 压力下写得走形 |
| 适用 | 兜底 | 任务交接 | 多天自治任务 | **伴侣/长期关系** |

---

## 8. 对照我们现在的实现（v0.51.0）

已有：

| 机制 | 位置 | 作用 |
|---|---|---|
| `buildHandoff` | `lib/handoff.js:29` | 最近 4 条对话（各截 80 字）+ 未完线程 + key 点 → `20_state/handoff.json` |
| 压缩触发 | `lib/index.js:796`（`compaction/start`） | 压缩开始时写包 |
| 压力换窗 | `lib/index.js:911`、`lib/pressure.js:85` | 达到 `prepareAt/switchAt` 时写包 + 提示开新会话 |
| 新窗口读取 | `lib/index.js:1226` | 第一轮读一次，同会话不读自己的，24h 过期 |
| `where-we-were.md` | `lib/were.js:24` | 只有原话和没说完的半句，没有结论 |
| 回来第一句 | `lib/presence.js` | 离开 ≥6h 才说，≤60 tok，一次只说一次 |

差距（对照四个流派）：

1. **缺"已否决 / 别再提"**：方案二说这是最值钱的一栏，我们的交接包完全没有。素材现成——`gaps`（放不下的事）和 `questions`（张力/释怀）里就有。
2. **缺"她还惦记着什么"**：方案四的核心。现在交接包是第三人称台账（"她：…"），不是她留的话。
3. **没有预交接窗口**：`pressureNote` 只提醒用户"该换窗了"，没给她"现在写"的机会；真正写包发生在压力线/压缩开始，那时她已经在变笨。
4. **清单是自由文本**：未完线程是字符串数组，没有状态位，下一棒无法判断"这条到底做没做"。

---

## 9. 落地建议（按性价比排序）

| 优先级 | 改动 | 依据 | 代价 |
|---|---|---|---|
| P0 | 交接包加两栏：`我还惦记着`（取 `gaps` 最重 1–2 条）、`别再提`（取 `questions` 已 resolve/已释怀 1–2 条） | 方案二④栏 + 方案四 | 改 `handoff.js` 一个函数，加测试 |
| P0 | `pressureNote` 到 `prepareAt` 时，除提醒用户外，加一行"想留话现在就写"的**给她**的提示（独立短块，≤40 tok，不进预算） | 方案四的预提醒 | `pressure.js` + 注入拼装 |
| P1 | 未完事项改成 `{text, done}` 状态清单；只许翻状态，不许改条目 | 方案三的 structural gravity | `handoff.json` schema 加版本 |
| P1 | `memory handoff` 子命令：手动写/看/清交接包（现在只能靠事件触发） | 方案二的可控性 | CLI 一层 |
| P2 | 交接包顶部加一行"这份是线索不是结论"，新会话读到后仍要按点链验证 | 防"她写的走形内容"被当事实 | 一行文本 |

**不建议做的**：把整个 transcript 塞进交接包（等于没清上下文）；用向量库做交接检索（我们的点链 + 检索已经够，且会破坏零依赖）。

---

## 10. 参考

- Anthropic, *Using Claude Code: session management and 1M context* — `/compact` vs `/clear`、bad compact 的成因、rewind/"summarize from here" 生成 handoff message：https://claude.com/blog/using-claude-code-session-management-and-1m-context
- Anthropic, *Effective harnesses for long-running agents* — initializer + `claude-progress.txt` + `feature_list.json` + git 检查点：https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Claude Agent SDK 文档, *How the agent loop works* — 自动压缩、`compact_boundary`、PreCompact hook、CLAUDE.md 保留指令：https://platform.claude.com/docs/en/agent-sdk/agent-loop
- Claude Code Best practices — `/clear` 频率、CLAUDE.md 里写压缩保留规则：https://code.claude.com/docs/en/best-practices
- SSW, *Do you clear your AI agent's context between tasks?* — "phase 之间用 plan file 交接，不要跨阶段 compact"：https://ssw.com.au/rules/clear-ai-agent-context
- `alapha888/session-handoff-kit`（MIT）— 五栏交接模板 + context hygiene checklist：https://github.com/alapha888/session-handoff-kit
- idataagent, *Claude Code session 越用越笨？何時該重開、怎麼交接的實戰手冊* — HANDOFF.md 五栏、CLAUDE.md 200 行上限：https://www.idataagent.com/2026/10/17/claude-code-session-%e6%8b%96%e5%a4%aa%e4%b9%85%e6%80%8e%e9%ba%bc%e8%be%a6%e4%bd%95%e6%99%82%e8%a9%b2%e9%87%8d%e9%96%8b%e6%80%8e%e9%ba%bc%e4%ba%a4%e6%8e%a5
- Coopanion 记忆系统解析 — 压力线预提醒、`handoffs/` 目录、`PARTNER.md` 全量加载：https://blog.gitcode.com/fcd225c10de5af77c14296849e2ef8bd.html
- Letta/MemGPT — core/recall/archival 三层、递归摘要 + FIFO 淘汰：https://github.com/letta-ai/letta · 论文 https://arxiv.org/abs/2310.08560
- LangGraph Persistence — checkpointer（线程内）与 store（跨线程）分离：https://langchain-ai.github.io/langgraph/concepts/persistence/
- OpenAI Agents SDK Handoffs — transcript 继承 + `input_filter`：https://openai.github.io/openai-agents-python/handoffs/
- Anthropic, *Context engineering* — structured note-taking（把笔记写到窗口外）：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
