# QQ 通道接入契约（v0.59.0）

> 2026-11-05。对象：`fish-memory-plugin-v0.59.0.zip`。
> 这份文档是给**通道侧**（`dsh-qq-plugin-group-expand` 或任何别的客户端）看的：
> 你只要做两件事——**问一句"这条消息属于谁"，调 `/context` 时把答案带上**。
> 记忆库这边已经把隔离、闸门、权限都准备好了；**通道不传 scope，就永远是主人私聊**。

---

## 0. 一句话

```
GET /scope?channelType=group&groupId=123&senderId=u1&masterIds=u1&homeGroups=123
→ { "scope": "group:123", "role": "member", "readOnly": true, "mayWriteCore": false, ... }

GET /context?q=...&session=...&scope=group:123
→ { "text": "<!-- 核心层 -->...", "mode": "daily", "tokens": 447, "scope": "group:123" }
```

**记住两条就够：`/scope` 问归属，`/context` 带上它。**

---

## 1. 为什么要有 scope（不给行不行）

不给也能跑，**但所有记忆会混在"主人私聊"这一个作用域里**：

| 不给 scope 的后果 | 具体会怎样 |
|---|---|
| 群友的话进主人画像 | 群里有人说"我最怕被丢下" → 过闸后进 `00_core/user.md` |
| 情绪基线被刷屏带偏 | 群里刷 200 条 → `emotion.user` 按"他的话"结算 |
| 「别再提」跨群广播 | 群 A 说好的事，群 B 的新会话照样读到 |
| 别名污染 | `mineAliases` 数的是"消息"不是"人"，群友互刷能产出假别名 |

这些都不是"可能"，是**结构决定**：库把世界建模成"我和他两个人"。

---

## 2. 三个接口

### 2.1 `GET /scope` —— 这条消息属于谁

| 参数 | 说明 | 必填 |
|---|---|---|
| `channelType` | `private` / `group` | ✅ |
| `groupId` | 群号（官方 `group_openid` / OneBot `group_id` 都行） | 群聊必填 |
| `senderId` | 发送者 id（**不要传昵称**） | ✅ |
| `masterIds` | 主人 id 白名单，逗号分隔 | 建议 |
| `homeGroups` | 主人所在群白名单，逗号分隔 | 建议 |
| `memberRole` | 官方通道的 `member_role`（`owner`/`admin`/`member`） | 可选 |

返回：

```json
{
  "scope": "group:123",
  "role": "member",
  "readOnly": true,
  "reason": "群 + 主人（仍只写 pending）",
  "mayWriteCore": false,
  "writeTarget": "40_pending/"
}
```

三条不可谈判：

1. **`mayWriteCore` 永远是 `false`**——任何人、任何渠道、任何角色。核心层只走人过闸。
2. `role` 在群里**永远不是 `master`**，哪怕 id 在白名单里（主人自己的群也一样）。
3. **判定只认不可改的 id**，绝不认昵称：官方昵称可改，OneBot 群名片谁都能设。

### 2.2 `GET /context` —— 取有界上下文

在原有参数（`session` / `q` / `mode`）之外加一个 `scope`：

- **不传** = `dm:master`（历史行为不变，老客户端不用改）；
- 传了但**写法不对** = **HTTP 400**，并说明正确写法。

> 为什么必须 400 而不是"猜一个"：scope 是隔离边界。
> `group:`、`group`、`Group:1` 这种拼错如果被静默当成私聊，**会让人以为隔离生效了**——
> 那比没隔离更糟。

合法写法（`validateScope` 的唯一口径）：

```
global
dm:master
dm:<id>          id 只允许 [A-Za-z0-9_-]{1,64}
group:<id>       同上
```

### 2.3 `POST /outcome` —— 学习结果（不变）

---

## 3. 你要传什么，从哪来

| 你手上有什么 | 传给谁 | 传什么 |
|---|---|---|
| 官方 QQ 机器人 `GROUP_AT_MESSAGE_CREATE` 事件 | `/scope` | `channelType=group`、`groupId=<group_openid>`、`senderId=<member_openid>`、`memberRole=<member_role>` |
| 官方 `C2C_MESSAGE_CREATE` 事件 | `/scope` | `channelType=private`、`senderId=<user_openid>` |
| OneBot（NapCat 等）`message.group` | `/scope` | `channelType=group`、`groupId=<group_id>`、`senderId=<user_id>` |
| 你自己的配置 | `/scope` | `masterIds`、`homeGroups` |

**注意**：官方通道的 `group_openid` / `member_openid` 与 OneBot 的 `group_id` / `user_id` **不是同一套 id**。
两种通道混用同一个库时，主人白名单要各配各的，否则 `/scope` 判出来是陌生人（这是安全的失败方向，不是 bug）。

---

## 4. 写入路径：现在**没有**，这是有意的

`serve.mjs` 至今**没有 `/ingest`**。原因写在代码注释里：

> 不做：消息写入（等 QQ 适配器；写入路径要带 seq，不能随便开）。

`seq` 是档案的幂等键（主机重投时靠它去重）。开一个 HTTP 写入接口，等于把
"谁都能往真相层追加"这件事暴露成网络面——**在 scope + seq + 鉴权三件事想清楚之前，不加。**

**所以现在能做的接入是"只读接入"**：她能在群里**记得**（检索），但群里的话**不会自动进库**。

要真正让群聊留下记忆，需要另外两件事（都还没做）：

1. 通道把消息带 `seq` + `scope` 推给插件（走宿主事件，不走 HTTP）；
2. 写入目标固定为 `40_pending/`，等主人过闸。

---

## 5. 群作用域的三条硬限制（已落库）

| 限制 | 为什么 |
|---|---|
| 不能 `pin: hard` | 群里说的话不该"永不遗忘" |
| 不能 `origin: chosen` | "她挑的"是主人侧才有的分量 |
| `salience ≤ 3` | 群里的事不该压过他的事 |

写在 `toolkit.js` 的 `validatePoint` 里，`scope` 为 `group:*` 才触发；私聊不受影响；
历史点（没有 `scope`）按 `global` 处理，**不需要迁移**。

---

## 6. 自测清单（通道侧照做）

```bash
# ① 归属判对了
curl "http://127.0.0.1:PORT/scope?channelType=group&groupId=123&senderId=u1&masterIds=u1&homeGroups=123"
# 期望：scope=group:123, readOnly=true, mayWriteCore=false

# ② 陌生人进群 → 也是 group:123（同群共享），但只读
curl "http://127.0.0.1:PORT/scope?channelType=group&groupId=123&senderId=u9&masterIds=u1&homeGroups=123"

# ③ 私聊陌生人 → 独立作用域
curl "http://127.0.0.1:PORT/scope?channelType=private&senderId=u9&masterIds=u1"
# 期望：scope=dm:u9

# ④ 拼错 scope 必须 400
curl -i "http://127.0.0.1:PORT/context?q=x&scope=group:"
# 期望：HTTP 400

# ⑤ 不带 scope 时行为不变
curl "http://127.0.0.1:PORT/context?q=在吗"
# 期望：scope=dm:master
```

本地不开服务也能核对：

```bash
memory scope --channel group --group 123 --sender u1 --masters u1 --homes 123
memory scope --check group:123
```

---

## 7. 边界（这一节请一并转给通道作者）

1. **本插件不认昵称**。传昵称当 id 会让隔离失效。
2. **不传 scope ≠ 隔离**，是"全归主人私聊"——看起来能跑，实际在污染主人画像。
3. **`/context` 不是聊天接口**，它只给有界上下文；发不发、发什么由通道决定。
4. **群里不许写核心层**是硬约束，不是建议：`mayWriteCore` 恒为 `false`。
5. 跨设备/多库不在此契约内（见 `memory merge-check`）。

---

## 8. 一句话收尾

**接入的正确顺序不是"先连上再想隔离"，而是"先问归属，再取上下文"。**

前面那些版本（v0.54–v0.58）修的是"进模型前那道闸"和"这条记忆属于谁"；
这一版把闸门做成**可以隔着 HTTP 问的**——通道只要不猜、不传昵称、不静默兜底，
群里就不会有一个"听起来像你"的陌生人。
