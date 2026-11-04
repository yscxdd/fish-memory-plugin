# 差距与修法（2026-11-04）

> 起因：对 **v0.46.0** 做了一次全量代码审查（`npm test` 实跑：573 条，572 pass / 1 skip / 0 fail）。
> 这份不是功能清单，是**接下来改什么、怎么改、怎么验收**。每条都要能落到一个版本、一组测试、一次闸门。

## 0. 一句话

**功能不缺，缺三样：库是空的、召回只会字面、没有真实语料基准。**

P0 的三件全部指向这三点；P1 是补洞；P2 是写下来先别做的。

另有 **P0-0**（§5.1，一小时就能修）：`memory config` 显示的情绪默认值和运行时真实值不一致——它不是能力问题，是**读数问题**，所以排在所有功能之前。

三条不许违反的约束（沿用现有纪律）：

1. 零依赖（只用 Node 内置模块）
2. 真相层只走闸门（agent 只写 `40_pending/`，`30_points/` 必须人审 promote）
3. 进模型的每一块都过 `sanitizeForPrompt`、都计 token、块边界只出现一次

---

## 1. 为什么这么排（先把判断说清楚）

`docs/BACKLOG.md` 在 **v0.28.0** 就宣布功能冻结，理由是"真实数据是 0"。但 CHANGELOG 显示 v0.29 → v0.46 又加了 **18 个版本**：遗忘层、情绪（CHANGELOG 说"默认开"，代码里默认关，见 §5.1）、习惯权重、注意力、时间轴、实体表、Everything、静态报告……真实数据仍然是 0。

后果不是"功能错了"，是**归因失效**：一次回复变冷，可能来自情绪 tier、注意力加权（有压力时危机×3）、时间意图、习惯 w、正文降级——五个旋钮同时动，没有数字能说清是谁。

所以排序原则只有一条：**先做"能产生数据 / 能用数据判对错"的改动，其余排队。**

| 优先级 | 事项 | 不做会怎样 |
|---|---|---|
| P0-0 | 修「情绪默认值」显示失真（§5.1） | 你看到的状态是假的，后面所有"开了/没开"的判断都不可信 |
| P0-1 | 待审队列 + 到期整理提醒 | 库继续是空的，后面所有调参继续靠猜 |
| P0-2 | 别名半自动（补召回，不引向量） | 换了说法就搜不到，"她记得"变成"她只认字" |
| P0-3 | 真实语料回放基准 + bench 进 CI | 没有空召回率这个数字，P0-2 做完了也不知道有没有用 |
| P1 | 归档生命周期 / 跨进程锁 / caption / 情绪纠错 / 同步诊断 / 加密提醒 | 用得越久越慢、越难搬、越不敢删 |
| P2 | 只读审阅页 / MCP / 可选语义旁路 / 多用户 | 现阶段做等于在没接数据线的板子上焊芯片 |

---

## 2. P0（三件，按此顺序，各一个版本）

### P0-1 · 待审队列 + 到期整理提醒 → v0.47.0

**问题（证据）**

- 写入链路是：agent 写 `40_pending/` → 人 `promote`。但**没有任何"该审了"的提示**。
- `lib/remind.js` 只提醒 `promise` 的 `due`，不碰草稿；`lib/presence.js` 只在离开 ≥6 小时后说话。
- 结果：BACKLOG 记的"真实数据 0"里，大概率有一半不是"没写"，是"写了没人审"。

**改法**

1. 新模块 `lib/pending.js`（≤180 行，纯读）：
   - `scanPending(dir)` → `[{ id, title, ageDays, valid, errors }]`，校验复用 `toolkit.validatePoint`（只读，不写盘）
   - `pendingLine(items, { now, lastNoticeAt })` → 一行，**≤24 tok**：
     ```
     【待审】3 条草稿（最老 6 天，1 条校验不过）
     ```
   - 冷却 24h，状态写 `20_state/pending-notice.json`（照抄 `remind.js` 的 `reminded.json` 模式，别新造机制）
2. `lib/render.js` 的 `assemble({ notice })`：**按已有的"小行"方式加一个 part**（和 `question` / `due` / `returnLine` 同层，`push('notice', notice)`），不要塞进 body 挤占记忆预算。
   - 位置：`work` 之后、`ghosts` 之前——先让她知道自己有话没整理，再想别的。
3. CLI：
   - `memory pending [--json]`：列表 + 校验状态，只读
   - `memory pending --stale 7`：只看超 7 天没处理的
4. `digest --due`：距上次 digest ≥ 3 天且档案有新增 → **只在 CLI 打一行建议**，不进注入（避免变唠叨）
5. 明确不做：不自动 promote、不自动写 `30_points`、不在注入里列草稿标题（只给数量 + 最老天数）

**代价**

- 每轮 +≤24 tok；`lib/stats.js` 的 `LAYERS` 要加 `notice`（否则占比重加起来对不上），`report` 的 token 分块表也要跟着加一行
- 新增一个注入块 → 必须补 3 条断言：块边界唯一、过净化、空库不出行
- 开关：`pending.notice`（默认开，可关）

**验收**

- [ ] 空库：注入里没有这一行
- [ ] 1 条合格草稿：下一轮出现「1 条草稿（最老 0 天）」
- [ ] 同一会话第二轮：不重复出现（冷却生效）
- [ ] `promote` 之后：下一轮消失
- [ ] 3 条里 1 条 source 造假：行里标「1 条校验不过」，**不隐藏**
- [ ] `npm test` 新增 ≥8 条；`gold` 仍 20/20；`selfcheck` 12 闸门全绿

---

### P0-2 · 别名半自动（先补召回，不引向量）→ **✅ v0.48.0 已落地（实现形态见下）**

**问题（证据）**

- `lib/retrieve.js` 只有字面二字组重合（`bigrams` + `overlap`），阈值 0.8。
- `lib/goldset.js` 注释里自己列了四类缺口：**指代（"上次那个"）、跨会话时序（"上周三"）、否定（"我不讨厌香菜"）、多语言混写**。
- `aliases` 字段早就有了（`toolkit.assetAliases` / `rankHybrid` 会并进 tags），但**全靠人手填**；素材点之外没人用。

**改法（零依赖 + 人审）**

1. 新模块 `lib/alias.js`：
   - 输入：一条点（`title/quote/tags`）+ 档案里提到它的那几天
   - 取原话左右各 40 字窗口，抽 2–6 字片段（按 bigram 边界对齐），过滤停用词 / 纯数字 / 路径 / 纯标点
   - 与 `title` + 现有 `aliases` 做 dice：**≥0.5 且不在 title 里**才算候选；每点最多 3 个
   - 输出到 `40_pending/_alias/<id>.alias.md`（草案），**不直接改点**
2. CLI：`memory alias mine [--limit 20]` / `memory alias --accept <id>` / `--reject <id>`
   - `accept` 只写回那条点的 `aliases: []`，并追加 `50_log/alias.log` 一行（谁、加了什么、从哪条原话挖的）
3. 检索侧**一行不改**：`rankHybrid` 已经把 `aliases` 并进 tags 一起算
4. 明确不做：不做向量、不做同义词表硬编码（那会变成"我猜她怎么说话"）、不自动 accept

**代价**

- 新模块 ~200 行 + 3 个 CLI 动作；**零新增注入 token**
- 风险：档案窗口噪声大 → 误报。所以先只从「QUOTE / [原话] 段」挖，跑一周看 accept 率再放大到 SUM 与正文

**验收**

- [ ] `samples/` 造 10 条点 + 20 轮对话：`alias mine` 出 ≥6 条正确别名、误报 ≤1 条
- [ ] accept 之后，一条"同义改写"查询从 0 分变成命中
- [ ] `gold` 新增 3 条同义改写查询（先测基线、再改检索，顺序不能反）
- [ ] `check` 对带 aliases 的点仍不报错（已有能力，要加回归）

---

### P0-3 · 真实语料回放基准 → v0.50.0

**问题（证据）**

- `gold` 是**合成的 20 条**，`goldset.js` 自己写着"这套题不会输，改成能输之后才有分辨力"——它证明的是"没退化"，不是"能召回"。
- `scripts/bench.mjs` 存在，但 `.github/workflows/ci.yml` 只跑 `npm test` / `verify` / `hostcheck` / `gold` / `audit`，**bench 不在 CI**。
- 全仓没有一个数字叫"真实对话的空召回率"。

**改法**

1. `scripts/eval-replay.mjs`（只读，不改库）：
   - 输入：一份脱敏档案 + 一个库
   - 把每条 `user/message` 当 query 跑 `rankHybrid`（用当前配置与权重）
   - 输出：`空召回率 / 平均命中数 / 注入 token 的 p50·p95 / 每题命中 id`
   - `--compare <weights.json>`：出前后对照表（命中数变化、空召回变化）
2. `samples/replay/` 放 50–100 轮**合成**对话（不是任何真人的），CI 跑它；断言下限先放宽（空召回率 ≤ 60%），跑两周再收紧
3. `bench.mjs` 进 CI：`--n 200,1000,5000`，断言 p95 装配 < 150ms（**先测当前值，再定阈值**，别拍脑袋写死）
4. `stats` 与 README 的「实测」表：所有数字必须标来源（合成 / 回放 / 真库），不再混着写

**代价**

- CI 多两步，+≤30s；`samples/replay` 要脱敏审查（不能带任何真实城市名、人名、手机号——这条 `audit-self` 已经在查）
- 回放只看检索，不看回复质量：**它不是评测"她像不像她"，只评测"她记不记得"**

**验收**

- [ ] 首次跑出真实数字，写进 README「实测」表（现在只有合成数字）
- [ ] 改一次阈值 → `eval-replay --compare` 能出一张对照表，正负都看得见
- [ ] CI 红/绿能区分"检索退化"与"测试写错"

---

## 3. P1（补洞，按价值排）

| # | 问题（证据） | 改法 | 验收 |
|---|---|---|---|
| 1 | **归档没有生命周期**：只有按 id `erase`；`10_archive` 永久增长；启动 `integrity.checkArchive` 全量比指纹 | `memory archive --cold --before YYYY-MM-DD`：整天文件移入 `10_archive/cold/` 并 gzip；manifest 记冷区摘要；`checkArchive` 热区全量 + 冷区抽样（每文件首尾 100 条） | 造 2 年合成档案，冷归档后启动校验 < 1s；`verify` / `audit` 仍过 |
| 2 | **跨进程写没锁**：`archive._append` 只有"文件大小变过就重读链头"（V5 自愈），`withLock` 只用于 `store.flush` | 档案追加前 `withLock(dir, ...)`；保留 size 自愈当二道防线；`archive-race.log` 保留 | 两个进程各写 500 条并发：1000 条无坏行、`verifyChain` 通过 |
| 3 | **多模态不可检索**：`ASSET_KINDS` 只分 text/binary，binary 只验 sha256 | asset 加 `caption`（人写 ≤40 字）；`assetAliases()` 把 caption 并进 tags；`alias mine` 也扫 caption | 给一张图写 caption「海边日落」，查「日落」能命中该素材点 |
| 4 | **情绪误判无纠错**：词典三分类 83.9% / hard 50%；只能 `memory feel` 手动改档，改完不回流评测 | `memory feel --wrong [--label X]` 写 `50_log/emotion-corrections.jsonl`；`eval-emotion` 单列一组「含纠正样本」准确率 | 累计 20 条纠正后，eval 报告多一行数字，不掩盖原基线 |
| 5 | **同步只有搬家**：`pack/unpack` 是整库移动；两边各写会触发"档案被改"告警 | 先做**只读诊断** `memory merge-check <other-dir>`：报档案天文件差集 + 点 id 冲突；**不做自动合并** | 输出可读差异表；README/SECURITY 写明"本插件不做双向同步" |
| 6 | **静态即明文**：脱敏是正则；备份加密只写在建议里 | 不做应用层加密（会毁掉 `cat`）。把提醒变成检查：`privacy` 发现备份目录在 OneDrive/坚果云/Dropbox 路径下 → 明确告警 | 备份放 OneDrive 时 `privacy` 给出告警，退出码非 0 |

---

## 4. P2（写下来，先别做）

| 事项 | 为什么现在不做 | 什么时候做 |
|---|---|---|
| 只读审阅页（report 加"待审/冲突/最重问题"三块） | 没有待审数据，页面是空的 | P0-1 跑满两周后 |
| MCP 适配（把 `memory_recall` / `fish-remember` 包成 MCP，复用 lib） | 只服务"换宿主"，当前只有 DSH | 有人真要在别的宿主用 |
| 可选语义旁路（`retrieval.semantic.provider = off / http`，默认 off） | 引向量就破了"零依赖、可迁移"；且没有 P0-3 的数字，做了也不知道赚不赚 | P0-2 之后空召回率仍 > 50% 再谈 |
| 群聊 / 多用户隔离 | `resolveMemoryDir` 是单库单关系，做群版要重做真相层 | 不做 |

---

## 5. 先修这三处"说错了"的地方（比新功能便宜，优先级高于 P0-1）

### 5.1 情绪开关的默认值，四处说法不一致，其中两处会骗人

| 位置 | 说法 |
|---|---|
| `lib/config.js` → `BOOLEAN_RULES.emotion.enabled` | **false**（运行时真实默认） |
| `lib/settings.js` → `TUNABLES` 里 `default` | **true**（`memory config` 列表按它显示"默认 true"） |
| `CHANGELOG` v0.38.0 | "情绪默认开" |
| `README` / `docs/DESCRIPTION.md` | "默认关" |

后果：新装用户跑 `memory config`，看到 `emotion.enabled = true（默认 true）`，但运行时 `index.js` 走的是 config 的 `false`——**以为开着，其实没开**。反向更糟：`memory config reset emotion.enabled` 会打印"已恢复默认：true"（`resetSetting()` 用的是 `spec.default`），实际生效仍是 false。

这不是纯文档问题，是**读数失真**：`memory config` 的列表和 `reset` 的回显都会跟着错。`report` 只读 `20_state/emotion.json`（状态文件），不受影响，但它也因此**说不了"情绪层到底开没开"**——一个应该有的字段缺了。

改法（约 1 小时）：`TUNABLES` 的 `default` 不再手写，从 `normalizeConfig({})` 读同一份；`resetSetting()` 打印的 `to` 用真实生效值；补一条测试断言「每个 TUNABLES 的 default == config 的默认值」；CHANGELOG 那句改成"默认由 profile 配置打开"。

### 5.2 规模数字过期

CHANGELOG 写「102 个文件（lib 44 · test 47 · docs 9）」，实测 **180 个文件（lib 61 · test 75 · docs 13）**。两个选择：① 用 `scripts/scale.mjs` 生成 + CI 断言；② 直接删掉数字只留命令。**建议 ①**，因为这份仓库的可信度有一半建立在"数字可复核"上。

### 5.3 测试数与乱码

- README 徽章写 573，实测 **572 pass + 1 skip**（`test/docs.test.js` 里"契约文件不在"那条）。要么改 572，要么写 `573（1 skipped）`——现在这种写法会让人以为 573 全绿。
- CHANGELOG v0.42 那一行有乱码：`memory ws add + ind`（应为 `find`），顺手修。
- `docs/DESCRIPTION.md` 的能力表把情绪写成"默认关"——与 5.1 一起改。

---

## 6. 我可能错的地方（反方，先写下来）

- **P0-1 可能变成打扰**：如果他一周只聊一次，24h 冷却毫无意义；如果她/他讨厌被催审，这行就是负资产。→ 所以默认开 + 开关 + 冷却，且**只在有草稿时出现**。
- **别名挖掘可能误报高**：档案窗口里全是"嗯""好的"，挖出来的别名是噪声。→ 先只从 QUOTE 段挖，accept 率 <50% 就退回纯手工。
- **真正的瓶颈可能不是召回，是写入质量**：她也可能"写了很多，但都是废话"。→ P0-3 的回放要同时统计"命中的点里被用到的比例"，别只看召回。
- **如果 DSH 三个月内升 0.3**：`engines.dsh` 会直接拦在装载阶段，那时 **compat 优先于一切**，P0 全停，先补一个"假 ctx 跑 apply + 两轮事件"的 e2e（现在只有静态 `hostcheck` + 快照对比，没有真宿主测试）。

---

## 7. 每条改动的通用闸门（不变）

1. 新字段必须可缺省：老点没有该字段 = 默认值，不许要求迁移
2. 新注入块：过 `sanitizeForPrompt` + 计 token + 块边界唯一（各一条测试）
3. 新 CLI：没有宿主也能跑（`scripts/memory.mjs` 里不许 import `ctx`）
4. 新宿主口子：登记 `HOST_POINTS` + 打 `[HOST: ...]` 标记，`hostcheck` 必须过
5. 每条新机制配一条不变量断言（`test/invariants.test.js`）
6. 不自动改真相层：任何"自动写入 `30_points/` / `00_core/`"的方案直接拒

---

## 8. 落地顺序与版本

| 版本 | 内容 | 新增测试 | 闸门 | 预计改动面 |
|---|---|---|---|---|
| ~~v0.46.1~~ | P0-0 默认值单源 + 显示修正（§5.1）——**2026-11-04 已落地** | ≥3 | 全闸门 | `settings.js`、`config.js`、`memory.mjs`（打印） |
| ~~v0.47.0~~ | **已被「套话计数」占用**（用户直接需求，见 CHANGELOG v0.47.0），下表顺延一个版本 | — | — | `lib/cliche.js`、`voice.js`、`scaffold.js` |
| ~~v0.48.0~~ | P0-2 别名半自动——**2026-11-04 已落地**（`alias` 先做，因为它已实测能把同义 0.00 变成命中；P0-3 的基准随后） | 15 | 全闸门 | `lib/alias.js`（新）、`lib/toolkit.js`、`memory.mjs` |
| v0.49.0 | P0-1 待审队列 + 提醒 | ≥8 | test / verify / hostcheck / gold / audit / selfcheck | `lib/pending.js`（新）、`render.assemble`、`index.js`、`memory.mjs` |
| v0.50.0 | P0-3 回放 + bench 进 CI | ≥6 | CI 多两步 | `scripts/eval-replay.mjs`（新）、`ci.yml`、`samples/replay/` |
| v0.51.0 | P1-1 冷归档 + P1-2 跨进程锁 | ≥10 | 同上 | `lib/archive.js`、`lib/integrity.js`、`memory.mjs` |
| v0.51.x | P1-3~6 + 文档自净 | ≥8 | 同上 | `assets.js`、`emotion` 相关、`privacy.js`、文档 |

**如果只有一天：先做 P0-0（1 小时，让读数变真），再做 P0-1 的最小版（`memory pending` 列表 + 注入一行）。** 待审队列不提升任何能力，但它是唯一能把"库是空的"变成"库有东西"的改动——没有它，后面每一条都还是在猜。

---

## 9. 验收总表（发版前逐条打勾）

- [ ] `npm test` 全绿（新增 ≥ 上表数量）
- [ ] `node scripts/memory.mjs verify` / `hostcheck` / `gold` / `audit` 全过
- [ ] `node scripts/selfcheck.mjs` 12 闸门全绿（**版本号与运行时一致**，不许"绿灯假象"）
- [ ] `inject-diff` 前后对比：新增块只出现在该出现的那一轮
- [ ] `tokens` 均值变化在预期内（P0-1 预计 +≤24 tok/轮）
- [ ] README / CHANGELOG / BACKLOG 三处同步（含"当前规模"数字）
