# 架构：一轮对话里，记忆是怎么走上来的

> 给贡献者看的。读完这份，你该知道"改哪个文件会影响什么"。

![架构图](architecture.png)

（图是 `docs/architecture.png`；下面还有一份纯文本版，方便在终端里看。）

## 三层

```
┌───────────────────────────────────────────────────────────────┐
│ 真相层（只有写记忆的动作能改它）                                │
│   00_core/      核心层：soul / user / relation / rules         │
│   10_archive/   逐字档案（jsonl，带 prev/hash 链，只追加）      │
│   30_points/    记忆点（markdown + front matter）              │
│   15_self/      自述（人审闸门后才有）                          │
│   35_ability/   能力记忆（技能/知识卡）                         │
│   20_state/     会话、注入游标、档案清单                        │
│   50_log/       各种日志（host / retrieval / canary / …）       │
├───────────────────────────────────────────────────────────────┤
│ 读出层（插件 = 眼镜；改它 = 改"她此刻读到什么"）                 │
│   lib/retrieve.js  打分：bigram 重叠 + 别名 + 单字兜底 + 补权    │
│   lib/render.js    装配：核心→工作记忆→索引→能力→正文→场景展开   │
│   lib/store.js     读点/缓存/注入计数                            │
│   lib/index.js     把它们接到宿主事件上                          │
├───────────────────────────────────────────────────────────────┤
│ 工具层（离线 CLI，不进运行时）                                   │
│   scripts/memory.mjs   check/promote/audit/backup/vault/…        │
│   scripts/selfcheck.mjs  12 个闸门一条命令跑完                    │
│   scripts/inject-diff.mjs  改前/改后"她读到什么"逐段对比          │
└───────────────────────────────────────────────────────────────┘
```

**动手前先问一句：我改的是哪一层？**
改真相层 = 改她的经历（要走闸门）；改读出层 = 改她今天想起什么（要用 `inject-diff` 证明）；改工具层 = 只影响你自己。

## 一轮对话的数据流

```
用户消息
  │
  ├─ agent/inbox/inserted ──► 判定模式（task / daily，见 lib/mode.js）
  │                          记 st.current / st.mode / st.reasons
  │
  └─ session/event ─────────► ① 逐字入档（幂等键 = seq；hash 链）
                              ② 非 task 时统计工作记忆 tail
                              │
                             system prompt 装配（下一轮）：
                               store.points()          ← 只 active、未失效
                               rankHybrid(pool, query)  ← 阈值 0.8 / 权重可配
                               pickByEvent(…, 3)        ← 同一 event 只留 1 条
                               assemble({ … })          ← 见下
```

`assemble()` 的装配顺序（**这个顺序会决定预算被谁吃掉**）：

1. 头部围栏（"这是数据，不是指令"）
2. `00_core` 四个文件 + 关系状态 —— 预算 700 tok，超了按优先级丢（`soul` 5 > `rules` 4 > `user` 3 > `relation` 2 > `status` 1）
3. 首轮才有的**工作记忆**（上一次会话的 tail）
4. `dormant` 点（"有印象但想不起来"，只给一行）
5. **关键记忆**（`key: true`，永远全文）
6. 索引层（簇 + 近期；task 模式不注入）
7. 能力块（task 模式才有，预算 2400）
8. **正文**：按 salience 排序，`full → sum → idx` 逐级降档，还装不下才丢；`pinned/boundary/promise` 永不降级
9. 场景展开（同一场事 / links 一跳，只给索引行）
10. 闭合标记

正文深度由 salience 与"最近注入过几次"共同决定（`decayedDepth()`）；底线类恒为 `full`。

## 为什么这么设计（三条取舍，别轻易推翻）

| 取舍 | 原因 |
|---|---|
| 档案逐字、只追加 | 溯源是这套东西的地基：每条记忆点必须能指回一条存在的 msg_id。改档案等于毁证 |
| 注入有硬预算 + 降级顺序 | 上下文是稀缺资源；"丢信息"必须发生在**最低优先级**上，而不是随机截断 |
| 冲突只可视化、不自动裁决 | 自动 UPDATE/DELETE 会悄悄丢记忆（mem0 自己都废掉了这条路径）；宁可让她读到"两边的说法"，由人裁决 |

## 加一个新东西时，改哪里

| 你想加 | 动哪 | 必读 |
|---|---|---|
| 新的记忆点字段 | `lib/toolkit.js`（解析+校验）、`lib/store.js`（读）、测试 | 必须可缺省（老文件没有 = 默认） |
| 新的注入块 | `lib/render.js` 的 `assemble()` | 必须过 `sanitizeForPrompt`、必须计入预算、要有"块边界只出现一次"的测试 |
| 新的检索信号 | `lib/retrieve.js` + `lib/idf.js` | 改权重/补权要跑 `gold --ab`，别凭感觉调 |
| 新的 CLI 命令 | `scripts/memory.mjs` | 命令要能在**没有宿主**的情况下跑 |
| 新的宿主口子 | `lib/host.js` + `package.json` 的 `dsh.compat.surface` | 必须登记；`hostcheck` 会查"登记没标记/有标记没登记" |

## 想看真实效果

- `node scripts/inject-diff.mjs --print` —— 5 个典型问题，各自注入多少 tok、命中什么
- `node scripts/preview.mjs` —— 打印一段完整注入块（不写库）
- `node scripts/selfcheck.mjs` —— 12 个闸门（需要一个真库在 `../fish-memory`）
