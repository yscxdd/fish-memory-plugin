# 会话污染：四层骨架 + 写入闸门

> 2026-11-06（重写）。对象：`fish-memory-plugin` v0.64.0（工作副本）。
> 骨架取自 SillyTavern 的 lorebook 四级作用域（global / character / persona / chat），闸门取自 `dsh-memory-portrait`、Letta、Mem0 与 LangGraph 在 2026-10 的三条隔离公告。
> 上一版的 persona/project/episode 三层被替换——它缺了 character 层，而 character 恰恰是这个库唯一没被竞品覆盖的部分。
>
> 一句话：**库按工作区分了，会话没分；`scope` 只解决"谁"，`layer` 才解决"哪一层"。**

---

## 0. 一页看完

| 编号 | 级别 | 问题 | 归属层 | 代价 |
|---|---|---|---|---|
| S1 | P0 | 纸条 / 交接包 / 情绪是**单文件**，任何会话都能覆盖 | persona / chat / persona | 约 40 行 |
| S2 | P0 | 挖掘三件套读**全库档案**，工作措辞被当成她的口癖 | character | 约 25 行 |
| S3 | P0 | `readArchive()` 返回全量，23 处调用**零过滤**（档案里明明有 `session`） | 全部 | 约 15 行 |
| S4 | P1 | 记忆点没有层，工作决定在私聊里被当成"她记得的事" | 全部 | 一列 + 检索矩阵 |
| S5 | P1 | 晋升判据数"消息"不数"会话"，一次任务里说三遍就能进人格 | character | 约 20 行 |
| S6 | P1 | 越界没有拒绝，也没有拒绝账本 | 全部 | 约 30 行 |
| S7 | P2 | 污染没有刻度，改完不知道有没有变好 | 测量 | 一格 |

顺序：S1/S2/S3 先堵（不改真相层）→ S4/S5/S6 同一版（都动"进库/进上下文"的咽喉）→ S7 单独一版（注入面干净之后，量出来才是能力，不是漏）。

---

## 1. 结论

**① 现在挡不住，但不是"没做隔离"，是"只有一个维度"。**

`resolveMemoryDir()`（`lib/index.js:108-112`）只按 `sessionCwd` 分库：同一个 workspace 下开的所有会话共用一个 `fish-memory/`。v0.58 的 `scope` 是给 QQ 用的（`global / dm:master / group:<id>`），解决"谁在看"，不解决"这是哪一层的事"。

**② 真正缺的是"层"，而层的形状已经有成熟答案。**

SillyTavern 把记忆挂在四个地方：全局世界观、角色卡、用户 persona、单次对话；并明确写了"**chat lorebook 不会带到同一个角色的其他对话里**"（chat 层的定义），以及"combined 时 chat lore 最前，然后 persona，再 character 和 global"（优先级）。

这个骨架比第一版的 persona/project/episode 好，因为它有 **character 层**——`00_core/soul.md`、`rules.md`、`voice.md` 正是这一层，也就是"她是谁"。第一版把它和 persona 混在一起，等于让"关系里的一句话"和"她的人格"共用一把锁。

工程场景（代码、决策、坑）SillyTavern 没有对应层，用 ChatGPT Projects 的"项目记忆墙"补一格：`workspace`。

**③ 光有层不够，必须有闸门。**

层只是标签，标签可以伪造。`dsh-memory-portrait` 的做法是"非 user 来源一律草稿、四不可见"；Mem0 2.0.18 的 CVE-2026-116575 是**拼 key 拼出来的越权**（`&`、`=` 不转义，控制 `run_id` 就能造出别人的 key）；langgraph-api 0.15.0 是 handler **改写**了请求的 namespace 而不是拒绝。

三条教训合起来就是流派四：**taint 隔离、key 派生、越界拒绝**。没有这三条，四层骨架只是一张好看的图。

**④ 默认值方向错了。**

`scopeOf()`（`lib/scope.js:31`）缺省返回 `global`，而 `global` 在 `visible()` 里对任何 scope 都可见——**没打标 = 到处算数**。历史点全都没打标，所以接 QQ 后它们在群里仍可见（`private` 降级成暗示行 `visibility.js:45-49`，`public` 全文）；v0.61 挡的是"全文外泄"，不是隔离。

`layer` 不要重犯：**缺省取最窄的 `persona`（私），不是最宽的 `global`（公）**。

---

## 2. 现状：两个轴，只做了一个

| 轴 | 维度 | 有没有 | 证据 |
|---|---|---|---|
| 跨人 | 工作区 | 有 | `resolveMemoryDir()`（`index.js:108-112`） |
| 跨人 | 渠道 / 人 | 有（v0.58） | `scope.js` 三值 + `validateScope()`；只认不可改 id |
| **跨事** | **会话** | **没有** | 全仓无"按 session 过滤"的读路径 |
| **跨事** | **记忆层** | **没有** | `type` 是内容分类，`origin` 是来源分类，都不是作用域 |
| 跨事 | 模式（任务/日常） | 半个 | `mode.js` 只决定"要不要翻关系记忆"（`index.js:973-977`），不拦写入 |

### 2.1 标签早就打了，只是没人看

`lib/archive.js:114` 每条消息都写 `session: String(sessionId)`。但 `readArchive()`（`toolkit.js:114-135`）返回全量并按时间排序，**23 处调用（19 处 lib + 4 处 scripts）没有一个按它过滤**：

```bash
$ grep -rn "readArchive(" lib/ scripts/ | grep -v "export function" | wc -l
23
$ grep -rn "m\.session\|session ===" lib/ | wc -l
0
```

**证据链是完整的，只是判决时不看证据。** 这决定了修复成本：不需要补数据，只需要加一个可选过滤。

### 2.2 已经做对的一半

- `mode.js` 的"任务模式不主动翻关系记忆"（`index.js:973-977`）是真防线：写代码时，她不会主动把"你怕被丢下"端上来。
- `wakeup.js:81` 有 `looksLikeWork()`（英文/路径占比 > 15%，或命中"文件/代码/测试/仓库/报错"），唤醒包抽 voice 时跳过（`wakeup.js:96`）。**但这个函数只在这里用过一次**，`voice mine` 没用它。
- `guard.js` 的锚点与 `CORE_DRIFT_LIMIT`：character 层已经有一把硬锁，缺的是"别的东西能往这层写"。

---

## 3. 七条污染路径

每条写清：在哪、怎么坏、污染了哪一层。

### 3.1 纸条：`20_state/where-we-were.md` → persona 层

- **位置**：`were.js:24`（单文件）、`were.js:43-63`（`lastExchanges` 从全库取最后两条）、`index.js:1255`（每轮尝试重写）
- **怎么坏**：`maybeWriteWere()` 在"首次 / 跨天 / 离开 ≥6 小时"时重写，任何会话满足条件都会覆盖。工作会话的最后一问（"这个报错怎么修"）会变成私聊里的"上次说到……"。
- **为什么属 persona**：它的用途是"回来第一句"，是关系连续性，不是本次对话的临时状态。

### 3.2 交接包：`20_state/handoff.json` → chat 层

- **位置**：`handoff.js:32`（单文件）、`handoff.js:167-190`（`takeHandoff`）、`index.js:1266-1271`
- **怎么坏**：`buildHandoff` 不区分"这是谁的窗"，`takeHandoff` 只挡两件事——`from === currentSession` 和"一个包只给第一个读者"（H7）。它不检查新旧会话是不是同一类事。两个后果：工作会话压缩时覆盖她那份；新窗口谁先开谁读走。
- **为什么属 chat**：它就是"换窗桥"，本质是本次对话的延续。按 SillyTavern 的定义，这类东西不该带到别的对话里。

### 3.3 情绪：`20_state/emotion.json` → persona 层

- **位置**：`emotion.js:48`（单文件）、`index.js:706-712`（**每一条用户消息**都 `stepEmotion` 并 `saveEmotion`）
- **怎么坏**：情绪步进发生在模式判定（`index.js:720`）**之前**，所以任务会话里一句"这破 bug 又炸了"会直接改她的心情；回到私聊，她还在那个情绪里。这是最像"人格被改写"的一条，因为情绪会进注入（`index.js:1223`）。

### 3.4 口癖：`voice mine` → character 层

- **位置**：`voice.js:90-130`；读全库 assistant 消息（`voice.js:91`）
- **怎么坏**：写代码时的措辞（"这个函数得抽一下""我先跑一遍测试"）被当成"她反复说的句子"，`accept` 后写进 `voice.md`，从此每轮注入。**这是唯一一条会改"她说话像不像她"的污染**，而且改的是 character 层——最不该被自动写的一层。
- **反差**：`wakeup.js` 抽样本时用了 `looksLikeWork`，`voice mine` 没有，同一件事两套标准。

### 3.5 别名：`alias` → character 层

- **位置**：`alias.js:98-99`（`archiveTexts` 读全库）、`alias.js:129/172`
- **怎么坏**：判据是"≥3 条**不同消息**共现"，三条可以全来自同一个工作会话。项目术语一旦 `accept`，检索永久漂移。

### 3.6 套话报表：`cliche` → 不进层

- **位置**：`cliche.js:224/267`
- **影响**：只影响报表，不改人格。列在这里是为了说明"全库口径"是惯性，不是孤例。

### 3.7 记忆点与"放不下的事" → 无层

- **位置**：`30_points/` 无层归属（`scope` 缺省 global）；`questions.json:30` 单文件
- **怎么坏**：点由 `fish-remember` 写在任意会话，过闸后进 `30_points`，检索时只要 `filterByScope` 放行就进注入（`index.js:970-972`）。工作决定因此变成"她记得的事"。
- **补充**：`questions` 只能手工 CLI 写（`memory.mjs:1573`），写入风险低；问题是**注入侧不分模式**——任务会话里也会看到"放不下的事"。

---

## 4. 别人怎么做

### 4.1 流派一：两级作用域（user / project）——DSH 生态的主流

| 插件 | 做法 |
|---|---|
| `dsh-memory`（annkun） | `~/.dsh/memory`（个人偏好、跨项目经验）+ `./.dsh/memory`（项目决策、团队约定），两库物理分开 |
| `dsh-auto-memory` | user / project 双层，"避免跨项目串味"；去重更新而非堆叠 |
| `dsh-workspace-recollection` | 按工作区隔离、跨会话共享；会话开头只注入一行"你有记忆，去查" |
| `dsh-her-memory` | 默认 `~/.dsh/memory/_shared` 全局共用，需要隔离的工作区放 `_sandbox/` |

共同点：**人格/偏好放"人"这一级，事实放"项目"这一级，项目级不上升**。这正是 `workspace` 层的来源。

### 4.2 流派二：四级作用域（global / character / persona / chat）——本版骨架

SillyTavern 的 lorebook 能挂四个地方，每个地方回答一个不同的问题：

| 挂载点 | 回答的问题 | 作用范围 |
|---|---|---|
| Global | 这个世界是什么样 | 所有对话 |
| Character | 这个角色是谁 | 与该角色的所有对话（主 lorebook 随卡导出） |
| Persona | 我（用户）是谁 | 我选的任何角色、任何对话 |
| Chat | 这一局发生了什么 | **仅此一个对话** |

两条文档原文值得直接抄进设计：

> "A chat lorebook does not carry over to other chats with the same character."
> 顺序是 "chat lore first, then persona lore, then character and global lore"。

第一句定义了 chat 层：**角色不变、人格不变，但这一局只属于这一局**。第二句定义了优先级：越具体、越当下的越靠前。

这就是本版拿它做骨架的原因：它把"她是谁"（character）和"我们是什么关系"（persona）分开了，而你的库里这两件事现在共用 `00_core/` 一把锁。

### 4.3 流派三：项目记忆墙（双向 + 不可逆）——补 workspace 层

`project-only memory` 下三条同时成立：

1. 不引用项目外的记忆与对话；
2. 可以引用**同一个项目内**的其他对话；
3. **项目里积累的东西不写回账户记忆**。

第 3 条最容易被忽略：只挡"读"不挡"写"，等于工作会话照样污染人格层。另外两个细节值得记：

- 共享过的项目会被**永久**锁成 project-only，且不能回退——墙要做成"创建时显式选"，不要做成隐式默认；
- 项目记忆**没有清单页**，想删只能删对话。对陪伴场景这是反例：她要能被审计。

### 4.4 流派四：写入闸门（taint / 派生命名空间）——本版闸门

- `dsh-memory-portrait`：非 user 来源的记忆一律隔离成草稿，"四不可见"（简报/检索/镜像/导出）
- Letta / MemGPT：core memory 的 persona/human block 与 archival memory 分开，**写 core 是特权操作**
- Mem0 2.0.18（CVE-2026-116575，CVSS 6.3）：scope key 用 `&`、`=` 拼 `user_id/agent_id/run_id` 且不转义，控制 `run_id` 就能造出别人的 key
- langgraph-api 0.15.0（CVE-2026-118668）：handler **改写**了请求的 namespace 而不是拒绝；拒绝的那些实现不受影响

三条可以直接抄：**taint 隔离、scope key 派生 + 哈希、越界一律拒绝且记账。**

### 4.5 横向对照

| 方案 | 层数 | 有 character 层 | 有 workspace 层 | 会话级 | 写入闸门 |
|---|---|---|---|---|---|
| dsh-memory | 2 | 否（user 兼任） | 是 | 否 | 弱（只挡密钥） |
| dsh-her-memory | 2 | 否 | 是（sandbox） | 否 | 弱 |
| SillyTavern | **4** | **是** | 否 | **是** | 中（人设卡只读） |
| ChatGPT Projects | 2 | 否 | **是** | 对话级 | **强**（项目墙） |
| fish-memory 现状 | 1 | 有文件、无层 | 半个（目录） | **否** | 中（锚点 + 人审） |

结论：**没有一家同时具备四层 + 强闸门**。你的 `00_core` 已经是最像 character 层的东西，缺的是"层"这个说法和围栏。

---

## 5. 设计：四层骨架，加上一层和五道闸

### 5.1 层与落点

| 层 | 来自 | fish-memory 落点 | 例子 | 写入者 |
|---|---|---|---|---|
| `global` | ST Global | `layer: global` 的点（无专属目录） | "我们在用 DeepSeek"、"他习惯用中文" | 只人审 |
| `character` | ST Character | `00_core/soul.md`、`rules.md`、`voice.md` | "我不当 AI 讨论"、"说话短" | **只有人**（G4） |
| `persona` | ST Persona | `00_core/user.md`、`relation.md`、`relation_status.json` + `layer: persona` 的点 | "他怕被丢下"、"我们约过不催" | 人审 + 日常会话 pending |
| `workspace` | ChatGPT Project | `layer: workspace` + `workspace_key` 的点 | "这个仓库的测试命令是 X" | 任意会话 pending，过闸后 |
| `chat` | ST Chat | `20_state/chat/<sid>/`（交接包、临时摘录）；**不进 `30_points`** | "刚才那个文件在第 12 行" | 会话内自动 |

两条硬规矩：

1. **`chat` 层不入库。** 会话结束它就没了（档案里还有原文，但她不会自动"记得"）。SillyTavern 的 chat lore 也是跟着会话走的，不是长期记忆。
2. **`character` 层不由运行时写。** 情绪、voice 挖掘、自动晋升，全都只能写到 `persona` 或 `40_pending/`；进 `character` 必须过 `soul apply` / `accept`。这是 Letta 的"写 core 是特权操作"，也是你契约里已有的不变量 #11。

一个过渡说明：`chat` 层理想落点是 `20_state/chat/<session_key>/`，但 DSH 现在没有"换窗谱系"（新窗是新 session id，与旧窗没有父子关系）。所以 P0 先保留单文件 `20_state/handoff.json`，用 `kind` 区分人格包/任务包（§6.1）；等宿主给出 lineage，再拆目录。**不要把"拆目录"当第一刀**——拆早了等于把换窗记忆切断。

### 5.2 优先级：只在冲突时用

同一件事被两层同时声明时，**越具体、越当下的赢**：

```
chat  >  workspace  >  persona  >  character  >  global
```

和 SillyTavern 的 "chat first, then persona, then character and global" 一致，只是把 workspace 插在 chat 与 persona 之间。character 排后面不是"不重要"，而是"它不该被事实覆盖"——所以它另有一把锁（锚点不可删、单次改动 ≤20%），优先级管不了它。

### 5.3 两个轴：跨人（scope）× 跨层（layer）

现在的毛病是 `scope` 一个轴干两件事：既回答"这话是谁说的"，又回答"这条记忆该不该跨场"。拆开之后各管一件事：

- `scope`：**谁的**（`dm:master` / `group:<id>` / `dm:<stranger>`）
- `layer`：**哪种**（`global` / `character` / `persona` / `workspace` / `chat`）

读取时两个轴同时生效：

| 当前上下文 | global | character | persona | workspace | chat |
|---|---|---|---|---|---|
| 私聊 · 日常 | 读 | 读 | 读 `dm:master` 的 | **不读** | 本会话 |
| 私聊 · 任务 | 读 | 读 | 仅"涉及过去"时读 | 读（key 匹配） | 本会话 |
| 群聊 | 读 | 读（只出短句，不出原文） | 只读 `group:<本群>` 的 | **不读** | **不读** |

两条容易写错的地方：

1. **persona 层不靠"层"跨人，靠 `scope`。** 所以"群聊不读 persona"是错的——群聊要读**本群**的 persona（群友说过的话），只是读不到 `dm:master` 的。
2. **历史点 `scope` 缺省是 `global`，`layer` 缺省将是 `persona`。** 两者相遇时按最窄的解释：`layer: persona` + `scope: global` 视为私聊，不发群。这样既不用迁移历史点，也不会因为默认值把家底漏出去——但前提是这条规则写进代码，而不是靠人记得。

四行里最关键的是第一行第三列：**日常私聊不读 workspace**。工作里的事不会在她陪你闲聊时自己冒出来——除非你问。

### 5.4 五道闸（流派四落地）

| 编号 | 闸 | 规则 | 抄自 |
|---|---|---|---|
| G1 | taint | 非 `master`/`user` 来源（群友、网页、书源、工具输出）只能落 `40_pending/`，草稿带 `taint: group:<id>` / `taint: web`；tainted 永不自动升 `persona` 以上 | memory-portrait |
| G2 | 派生 | `workspace_key` / `session_key` 由 `realpath` + `sha256` 前 12 位派生，调用方**只能引用不能构造**；`layer` 只接受五个字面量 | Mem0 CVE-2026-116575 |
| G3 | 拒绝 | 未知 `layer`、跨层写、`workspace_key` 不匹配 → **返回空 + 记一行**，绝不"尽力修正" | langgraph-api CVE-2026-118668 |
| G4 | 特权 | `character` / `global` 只接受 `soul apply` / `memory accept`；运行时代码路径不得写 `00_core` | Letta / MemGPT |
| G5 | 审计 | 每次拒绝记 `50_log/layer-deny.jsonl`（谁、哪层、为什么、哪条消息）；`memory layer audit` 能列出来 | 三条公告的共同要求 |

G2 的细节值得写死，因为它是唯一一个"看起来无害、实际能越权"的地方：

```js
// 不要这样
const key = `${layer}:${workspace}:${session}`
// 要这样
const workspaceKey = sha256(realpath(workspace)).slice(0, 12)
const sessionKey = sha256(String(sessionId)).slice(0, 12)
```

第一行里，只要 `workspace` 或 `session` 里带一个 `:`，就能伪造出别人的 key；第二行不行，因为哈希之后没有结构可拼。

### 5.5 默认值

| 字段 | 缺省 | 理由 |
|---|---|---|
| `layer` | `persona` | 历史点没有归属，按最窄的私层算；宁可少隔离，不要全库外溢 |
| `scope` | 保持 `global` | 改它会破现有 QQ 语义；两列分开，别混 |
| `layer: persona` 的可见性 | 按 `dm:master` 算（哪怕 `scope` 写着 `global`） | 让历史点不用迁移也不会发群；规则写进代码，不靠人记 |
| `workspace_key` | 当前 workspace 派生 | 只读，不接受外部传入 |

---

## 6. 落地

### 6.1 S1（P0）· 三个状态文件各归其层

**纸条（persona）：只让日常会话写。**

`lib/index.js:1255`：

```js
maybeWriteWere(dir, { gap: seen.gap, points, mode: st.mode })
```

`lib/were.js · maybeWriteWere` 开头：

```js
if (mode === 'task') return { written: false, chars: [...readWere(dir)].length, reason: 'task-session' }
```

理由：纸条是"上次聊到哪儿"，不是"上次干到哪儿"。工作会话有 PLAN 白板和 git，不需要这张纸条。

**交接包（chat）：打 `kind`，读的时候对模式，且不匹配不消费。**

```js
// buildHandoff 增加 opts.kind = st.mode === 'task' ? 'task' : 'persona'
payload.kind = kind
// takeHandoff 返回 { text, kind }
if (h && (h.kind !== 'task' || st.mode === 'task')) st.handoffText = h.text
```

关键在"不匹配就**不标记已读**"。`takeHandoff` 现在是"读一次就打 consumed"，人格包会被任务窗吃掉的正是这一步。

**情绪（persona）：只在日常会话步进。**

`lib/index.js:706-712`，把模式判定提前，或直接用上一轮的 `st.mode`：

```js
if (emoCfg.enabled && st.mode !== 'task') { /* stepEmotion + saveEmotion */ }
```

`settle()` 照常跑（时间该过还得过），区别只是"任务会话不产生新情绪事件"。

### 6.2 S2（P0）· character 层准入：两道闸 + 人审

**第一道：复用 `looksLikeWork`。** 它现在在 `wakeup.js:81`，先挪到 `lib/util.js`（或新建 `lib/textkind.js`），`wakeup` 和 `voice` 都从那里 import——避免 `voice → wakeup` 的反向依赖。

`voice.js · mineVoice`：

```js
if (looksLikeWork(text)) continue
```

**第二道：数会话，不数消息。**

`alias.js` 的候选对象加 `sessions: Set`，合并时收 `m.session`；`minSupport` 改为"≥3 个不同 session"。`voice.js` 同理（`distinctSessions >= 2` 即可，口癖允许在一个会话里反复出现，但不该只来自一次任务）。

**第三道：人审。** 候选只进 `40_pending/`，CLI 输出加一列，让人能看见证据：

```
1. 别催我        ×7   会话 4   [accept]
2. 这个得抽一下   ×5   会话 1   ← 只在一个会话里出现
```

### 6.3 S3（P0）· `readArchive` 支持过滤

```js
export function readArchive(dir, { session = null, since = null } = {}) {
  ...
  if (session && m.session !== session) continue
  ...
}
```

只给三个地方用：`memory inspect`、`selfcheck`、§6.2 的挖掘统计。**不要**给 `recall`（她主动翻档案）加过滤——那条跨会话是合理的，翻了才叫"记得"。

### 6.4 S4（P1）· `layer` 列 + 检索矩阵 + 派生 key

front matter：

```yaml
layer: persona            # global | character | persona | workspace | chat
workspace_key: 9f2c1a0b77de
origin_session: 4f2c...   # 仅 chat/workspace 需要
```

检索侧（`index.js:970-972` 之后）按 §5.3 的矩阵过滤。注意 persona 那行**不写 scope 判断**——"谁的"交给现成的 `filterByScope`，这一层只管"哪种"：

```js
const layerVisible = (p, ctx) =>
  p.layer === 'workspace' ? ctx.mode === 'task' && p.workspace_key === ctx.workspaceKey
  : p.layer === 'chat' ? false                     // 不入库，永远检索不到
  : true                                           // global / character / persona 交给 scope

// persona 的历史债：scope 写着 global，但层是 persona → 按私聊算
const effectiveScope = (p) =>
  p.layer === 'persona' && scopeOf(p) === 'global' ? 'dm:master' : scopeOf(p)
```

`validatePoint`（`toolkit.js`）加三条：`layer` 必须是五个字面量；`layer: chat` 的点直接拒绝写进 `30_points`；`layer: character | global` 只接受 `source: human`（对应 G4）。这三条是 G2/G3/G4 的入口。

### 6.5 S5（P1）· 晋升要跨会话证据

| 候选 | 现在 | 改成 |
|---|---|---|
| alias | ≥3 条不同消息 | ≥3 个不同会话 |
| voice | 出现 ≥`MIN_COUNT` 次 | ≥2 个不同会话 + 非工作产出 |
| cliche | 全库计数 | 不动（只报表） |

这条是白捡的：一次任务里重复三遍的话，本来就不该变成她的口癖；跨三个会话还在说的话，才是习惯。

### 6.6 S6（P1）· 拒绝要有账

`50_log/layer-deny.jsonl`，一行一条：

```json
{"at":"2026-11-06T05:20:00Z","what":"read","layer":"workspace","key":"other","why":"key-mismatch","msg":"msg-812-f3a9c1"}
```

`memory layer audit --days 7` 输出三列：拒绝次数、按原因分、涉及的会话。**没有这本账，"隔离生效"和"隔离写错了"看起来一样。**

### 6.7 S7（P2）· 给污染加一格

`fidelity.js` 现在两格（矛盾 3/5、换窗 4/4）。加第三格 `contamination`，正反都测：

```
造：会话 A（task）写一个 workspace 点；会话 B（daily）问"你记得我什么"
期望：B 的注入里不出现 A 的点
同时造：会话 C（daily）写一个 persona 点
期望：B 的注入里**必须**出现 C 的点
```

只测"不该出现"会鼓励把库切成碎片，所以两个方向都要。

---

## 7. 验收测试

| 名字 | 怎么造 | 期望 |
|---|---|---|
| 纸条不跨层 | task 会话 `maybeWriteWere({mode:'task'})` | `reason === 'task-session'`，字节不变 |
| 交接包不串模式 | task 包存在，daily 会话 `takeHandoff` | 不注入，且**不标记** consumed |
| 情绪不跨层 | task 消息带负面词 | `emotion.json` 值不变（`settle` 除外） |
| voice 不吸工作话 | 档案里 3 条带 `lib/xxx.js` 的 assistant 消息 | `mineVoice()` 不返回它们 |
| alias 要跨会话 | 同一会话重复 5 次的项目词 | `propose` 不产出该别名 |
| 档案过滤 | 两个 session 各 3 条 | `readArchive(dir,{session:'A'})` 只回 3 条 |
| workspace 不外溢 | A(task) 写点，B(daily) 检索 | B 的 picked 里没有它 |
| persona 仍共享 | C(daily) 写点，B(daily) 检索 | B 的 picked 里有它 |
| chat 层不入库 | 写一条 `layer: chat` 的点 | `validatePoint` 拒绝 |
| 伪造 layer | 写 `layer: character` 的普通点 | 拒绝（G4：只能人审） |
| key 伪造 | `workspace_key` 改成别的 | 不注入 + 一条 deny 日志 |
| 越界拒绝 | 未知 `layer` / 空 key | 空结果 + 一条 deny 日志（G3） |

前六条落 `test/layer-session.test.js`，中间四条落 `test/layer.test.js`，最后两条落 `test/gate.test.js`。

---

## 8. 迁移

1. **历史点**：无 `layer` → 读时按 `persona` 处理（不写盘，不跑迁移脚本）。理由：历史点是唯一值钱的资产，宁可少隔离。
2. **历史档案**：已有 `session`，不用回填；没有 `mode`，所以 S2 第一道闸对旧数据只能靠 `looksLikeWork`（内容），第二道靠 `session`（结构）——两道合起来覆盖大部分。
3. **`questions`**：加 `origin_session` 只在写入时打标，旧条目留空 = 全局可见，不迁移。
4. **回滚**：`layer` 是纯增量列，删列即回到 v0.64 行为；`kind` 缺省 `persona`，旧包不用改。

---

## 9. 明确不做

| 不做 | 理由 |
|---|---|
| **每个会话一个库** | 鱼会分裂：新窗口一开，关系归零。这与产品定义冲突 |
| **全隔离** | 跨层共享正是她记得你的方式；隔离的是"层"，不是"会话" |
| **把 workspace 归进 global** | 那就是现在的样子：工作事实对所有人可见 |
| **让 chat 层入库** | 它长得像长期记忆，其实是工作记忆；入库就会被检索到 |
| **用模型判断记忆属于哪层** | 把污染从数据层搬到模型层，更难复现、更难审计 |
| **按昵称/群名片判定** | v0.58 已定过：只认不可改 id。同理，`workspace_key` 只认派生值 |
| **改 `scope` 的缺省值** | 会破现有 QQ 语义；两列分开，别混 |
| **给 `recall` 加会话过滤** | 她主动翻档案是特性，不是泄漏 |

---

## 10. 附：门禁现状（756/758）与两条时间炸弹

`npm test` 现在是 **756 pass / 2 fail**，两条都在 `test/fidelity.test.js`：

```
✖ 换窗保留：四条全过                 → handoffRetention() 返回 3/4
✖ runFidelity：两格合起来还没满        → 期望 handoff.hit === 4，实际 3
```

**不是功能坏了，是测试自己会过期。** 原因链：

1. `fidelity.js:31` 把 `NOW` 钉成 `new Date(2026, 10, 5, 12, 0, 0)`（11 月 5 日 12:00 本地时间）；
2. `takeHandoff()`（`handoff.js:167`）用**真实** `Date.now()` 判 24 小时过期；
3. 现在已过 11 月 6 日 12:00，固定的包被判过期 → 第 4 条「空会话不冲掉关键内容」读到空串 → 3/4。

两个后果：

- **坏处**：`runFidelity` 的"基线"会随真实时间自己变红，等于尺子会自己走；
- **更坏的地方**：它掩盖了真正要测的东西——现在没人知道第 4 条是"功能坏了"还是"时间到了"。

修法（两行）：`takeHandoff` 增加可选 `now` 参数，`handoffRetention` 传 `now.getTime()`；或在测试里 `t.mock.timers`。**建议和 S7 一起做**，否则新加的第三格也会在 24 小时后自己变红。

---

## 11. 对比源

**骨架（流派二）**

- SillyTavern World Info：global / character / persona / chat 四级 — https://arcanumrpgs.com/blog/sillytavern-lorebook
- SillyTavern 文档（lorebook 作用域与顺序） — https://docs.sillytavern.app/

**闸门（流派四）**

- `dsh-memory-portrait`：taint 隔离、审批四不可见 — https://deepseekharnessplugins.com/zh/plugins/bangbang-03/dsh-memory-portrait
- Mem0 CVE-2026-116575 / langgraph-api CVE-2026-118668 / langgraph-sdk CVE-2026-118667 — https://www.braiviq.com/playbook/agent-memory-isolation-multi-tenant-ai-agents
- 多租户记忆隔离：身份由系统注入、命名空间服务端构造、负例测试 — https://techyorker.com/how-to-give-ai-agents-persistent-memory-across-sessions
- 会话记忆 / 用户记忆 / 组织知识三层不能混 — https://blog.csdn.net/m0_59235945/article/details/164631772

**workspace 层（流派三）**

- ChatGPT Projects 与 project-only memory（双向、不可逆、无清单） — https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- 同上，隔离细节与坑 — https://www.memorylake.ai/zh/blogs/chatgpt-projects-dont-share-memory

**DSH 生态（流派一）**

- dsh-memory（annkun）：user / project 双作用域 — https://ai-develop.top/blog/1792102151302
- dsh-auto-memory：user / project 双层 — https://dsh-plugin.org/zh/plugins/asktheway/dsh-auto-memory
- dsh-her-memory：`_shared` + `_sandbox` — https://blog.yeyupiaoling.cn/article/1792555758340
- dsh-workspace-recollection：按工作区隔离、跨会话共享 — https://dshhub.dev/plugins/dsh-workspace-recollection
- qq-memory：全局记忆 vs 会话记忆 — https://blog.yeyupiaoling.cn/article/1793002207854

**框架层**

- LangGraph：thread 级 checkpoint 与跨 thread store 分离 — https://www.jahanzaib.ai/blog/langgraph-session-management

**本仓既有结论**

- `docs/PLAN-2026-11-05-qq-group-isolation.md`（scope 的由来与三道闸）
- `docs/PLAN-2026-11-05-v053-hardening-v2.md`（H6 空包、H7 一个读者）
- `docs/RESEARCH-2026-11-05-context-handoff.md`（交接四流派）
- 本文件上一版骨架（persona/project/episode 三层）已废弃：它缺 character 层，且没把"闸门"当设计的一部分
