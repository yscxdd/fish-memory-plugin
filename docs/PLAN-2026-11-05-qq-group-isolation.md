# 接入 QQ、进群聊：现状、会怎么坏、怎么隔离

> 2026-11-05。对象：`fish-memory-plugin-v0.57.0.zip`（工作副本同为 0.57.0，`npm test` 691/691 全绿）。
> 这份文档回答四个问题：**有没有 QQ 接入 / 有没有群聊 / 主人消息与群消息分不分开 / 非 @ 的消息隔不隔离**，然后给一套能落地的隔离设计。
> 三条红线沿用旧文档：零依赖 / 真相层只走闸门 / 进模型的每一块都过 `sanitizeForPrompt`。

---

## 0. 三句话结论

1. **没有 QQ 接入。** `scripts/serve.mjs` 只提供四个只读接口（`/health` `/status` `/context` `/outcome`），代码注释写着"这个进程只是给别的客户端（QQ/桌面/CLI）一个稳定入口"，紧接着一句 **"不做：消息写入（等 QQ 适配器；写入路径要带 seq，不能随便开）"**（`serve.mjs:9,16`）。适配器还没写。
2. **没有群聊，也没有主人/群消息分离。** 真相层是**单库单关系**：`resolveMemoryDir()` 只按目录分（`index.js:105-109`），`relation.md` 是单数（`scaffold.js:82-89`），情绪只取 `emotion.user` 并渲染成"他那时"（`render.js:210-216`），会话尾巴只存 `{role, text, ts}`（`store.js:548`）。**全仓没有 `sender` / `nickname` / `user_id` / `group_id` 任何一个字段**（grep 过，只命中版权头）。
3. **"@ 隔离"在官方通道是平台替你做的，插件侧没有第二道闸；换到 OneBot 通道就全靠自己。** 官方机器人只推送 `GROUP_AT_MESSAGE_CREATE`，非 @ 的群消息**根本收不到**；OneBot（NapCat 等）能收到全部群消息，需要自己过滤。

旧文档里其实已经写死了这个判断，两处：

- `docs/REFERENCE-zh.md:674`：「会话 | 多会话 key 隔离 | **单库单关系** | 我们跑的是私聊，不是群聊」
- `docs/PLAN-2026-11-04-gap-closure.md:171`：「群聊 / 多用户隔离 | `resolveMemoryDir` 是单库单关系，**做群版要重做真相层** | 不做」

所以这个问题的诚实答案是：**现在接不进去；而且不是"加个适配器"就完事。**

---

## 1. 现在到底有什么（逐行）

| 能力 | 位置 | 现状 |
|---|---|---|
| 对外接口 | `scripts/serve.mjs:82-96` | `GET /health` `/status` `/context?session=&q=&mode=`、`POST /outcome`；**只读**，`listen(port,'127.0.0.1')`（`:116`），无鉴权（本地可接受） |
| 记忆根目录 | `lib/index.js:105-109` | `sessionCwd \|\| serviceCwd \|\| cwd` + `fish-memory`；`explicit` 可覆盖，**没有按用户/群分叉** |
| 会话模型 | `lib/store.js:544-552` | `tail.push({ role, text, ts })`，最多 10 条；`role` 只有 `user` / `assistant` |
| 关系 | `lib/scaffold.js:82-89` | `relation.md` 单份：关系阶段 / 梗 / 约定——**一对一关系** |
| 情绪 | `lib/emotion.js` + `render.js:216` | 状态机落盘，渲染成"他那时：…"；`emotion.self` 明确不进注入 |
| 说话人 | —— | **不存在**。档案只分 `user/message` 与 `assistant/message`（`archive.js:29`） |
| 记忆点的来源 | `toolkit.js:400` + `:387-398` | `source` 必填（v0.55.0 起）；`preference`/`boundary` 还必须有原话——这两道只证明"这话被说过"，不证明**谁**说的 |
| 来源类型显形 | `render.js:229-231` | `OMARK = { chosen:'[挑]', insight:'[想]', observed:'[察]' }`，**`told` 默认不标** |

一句话：**它把"世界"建模成"我和他两个人"，没有第三个人这个概念。**

---

## 2. 为什么"接个适配器"不够

接适配器只解决"消息怎么进来"。进来之后，下面七个地方都**默认只有一个他**，每一处都会在群里出错：

| 模块 | 单人假设 | 群里会怎样 |
|---|---|---|
| `00_core/user.md` / `relation.md` | 一份画像、一段关系 | 陌生人一句"我喜欢海"被写进**主人的画像** |
| `emotion.user` | "他的话"是唯一观测源 | 群里刷屏决定她的情绪基线，落盘后按小时懒结算 |
| `touchSession` tail | 只有"你/她"两种角色 | 多人混在一条尾巴里，她分不清谁接的谁 |
| `alias.js:126` `mineAliases` | 同一条消息共现 ≥3 条**不同**消息 = 这个别名成立 | 两个群友互刷梗，**自动产出假别名**；一旦 `accept` 就写进点文件，检索永久漂移 |
| `presence.js:22` 回来第一句 | 离开 6 小时再回来的是**同一个人** | A 走了 B 来，她对 B 说"上次你说到哪" |
| `questions.js` 放不下 | 一串"她惦记的事" | 谁问的都进同一个队列，交接包里混着陌生人 |
| `handoff.js` 别再提 | 关系状态只属于一段关系 | "别再提那句算了"被广播到另一个群（H7 的跨人版本） |

还有一个隐性成本：**`source` 是 session 内的 `msg_id`**（`scaffold.js:96`）。跨会话、跨群的 msg_id 各成体系，一旦混库，"这条记忆是哪句话写进来的"就再也追不回去——而这正是 v0.53 之后你准备拿去当卖点的"可溯源"。

---

## 3. 接进去会怎么坏（四个场景）

1. **画像被改写。** 群里任何人说一句"我最怕被丢下"，只要她判断"值得记"，就会进 `40_pending/`，过闸后成为 `user.md` 或点。她会开始**用陌生人的偏好对待主人**。
2. **别名污染不可逆。** `mineAliases` 靠共现统计（`alias.js:20-24`：同一条消息共现 + ≥3 条不同消息），它数的是"消息"不是"人"。群里 20 个人聊一晚，能产出几十条候选别名；`accept` 是把别名**写进点文件正文**的，写进去就得手工回滚。
3. **"别再提"跨人广播。** `handoff.js` 的 `doNotMention`（`:48,76`）是关系级的，不是会话级的；单库共享 → 群 A 里说好的事，群 B 的新会话照样读到。
4. **记忆投毒面直接打开。** OWASP ASI06 讲的就是这条：**记忆写入是特权操作**。写入侧现在有两道：`source` 必填（`toolkit.js:400`）、`preference`/`boundary` 必须有原话（`toolkit.js:387-398`，v0.55.0 落地的 N2）。这两道都只证明"这句话确实被说过"，**不证明"是谁说的"**。

   更麻烦的是 N3 也帮不上：`origin` 显形（`render.js:229-231`）只给 `chosen`/`insight`/`observed` 打 `[挑]` `[想]` `[察]`，**`told` 是默认不标的**（标了全是噪音）。于是在群里，一个陌生人说的话和一个主人说的话，**在注入块里长得一模一样**——她的判断依据只剩"这句话来自某个被记下来的人"，而那个"谁"已经被抹平了。

---

## 4. 两条通道，隔离责任完全不同

这是全篇最要紧的一张表。**"非 @ 消息隔离"在两条通道上不是同一个问题。**

| 维度 | 官方 QQ 机器人 API v2 | OneBot v11（NapCat / LLOneBot / Lagrange） |
|---|---|---|
| 群消息可见性 | **只有 @ 机器人的消息**（`GROUP_AT_MESSAGE_CREATE`）；非 @ 需平台侧"群消息全量权限"，一般拿不到 | **全部群消息**，包括没 @ 的 |
| @ 前缀 | `content` 已由平台剥离 | 原始 `at` 消息段，需自己解析 |
| 发送者身份 | `author.member_openid`（群成员 OpenID）+ `username` + `member_role`（`member`/`admin`/`owner`） | `sender.user_id`（真实 QQ）+ `nickname` + `card` + `role`（`owner`/`admin`/`member`） |
| 群标识 | `group_openid`（字符串，**拿不到群号/群名**） | `group_id`（真实群号） |
| 其它 @ 的人 | `mentions[]`，**不含机器人自己** | 完整 `at` 段 |
| 回复约束 | 被动回复要带 `msg_id` + 递增 `msg_seq`，5 分钟窗口、同一消息最多 5 次；超时走主动消息（有配额） | 直接发，无窗口 |
| 消息格式 | 纯文本 + 媒体，**无 CQ 码** | CQ 码富文本，约 4000 字符 |
| 群列表 / 昵称查询 | **没有接口**（只能记录"曾被 @ 过的群"） | 有 |
| 合规 | 官方开放平台，需 AppID/AppSecret，审核 | 自建无头客户端，**等于是你的个人号在跑**，有封号风险 |

结论：

- **走官方通道，"非 @ 隔离"由平台送给你**——收不到就是收不到。但代价是：拿不到群名、拿不到非 @ 上下文，只能靠"被 @ 后的连续对话窗口"接话。
- **走 OneBot 通道，"非 @ 隔离"完全是你自己的责任**——每一条群消息都会到，包括 200 个人在刷屏。这时候不隔离不是"可能串"，是"必然串"。

---

## 5. 三种隔离设计

### A. 目录级隔离（最小改动，但要接受人格分裂）

在 `resolveMemoryDir()`（`index.js:105`）上分叉：`fish-memory/`（私聊）、`fish-memory/groups/<gid>/`（每个群一份库）。

- **优点**：一处改动；零污染；群里怎么闹都碰不到主库；`relation.md` 天然是"这个群和她的关系"。
- **缺点**：同一个鱼在不同群是**不同的人**。群里的她不知道主人是谁，也不知道家里的梗——这不是"隔离消息"，是"复制人格"。而且 `alias` / 金标 / 情绪基线全部各算各的，维护成本乘以群数。
- **适用**：只想先让群聊能跑、且明确"群里的是另一个她"。

### B. 单库多作用域（推荐骨架）

真相层不改结构，只给点加一个 `scope`：

```
global            全局层（soul / rules 锚点，永不按 scope 分）
dm:master         主人私聊
group:<gid>       某个群（群内共享）
group:<gid>:<uid> 群里某个人（可选，只给"他"用）
```

检索时按 `scope` 过滤（`scope === 当前` 或 `global`），注入时也只拼当前 scope 的块。

- **优点**：改动集中在一处（检索前 filter）；主人库和群库共享同一套锚点与规则，她还是同一条鱼；一个群的记忆不会漏到另一个群。
- **缺点**：真相层多一个字段，`validatePoint` 要加约束；检索多一层过滤，得防"filter 写错 → 等于没隔"（必须有测试）。
- **适用**：想保住"同一条鱼"，同时群里不污染。

### C. 双库 + 准入（最稳）

`fish-memory/` 是主库（主人侧，全量）；`fish-memory/groups/<gid>/` 是**只读投影**，群里的写入一律进 `40_pending/`，且**永不写 `00_core/`**，主人审过才可能进主库。

- **优点**：群消息对她的人格**没有任何写入权**；最坏情况是"群里记了条垃圾"，不是"她变了"。
- **缺点**：群里"她记住你"的体验很弱（要等审）；实现量最大。

### 建议

**B 做骨架，C 的准入做规则**：作用域在检索层分，写入侧统一"群里只能进 pending、永不碰 `00_core`"。这两条合起来，既不用复制人格，也不会被群友改写成另一个人。

---

## 6. 主人 / 群消息分离：判定顺序

顺序不能颠倒，**先渠道、再身份、最后权限**：

1. **渠道**：`private`（官方 `C2C_MESSAGE_CREATE`）/ `group`（`GROUP_AT_MESSAGE_CREATE`）。渠道决定 `scope` 前缀。
2. **身份**：主人只能靠**不可改的 id** 判定——`member_openid` 在白名单里（配置 `masterOpenids`），或 `member_role === 'owner'` 且群在 `homeGroups` 白名单里。**绝不用昵称判**：官方通道昵称可改，OneBot 的 `card` 谁都能设——AstrBot 的 `astrbot_plugin_ai_memory` 就是被这事逼出了"冒充检测"（比对真实 QQ 与记忆里记录的 QQ）。
3. **权限**：

| 角色 | 能读 | 能写 | 能改 core |
|---|---|---|---|
| `master` | 全部 scope | `30_points/`（经闸门）、`questions`、`handoff` | 是（且仍受 `CORE_DRIFT_LIMIT` 约束） |
| `member`（群友） | 仅 `group:<gid>` + `global` | 只能进 `40_pending/`，且 `scope=group:<gid>` | **否** |
| `stranger`（未 @ 或被过滤） | 不检索 | 不写 | 否 |

4. **主人的"同一人"跨渠道**：如果以后要接多个渠道，用 `identityLinks` 一类的映射把"QQ 的 openid / 桌面的 session"归一到同一个 `master`，否则主人在手机上说的话，桌面上的她不认。这一条别一开始就做，但 `scope` 的命名要预留位置（`dm:master` 而不是 `dm:<openid>`）。

---

## 7. 非 @ 消息的隔离：三道闸

| 闸 | 管什么 | 官方通道 | OneBot 通道 |
|---|---|---|---|
| **闸 1 平台** | 能不能看到 | 平台只推 @ 的消息 | **没有**，全量到 |
| **闸 2 窗口** | 看到之后要不要理 | 被 @ 后开 N 分钟连续窗口（现成的 DSH QQ 插件用 5 分钟），窗口内交给模型判断，不相关就输出 `[[NO_REPLY]]` | 同左，但要自己实现 |
| **闸 3 写入** | 理了之后能不能记住 | **默认不写**；只有 @ 且过准入才进 `40_pending/` | 同左，**这条是唯一必须自己做的** |

**闸 3 是最该抄的一条**：前两道闸都是"能不能看到"，只有第三道管"能不能记住"。群里聊得再热闹，只要写入侧卡死，记忆库就不会被污染。

顺带区分两个容易混的东西：`groupSpeakCooldownMs`（20s）/ `groupSpeakMaxPerHour`（20）这类是**防刷屏的频控**，不是隔离——它只限制她说话的次数，不限制她记住什么。

---

## 8. 最小落地（v0.58 草案）

前提：v0.55.0 已经把 N2（分类型证据）和 N3（`origin` 显形）做完了，所以**不需要重做证据链**，缺的只有"一条记忆属于谁"这个维度。四条改动都不动真相层结构：

### 8.1 `lib/scope.js`（新，约 80 行）

```js
// 纯函数，无 IO，可单测
export function resolveScope({ channelType, groupId, senderId, masterIds = [], homeGroups = [], memberRole }) {
  if (channelType === 'private') {
    return masterIds.includes(senderId)
      ? { scope: 'dm:master', role: 'master' }
      : { scope: `dm:${senderId}`, role: 'stranger' }   // 陌生私聊：只读，不写
  }
  const isMaster = masterIds.includes(senderId) && homeGroups.includes(groupId)
  return {
    scope: `group:${groupId}`,
    role: isMaster ? 'master' : 'member',
    readOnly: !isMaster,
  }
}
```

判定只认 id，不认昵称；`memberRole === 'owner'` 只作为 `homeGroups` 内的**附加**依据，不作为唯一依据。

### 8.2 检索层过滤（不碰真相层）

`store.indexPoints()` 之后加一道：

```js
points.filter((p) => (p.scope || 'global') === scope || p.scope === 'global')
```

`scope` 缺省按 `global` 读（历史点不用迁移）。**这一行必须有反向测试**：造两个 scope 各一条，断言 A 的检索结果里没有 B。

### 8.3 `validatePoint` 加群约束（`toolkit.js:308`）

- `scope` 以 `group:` 开头时：**禁止 `pin: hard`**（群里不能钉死一条进永久层）、**禁止 `origin: chosen`**（群友不能替她"挑"素材）。
- `scope` 以 `group:` 开头的点，`salience` 上限 3（群里的事不该压过主人的事）。

### 8.4 `serve.mjs` 加 scope 与受控写入

- `GET /context` 加 `scope` 参数（缺省 `dm:master`，保持向后兼容）。
- 新增 `POST /ingest`：**只接受写 `40_pending/`**，必须带 `msg_id` + `scope`，且 `scope` 以 `group:` 开头时强制 `status: draft`。不做 `30_points/` 的直写接口——那条路永远只走 `memory ingest` 闸门。

### 8.5 验收测试（6 条）

1. `resolveScope`：私聊 + 白名单 → `dm:master`；私聊 + 非白名单 → `stranger`；群 + 白名单 + homeGroups → `master`；群 + 非白名单 → `member`。
2. **跨 scope 不串**：`group:A` 一条、`group:B` 一条，检索 A 时 B 不出现在候选里。
3. 群点 `pin: hard` → `validatePoint` 报错。
4. 群点 `salience: 5` → 报错（上限 3）。
5. `POST /ingest` 带 `scope=group:G` 写入 → 落在 `40_pending/`，`30_points/` 不变。
6. `GET /context` 不传 `scope` → 与现在完全一致（防回归）。

---

## 9. 不做的 / 风险

1. **不接个人号协议**（OneBot 自建客户端）。技术上能拿到全量群消息，但等于用你的个人号跑机器人，封号与合规风险都在你身上。真要接，隔离设计按 §5B 做，别省。
2. **不在群里开"完全访问"。** 现成的 DSH QQ 插件把新会话默认设成 `read-only`，理由写得很好：**群里任何人都能触发 agent**。这条 friction 是有意的，别为了顺手关掉。
3. **不做"群里也记得所有人"。** 每个群友一份画像，存储会爆，而且没有意义——她的关系对象是主人，不是群。
4. **群记忆不进 `00_core/`，也不进 `global`**，除非显式配置。core 的改动受 `CORE_DRIFT_LIMIT`（20%）与锚点护栏约束，群里够不到这条线。
5. **官方通道拿不到昵称与群名**（只有 OpenID），所以管理界面只能显示 ID——这不是实现偷懒，是平台限制，要提前告诉用户。
6. **`serve.mjs` 无鉴权**。现在只监听 `127.0.0.1` 是安全的；一旦要给远程 QQ 网关调用，必须加 token，且不要绑 `0.0.0.0`。

---

## 10. 现成的路：先用别人的 QQ 通道 + 你的只读接口

如果只是想先跑起来看效果，**不用自己写 QQ 适配器**。DSH 生态已经有 `dsh-qq-plugin`（上游 `xcisxc29/dsh-qq-plugin`）和它的群聊分支 `dsh-qq-plugin-group-expand`（1.2.0），已经解决了：

- 官方通道扫码绑定、无需公网回调；
- 对话键 `accountId:group:groupId`（**已经是 per-group 了**）；
- 被 @ 后 5 分钟连续窗口、`[[NO_REPLY]]` 静默、群历史最近 8 条（内存，不持久化）；
- 新会话强制 `read-only`；
- 群被动回复复用最近一次 @ 的 `msg_id`（否则会被当主动消息发失败）。

**它没有长期记忆**——这正是 fish-memory 可以补的位置，而且补法最省：让适配器把 `scope` 一起传给 `GET /context`，记忆仍由你这边出。这样第一步不用碰真相层，先验证"群里她说话像不像"。

⚠️ 两个坑写在这里：它的群历史**只在内存**，DSH 重启就清零；它的群消息**默认不可见非 @**，别指望靠它补全上下文。

---

## 11. 对比源

**QQ 平台能力边界**

1. **QQ 机器人官方文档 · 群 @ 消息事件**：`GROUP_AT_MESSAGE_CREATE` 字段全表（`author.member_openid` / `username` / `member_role` / `mentions` 不含自身 / `msg_seq` 去重与 5 次上限）。https://bot.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
2. **QQ 机器人 · 通用数据结构与 intents**：`GROUP_AND_C2C_EVENT (1<<25)`；普通群消息 `GROUP_MESSAGE_CREATE` 需平台侧权限；频道 `MESSAGE_CREATE` 仅私域。https://bot.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html
3. **QQ 群能力限制实录**（第三方项目更新日志）：只能监听 @ 消息、拿不到昵称/群名、群里 @ 他人不可见、回复强制 @ 发送者。https://pd.qq.com/g/ir24a17s6a/post/B_9383af66762504001441152187137809450X60
4. **NapCat / OneBot v11 与官方 Bot API 对比**（`docs/zh-CN/reference/bot-integration-modes.md`）：群消息可见性、身份字段、长度、权限判定（`role=admin/owner` vs 白名单）逐条对照。https://github.com/jikekei/Server_Qchat/blob/main/docs/zh-CN/reference/bot-integration-modes.md
5. **OneBot v11 群消息事件结构**：`message_type: 'group'`、`group_id`、`sender.{user_id,nickname,card,role,title,level}`、`anonymous`。https://doc.napneko.icu/onebot/event
6. **QQ 连接方案总览**：NapCat / LLOneBot / Lagrange / Shamrock 的推荐度与"官方 API 仅 @ 消息、需申请"的取舍。https://github.com/JingHao-Leon/OFbot2/blob/main/docs/CONNECTIONS.md

**已经做过群聊的记忆插件（隔离怎么做的）**

7. **dsh-qq-plugin-group-expand**：per-group 对话键、5 分钟窗口、`[[NO_REPLY]]`、新会话 read-only、无长期记忆。本文 §10 的直接依据。https://dshpluginhub.ai/en/plugins/dsh-qq-plugin-group-expand
8. **AstrBot · UMOP 会话路由**：`{platform_id}:{message_type}:{session_id}` 作为隔离原语，per-session 配置。§5B 的 scope 命名参考。https://deepwiki.com/AstrBotDevs/AstrBot/10.4-session-management-and-custom-rules
9. **astrbot_plugin_ai_memory**：私聊/群聊记忆独立管理、**所有记忆自动打发送者昵称+ID 标签**、冒充检测（比对真实 QQ）。§6"不认昵称"的反面教材来源。http://git-hub.com/victical/astrbot_plugin_ai_memory
10. **astrbot_plugin_mnemosyne**：`use_session_filtering` 默认开、`use_participant_filtering` 按发言用户过滤以缓解"群聊串线"。https://patch-diff.githubusercontent.com/h4rm00n/astrbot_plugin_mnemosyne
11. **astrbot_plugin_infinite_memory**：群聊隔离——每个群独立记忆库 + 多用户画像。§5A 的现成实现。https://github.com/ThriEy/astrbot_plugin_infinite_memory
12. **Bitterbot 会话管理**：`dmScope` 四档（`main` / `per-peer` / `per-channel-peer` / `per-account-channel-peer`），并明确警告默认 `main` 会让 Alice 的上下文漏给 Bob；`identityLinks` 归一同一人。**§6 第 4 条的正面依据。** https://github.com/Sikha555/bitterbot-desktop/blob/main/docs/concepts/session.md
13. **Memoh**：多用户优先，`owner/admin/member` RBAC + 跨平台身份绑定 + 群里逐人记上下文。https://github.com/memohai/Memoh

**安全**

14. **OWASP ASI06 Memory & Context Poisoning**：写入是特权操作，要 provenance / 信任级 / TTL / 审计。§3-4 的依据。https://owasp.github.io/www-project-agent-memory-guard
15. **MINJA（arXiv:2503.03704）**：普通对话即可种记忆，之后被当作"她自己的经验"检索。群聊是这条路径的最佳入口。https://arxiv.org/abs/2503.03704

---

## 12. 一句话收尾

**现在接不进 QQ——不是因为没写适配器，是因为这个库的世界里只有两个人。**

`resolveMemoryDir` 一处、`relation.md` 一份、`emotion.user` 一位、`touchSession` 里没有说话人——七个模块都默认"只有一个他"。所以正确的顺序不是"先接 QQ 再想隔离"，而是**先把 `scope` 这一列加进去**（检索层过滤 + 群写只进 pending），再接通道。否则第一晚群里聊完，她的 `user.md` 就不是你认识的那份了。

至于"非 @ 的消息"，官方通道替你挡了第一道，但那只挡"能不能看到"；**真正决定她会不会被带偏的，是第三道闸：群里的事永远只能进 `40_pending/`，永远碰不到 `00_core/`。**
