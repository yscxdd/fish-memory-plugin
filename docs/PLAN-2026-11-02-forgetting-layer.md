# 遗忘层 · 设计与清单（v0.29）

> 需求（2026-11-01，你提的）：**在两轮遗忘之间加一个"遗忘层"**。
> 第一轮把该忘的放进去（忘得快）；如果这东西后来被你提起，就把它拉出来；没人提，第二轮用正常参数把它处理掉。

## 决定（2026-11-01，你拍的）

| 问题 | 你的决定 | 落地 |
|---|---|---|
| 第一层里还能"想起标题"吗 | **保留 ghosts** | `dormantPoints()` 现在同时读 `30_points`（旧状态）与 `31_dormant`；注入里仍有 ≤5 行标题（e2e 已验证"注入里有标题: true"） |
| 删除时留残片吗 | **留半句残片**（接上 `scars`） | 记在 C 组：purge 时写 `fragment: ≤12 字` 进墓碑；`scars` 因此从 backlog 里"提前"了 |
| 复活上限 | **每复活一次，上限 +1** | 落地成"每复活一次，下次进层的年龄门槛 **+15 天**"（`RESURRECT_GRACE_DAYS`）；复活满 3 次自动 `pin: soft`。上限本身仍可再谈 |
| 第一轮多少天 | **一个月就够，甚至偏长** | 改成 **30 天 + R<0.72**（见下表的数） |

### 为什么 30 天 / R<0.72（用我们自己的 FSRS 算的）

我们的 `R(t,S) = (1 + (19/81)·t/S)^(-0.5)`，`initialStability(salience, arousal) = 1 + 3·salience`（arousal>0.7 时 ×1.8）：

| salience | S | 30 天 | 45 天 | 60 天 | 90 天 |
|---|---|---|---|---|---|
| 1 | 4 | **0.60** | 0.52 | 0.47 | 0.40 |
| 2 | 7 | **0.71** | 0.63 | 0.58 | 0.50 |
| 3 | 10 | 0.77 | **0.70** | 0.64 | 0.57 |

所以：`dormantR = 0.72` + `dormantDays = 30` 的效果是——
- salience **1**：约 **22 天**就进层
- salience **2**：正好 **30 天**
- salience **3**：要 **45 天**（走慢的那条，`DORMANT_R_HARD=0.57` + 90 天）

即"一个月左右沉下去"，和你说的"一个月可以了、有时还嫌长"对得上。

## 一、目标（怎么算做成了）


1. 库里不再只增不减：长期没人提的东西，最终真的会消失（点文件删除，档案不动）
2. 但"消失"是**有回头的**：被重新检索到 → 自动复活，而且复活后更难再被判"该忘"
3. 第一轮快、第二轮慢（正常 FSRS 参数），中间那一层是**物理隔离**（独立目录），不是只改个 status
4. 每一步都留痕：进层、复活、删除各有日志，`audit` 看得见

## 二、我们现在有什么（代码事实）

| 现状 | 位置 |
|---|---|
| 状态阶梯已存在：`active → demoted → dormant` | `lib/forget.js:83-87` |
| 但 `dormant` 只是**状态**，文件仍在 `30_points/`，**永不删除** | 同上；`forget.js` 无 delete 分支 |
| `dormantPoints()` 只取来当 ghosts（≤5 行标题，"有印象但想不起细节"） | `lib/inspect.js:15`、`lib/index.js:933` |
| 注入只认 `active`（merged/suppressed/dormant 都不进） | `lib/store.js:154` |
| 遗忘动作写 `50_log/eviction.log`（含数字） | `lib/forget.js:128` |
| 状态白名单：pending/active/demoted/dormant/merged/suppressed | `lib/toolkit.js:68` |

**结论**：我们缺的不是"遗忘"，缺的是**隔离层 + 复活 + 第二轮删除**这三件。

## 三、别人怎么做（可借鉴的五个机制）

| 机制 | 出处 | 对我们的意思 |
|---|---|---|
| **Second-chance / clock 页替换** | 操作系统（经典） | 被换出的页若再次被访问，给"第二次机会"——正是你说的"被提起就拉回来" |
| **Ghost list / ARC** | ZFS ARC、L2ARC | 淘汰时只留**键**，再次命中就提升回来——我们留整份文件（更贵，但可读） |
| **deferred destroy** | ZFS、Git `gc.pruneExpire`、Cassandra tombstone + grace、S3 delete marker | "删除"是两段的：先标记/隔离，过一阵才真的清掉 |
| **Ebbinghaus + 回忆强化** | [MemoryBank](https://github.com/FKGSOFTWARE/MemoryBank) | 每次回忆都会重置/加强记忆强度——我们的复活加权就是它 |
| **检索三要素：近因 + 重要性 + 相关性** | [generative_agents](https://github.com/joonspk-research/generative_agents) | 被检索到 = 近因刷新；我们的 `inj10` 已经在记"最近注入" |
| 遗忘治理 / 分层记忆 | [peterpoal134/memory-brain](https://github.com/peterpoal134/memory-brain)、[vvxer/silicon-retention](https://github.com/vvxer/silicon-retention) | 中文生态里已经有人把"遗忘"当治理问题，不是 bug |
| 图上的选择性遗忘 | [Selective Forgetting (arXiv 2608.28978)](https://browse-export.arxiv.org/pdf/2608.28978) | 遗忘按"关系结构"而不是单条 —— 我们做不到（无图），但提醒：**同簇一起沉**比单条沉更像人 |

## 四、设计 v1（两层 + 复活）

```
30_points/            active / demoted     ← 正常注入
    │  ① 第一轮（快）：R<0.55 · salience≤2 · 45 天 · 没被复述
    ▼
31_dormant/           遗忘层（物理隔离）    ← 只出现在 ghosts（≤5 行），不进正文
    │  ② 被提起：检索命中 → 拉回 30_points，S×1.6，resurrections+1
    │  ③ 第二轮（正常 FSRS 参数）：R<0.2 或 层内 ≥180 天 → 删点文件
    ▼
（删掉的是点，档案 10_archive 一个字不动）
```

### 参数（先按这组，可调）

| 项 | 值 | 含义 |
|---|---|---|
| `dormantR` | 0.55 | 第一轮的 R 阈值 |
| `dormantDays` | 45 | 第一轮的最短年龄 |
| `dormantRHard` / `dormantDaysHard` | 0.4 / 120 | 哪怕 salience=3，到这个程度也进层 |
| `resurrectWeight` | 0.75 | dormant 点在检索里的分数权重（比活跃点难命中，但能命中） |
| `resurrectBoost` | 1.6 | 复活时 S 的倍率 |
| `maxResurrections` | 3 | 复活 3 次后自动 `pin: soft`，**不再进遗忘层** |
| `cooldownDays` | 30 | 复活后 30 天内不得再进层 |
| `deleteR` | 0.2 | 第二轮的 R 阈值 |
| `deleteDays` | 180 | 层内最长滞留 |
| `deleteBatchMax` | 10 | 一次最多删几条（防跑飞） |

### 永不进层的（硬排除）

`pin: hard` · `type: boundary|promise` · `key: true` · 最近 30 天被注入过（查 `20_state/inj10.json`）· `resurrections ≥ 3`

### 四档阶梯（注意别和现有的 demoted 混了）

```
active      正常注入（全文/摘要/索引行看 salience）
  ↓ 降级：R<0.6 且 salience≤3 且 90 天
demoted     还在 30_points，但只按"摘要级"出现
  ↓ 第一轮（快）：R<0.55 且 salience≤2 且 45 天
dormant     移进 31_dormant/，只出现在 ghosts，不进正文
  ↓ 第二轮（正常参数）：R<0.2 或 层内≥180 天
purged      点文件删除，eviction.log 留墓碑，档案不动
```

**迁移**：库里现在的 `dormant` 状态点还在 `30_points/` 里（旧语义）。第一次跑新逻辑时把它们**移进 31_dormant/**（一次性，记一行 migrated 日志），否则会出现"同一状态两个位置"。

### 三处关键决定

1. **删点 ≠ 删记忆**：点文件没了，`10_archive` 里原文还在，`memory recall` 能找回。这是敢删的前提。
2. **第一层是目录，不是状态**：`31_dormant/` 让"隔离"看得见，`pack` 也会带上（换机器还能带走）。
3. **复活要真的有用**：复活后 `S×1.6` + 30 天冷却；3 次之后自动 `pin: soft`——反复被想起的东西，不该再判"该忘"。

## 五、清单（确认后按这个做）

### A. 目录与迁移（1 天）· ✅ v0.29.0 已做

- [ ] `lib/scaffold.js`：`DIRS` 加 `31_dormant`
- [ ] `lib/forget.js`：`planForget` 加 `dormant` 动作（第一轮条件）
- [ ] `lib/forget.js`：`applyForget` 执行 `renameSync(30_points/x → 31_dormant/x)`，front matter 追加 `dormant_at` / `dormant_reason` / `resurrections`
- [ ] `lib/pack.js`：`PACK_INCLUDE` 加 `31_dormant`
- [ ] `lib/reset.js`：fixture 清理包含 `31_dormant`
- [ ] `lib/toolkit.js`：`STATUSES` 已有 `dormant`；`scanPointFiles(dir, '31_dormant')` 已支持（第二个参数就是子目录，已核实）
- [ ] **一次性迁移**：把 `30_points/` 里状态为 `dormant` 的旧点移进 `31_dormant/`，记一行 `migrated`（否则同一状态两个位置）

### B. 检索与复活（1 天）· ✅ v0.29.0 已做

- [ ] `lib/store.js`：`points()` 只读 `30_points`（不变）；新增 `dormant()` 读 `31_dormant`
- [ ] `lib/retrieve.js`：`rankHybrid` 加 `weight` 参数乘 `resurrectWeight`（dormant 专用）
- [ ] `lib/index.js`：检索时**先活跃后 dormant**；命中 dormant → `revivePoint()`（移回 + S×1.6 + 计数 + 冷却）
- [ ] `lib/forget.js`：`isProtected` / 入层判断读 `resurrections`、`inj10`
- [ ] `50_log/revival.log`：一条一行（id / 分数 / 第几次 / S 前后）

### C. 第二轮删除（半天）· ✅ v0.30.0 已做（删点 + 墓碑 + 索引；残片 ≤12 字；一次 ≤10 条）

- [ ] `lib/forget.js`：`planForget` 对 `31_dormant/` 里的点算 `purge`（R<0.2 或 层内≥180d）
- [ ] `applyForget`：`unlinkSync` + `eviction.log` 墓碑（含 S/R/年龄/复活次数）
- [ ] 批量上限 `deleteBatchMax`；`--dry` 先看

### D. 审计与统计（半天）

- [ ] `audit` 新增 `dormant_layer`（非阻塞）：层内数量、最老、可删数
- [ ] `audit`：`pin: hard` 出现在 `31_dormant/` → **阻塞**（这是错，不是风格）
- [ ] `stats`：层内数量、本层复活率、已删除数
- [ ] `memory dormant list` / `memory dormant revive <id>`（手动试一次）

### E. 测试（1 天）

- [ ] 第一轮：条件命中 → 文件真的移走、状态变 dormant、日志有数
- [ ] 硬排除：pin hard / boundary / 30 天内用过 → 不进层
- [ ] 复活：命中 → 移回、S×1.6、`resurrections+1`、冷却生效
- [ ] 复活上限：3 次后自动 `pin: soft` 且不再进层
- [ ] 第二轮：R<0.2 → 文件删除、墓碑有数、**档案不变**
- [ ] 批量上限：一次最多 10 条
- [ ] `pack` 往返：打包含 `31_dormant/`，解包后能复活

### F. 文档（半天）

- [ ] 契约：§11 #10 扩写（"遗忘两轮：进层留痕 / 删除留墓碑"）；§5 数据模型加 `31_dormant/`
- [ ] 技能：告诉她"想不起来的事在遗忘层，被你再提起会回来"
- [ ] `MEMORY.md`（库里说明）：新增"遗忘层"一段
- [ ] CHANGELOG + BACKLOG（这条从 backlog 移到已做）

**进度**：A+B 在 v0.29.0、C 在 v0.30.0 落地；D/E/F 大部分已随 A/B/C 完成。

## 六、风险与护栏

| 风险 | 护栏 |
|---|---|
| 删错了找不回 | 删点不删档案；`eviction.log` 留数字；`--dry` 可预演；一次 ≤10 条 |
| 复活循环（反复进出） | 3 次后自动 `pin: soft`；复活后 30 天冷却 |
| 第一轮太狠（刚一个月就沉） | 45 天 + R<0.55 双条件；`salience ≥ 3` 要 120 天才沉 |
| 索引双目录把注入搞脏 | dormant **不进正文**，只进 ghosts；`store.points()` 保持只读 `30_points` |
| 金标被影响 | 金标 fixture 都在 30 天内，不会进层；CI 会红，红就调参数 |
| 层内文件越堆越多 | 第二轮 180 天兜底；`audit` 报"可删数" |

## 七、要你拍板的四件事

1. **第一层里她还能"想起标题"吗？** 现在 ghosts 会给 ≤5 行标题（"有印象但想不起细节"）。
   保留 → 体验更好，但等于遗忘层还有一点回声；去掉 → 更彻底的遗忘，但"她记得有这件事"就没了。
2. **删除时留不留残片（scars）？** 现在方案是"留墓碑数字"。留半句残片（≤12 字）是另一件事，正好接上之前 backlog 的 `scars`。
3. **复活上限 3 次够不够？** 也可以设成"每次复活 +1 次上限"（越常被想起越难忘）。
4. **第一轮 45 天 / R<0.55 快不快？** 这是主观的：你希望"一个月没提的事"就沉下去，还是"三个月"？

---

**我的建议**：先做 A+B+C+D+E+F 里的 A/B/C，D/E 跟着，F 最后；跑一个月真实数据再看参数。
**但**：库里现在 0 条点，这一层做出来**没有任何东西会进去**——所以要么等有 50 条点再做，要么现在做、用 fixture 验。

## 从「遗忘补丁」（孔月）借的三条（v0.29.1 已做）

| # | 抄了什么 | 我们的问题 | 落地 |
|---|---|---|---|
| 1 | 容量上限 maxLines=200 | 我们只有索引 700 tok 的隐式上限，超了只降级不淘汰 | MAX_ACTIVE=200，超了按最低 R 下沉到 31_dormant/ |
| 2 | (已取代) 优先忘 | \orget.js\ 根本没读 \invalid_at\ | \invalid_at\ 满 7 天直接进层 |
| 3 | \--recall\ 两段式 | 只有 \evive <id>\，没法按关键词找 | \memory dormant find <kw> [--apply]\ |

**不抄**：行式 \memory.md\、\R<0.1\ 才忘（event 7 个月）、内容 hash 当身份。
