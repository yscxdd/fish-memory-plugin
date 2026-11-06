# v0.66 修改单：四处砍偏 + 网盘备份

> 2026-11-06。对象：`fish-memory-plugin` v0.65.0（工作副本，门禁 769/769）。
> 前半是 v0.65「会话隔离四刀」的复审，后半是新增的**网盘备份**设计。
> 每一条都有位置、复现、修法、验收；复现数字全在**真实库**（190 条消息 / 3 个会话 / 967 KB）上跑出来的。
>
> 一句话：**四刀的位置对，三刀砍偏了，一刀没落地；备份这一块，缺的不是"传上去"，是"能验、能回、不把她的私房话裸奔"。**

---

## 0. 一页看完

| 编号 | 级别 | 问题 | 位置 | 代价 |
|---|---|---|---|---|
| E1 | P0 | 情绪闸拿"工作产出"判据判"他这句话算不算情绪事件"，误伤最该被听见的那类话 | `index.js:713` | 约 40 行 |
| E2 | P0 | 纸条只闸住"谁写"，没闸住"写进去的是谁的话" | `were.js:43` / `:149` | 约 20 行 |
| E3 | P0 | 交接包单向闸：任务窗会吃掉人格包，日常窗再也读不到 | `handoff.js:191` / `:196` | 3 行 |
| E5 | P0 | 跨会话闸对"一个人一个长会话"的用法是致命的（真实库 176/190 条在一个会话里） | `voice.js:134` / `alias.js:169` | 约 15 行 |
| E4 | P1 | S3 加了 `session` 过滤参数，23 个调用点 0 个传 | `toolkit.js:124` | 删或落地 |
| E6 | P1 | `looksLikeWork` 还是两份（`wakeup.js:81` 与 `textkind.js:16`） | 两处 | 删 10 行 |
| E7 | P2 | CHANGELOG 表格塌三处；规模数字陈旧（235/649 vs 实际 239/769） | `CHANGELOG.md:118,119,173,176` | 纯文档 |
| B1 | P0 | 备份是**目录树**（90 个文件），同步盘会边写边传；`MANIFEST` 还带绝对路径 | `pack.js:8,98` | 约 150 行 |
| B2 | P0 | 备份**全明文**：`00_core` 私房话 + `10_archive` 原始对话直接进第三方网盘 | 新增 | 约 90 行 |
| B3 | P0 | 没有恢复命令：`unpack` 只解目录，不验链、不拒绝坏包 | `pack.js:120` | 约 80 行 |
| B4 | P1 | 备份没验过 = 没备份（本地一份、远端一份都没人去读它） | 新增 | 约 60 行 |
| B5 | P2 | WebDAV 直传（可选，绕开手动同步） | 新增 | 约 80 行 |

顺序：E1/E2/E3/E5 + B1/B2/B3 全是"会出事"的，同一版清掉；E4/E6/B4 下一版；E7 随手；B5 看要不要。

---

## 1. 结论

**① 四刀砍在派生状态上，记忆点还是没主。**
纸条、交接包、情绪、口癖/别名都管住了，但点没有归属：工作会话里 `fish-remember` 的事，照样出现在私聊。所以那个三十秒实验（A 会话聊代码 → B 会话问"你记得我什么"）**现在仍然失败**。S4 不做的理由（库里 0 个点）成立，但代价是：等库开始填，第一件事就是把工作决定写进点，那时再加维度比现在贵。

**② 已经落地的三刀，有两刀把判据用错了对象。**
`looksLikeWork` 是为"**这条回复是不是工作产出**"设计的（长、英文多、带代码/技术词）。v0.65 把它搬去判两件不同的事：情绪（"他这句话算不算情绪事件"）和人格准入（"这句能不能当口癖"）。前者错得离谱，后者有争议。

**③ 备份这件事，插件已经做了一半，缺的那一半正好是最要紧的。**
每天自动打一份全量包到 `fish-memory-backups/`（`heal.js:125`，保留 7 份，实测 772 KB/份）。缺的是：**单文件、可加密、可验证、可恢复**。而这四件事，一件都不能靠"网盘客户端"代劳。

---

## 2. E1（P0）· 情绪闸：判据搬错了对象

### 2.1 现场

`index.js:713`：

```js
if (emoCfg.enabled && !looksLikeWork(text)) {   // text = 他这一句
  const host = lexiconValence(text)
  ...
}
```

`looksLikeWork`（`textkind.js:16`）的四条规则：长度 > 120；含代码块/反引号/`**`；ASCII 占比 > 15%；含技术词（文件/代码/测试/版本/配置/部署…）。

### 2.2 复现（真实句子）

| 句子 | 判定 |
|---|---|
| 我今天很难受 | pass |
| 刚被 leader 骂了一顿，心里堵得慌 | **BLOCK** |
| Java 又出问题了，烦 | **BLOCK** |
| 这个版本上线之后我整个人都空了 | **BLOCK** |
| 我爸住院了，我有点怕 | pass |
| 我今天特别开心，因为终于把那个 bug 修好了 | pass |

规律很荒谬：**带一个英文词就整句被挡**（`leader` 占 6/14 字符 > 0.15），带技术名词但说的是心情也被挡（`版本` 在黑名单里）；而 `> 120 字一律算工作`——恰好把最需要被听见的长倾诉整类排除。最后一行反过来证明它不是"情绪判据"：一句明显带情绪的话因为英文只有 3 个字符而放行。

### 2.3 真实库的量

```
他的消息 79 条 → 被判"工作" 39 条（49.4%）
她的消息 111 条 → 被判"工作" 100 条（90.0%）
```

也就是说这个 workspace 里**情绪半停摆**：她只在"纯中文、短、不带技术词"的那些轮次里步进。v0.65 的 CHANGELOG 把这个当成"你要内容闸"的代价接受了，但代价被低估了——被挡掉的不是"工作汇报"，是"夹着工作词的心里话"。

### 2.4 修法

情绪闸只问一件事：**这句话里有没有"我"和"自身状态词"**。

```js
// lib/textkind.js 新增（不是 looksLikeWork 的变体，是另一个判据）
const SELF = /(我|俺|咱)/
const FEEL = /(累|难受|烦|怕|慌|委屈|难受|开心|高兴|难过|想哭|睡不着|疼|空|没劲|不想动|孤独|寂寞|焦虑|生气|烦死)/
const JUDGE = /(不行|可以|挺好|没问题|对|错|建议|方案|这个版本)/  // 判断/评价不是情绪

export function hasFeel(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ')  // 代码块先剥
  if (!SELF.test(t)) return false
  if (!FEEL.test(t)) return false
  // "我觉得这个方案不行" 是判断，不是情绪；但它同时含 SELF，靠"情绪词优先"兜住：
  return true
}
```

闸门改成 `if (emoCfg.enabled && hasFeel(text))`。

**为什么不干脆把 `looksLikeWork` 调松**：它还要给 `voice.js`（口癖）和 `wakeup.js`（唤醒包取样）用，那两处要的恰恰是"严"。一个判据服务两个目标，必然两头都错——这就是 E6 要修的病根。

### 2.5 验收

- `刚被 leader 骂了一顿，心里堵得慌` → 情绪步进。
- `把 handoff.js 里的 kind 加上` → 不步进（无"我"，无情绪词）。
- `我今天特别开心，因为终于把那个 bug 修好了` → **步进**（v0.65 pass 是撞上的，这里是判据命中）。
- `我觉得这个方案不行` → 不步进（判断）。
- 真实库回放：被挡比例从 49.4% 降到 < 15%，`50_log/emotion-skip.log` 行数同步下降。
- 端到端：同一句话在 v0.65 下 `emotion.json` 的 `turns` 不变，新版 +1。

---

## 3. E2（P0）· 纸条只闸住了一半

### 3.1 现场

`were.js:149` 加的是**写侧会话闸**：

```js
if (mode === 'task') { ... return { written: false, reason: 'task-session' } }
```

但内容来自 `lastExchanges(dir)`（`were.js:43`），它读的是**全库**：

```js
export function lastExchanges(dir) {
  const { messages } = readArchive(dir)     // ← 全库，不分会话
```

### 3.2 复现

档案里只有工作会话的两条：

```
你把 handoff.js 里的 kind 加上
她：改完了，三处调用点都补上了
```

用一个日常会话去写纸条（`mode: 'daily'`）：

```
日常会话写纸条: {"written":true,"chars":132,"reason":"first"}
他最后说：「把 handoff.js 里的 kind 加上」
她说：「改完了，三处调用点都补上了」
```

纸条没被工作会话写，但**被日常会话写进了工作内容**。S1 的目的一半没达成。

### 3.3 修法

给档案记录加一个 `mode` 字段（写侧一行，`archive.js:96` 附近），取数时跳过 task 消息：

```js
// archive.js buildRecord
mode: stateOf(sessionId)?.mode === 'task' ? 'task' : 'daily',

// were.js lastExchanges
export function lastExchanges(dir, { skipTask = true } = {}) {
  const { messages } = readArchive(dir)
  const pool = skipTask ? messages.filter((m) => m.mode !== 'task') : messages
  ...
}
```

老消息没有 `mode` → 不过滤（fail-open），所以历史库和测试不会全灭。这条 `mode` 字段以后 S4/S6 也用得上（"这条消息当时是什么模式"），不是为纸条单独加的。

### 3.4 验收

- 同一份档案，日常会话写纸条 → 取到的是更早的日常消息，不是工作会话那两条。
- 全是工作会话时：纸条写"没有更早的日常对话"，**不写工作原话**。
- 老档案（无 `mode`）：行为与 v0.65 一致（断言不变）。

---

## 4. E3（P0）· 交接包是单向闸

### 4.1 现场

`handoff.js:191`：

```js
if ((h.kind || 'persona') === 'task' && mode !== 'task') return null
```

只拦"任务包不给日常窗"。人格包**谁的窗都给**，而读到就会在 `:196` 打上 `consumedBy`。

### 4.2 复现

```js
buildHandoff(dir, {id:'A', tail:[{role:'user',text:'我梦见那条河了'}]})
takeHandoff(dir,'B',{mode:'task'})   // → true
takeHandoff(dir,'C',{mode:'daily'})  // → false
```

工作窗压缩时顺手把"她还惦记着"吃掉了，等你回到日常窗，什么都没了。H7 想防的"被错误的人吃掉"，只防了一个方向。

### 4.3 修法

**任务窗读人格包：只读，不消费。**

```js
if (h.kind === 'task' && mode !== 'task') return null     // 任务包不给日常窗（保持）
const consume = !(mode === 'task' && (h.kind || 'persona') === 'persona')
if (consume) atomicWriteJson(...consumedBy...)
return sanitize...
```

任务窗也能看到"她还惦记着"（有用），但不会夺走日常窗那一份。

### 4.4 验收

- 任务窗读人格包 → 返回文本；随后日常窗再读 → **仍能读到**。
- 日常窗读人格包 → 消费；第二个日常窗读不到（H7 语义不变）。
- 任务包 → 只有任务窗读得到，且读后消费。

---

## 5. E5（P0）· 跨会话闸对"一个人一个长会话"是致命的

### 5.1 现场

`voice.js:132` 要求**≥2 个不同会话**，`alias.js:168` 要求**≥3 个**。

### 5.2 真实库的形状

```
会话数 3
  session-6b34f3cb…  176 条   ← 92.6% 全在这一个会话里
  session-b7ed1c9f…   12 条
  session-1aecef3c…    2 条
```

一个人一个多月只开一个长会话，是完全正常的用法。合成夹具对照（同一句话在单会话里出现 5 次）：

| | v0.64 | v0.65 |
|---|---|---|
| 单会话 · 口癖候选 | 1 | **0** |
| 两会话 · 别名候选 | 0 | 0（要 3 个） |
| 三会话 · 别名候选 | 2 | 2 |

也就是说 v0.48 的"别名救回难题组 1 题"和 v0.47 的口癖挖掘，在实际用法下全部停摆。**会话 ≠ 话题**：一个会话能聊一个月，里面既有工作也有生活。

### 5.3 修法

用"**会话数 OR 天数**"，任一条成立即可：

```js
// voice.js
if (anySession && v.sessions.size < 2 && v.days.size < 3) continue
// alias.js
if (anySession && v.sessions.size < 3 && v.days.size < 3) continue
```

「跨 3 天说过同一句」比「跨 2 个会话」更像习惯，而且对单人长会话友好。`days` 从 `m.ts.slice(0,10)` 取，零成本。

### 5.4 验收

- 单会话跨 3 天说 5 次 → 出候选。
- 单会话同一天说 5 次 → 不出（这才是"一次任务里刷三遍"）。
- 两会话同一句 → 口癖出候选、别名不出（阈值差异保留）。

---

## 6. E4（P1）· S3 这一刀没落地

`toolkit.js:124` 加了参数：

```js
export function readArchive(dir, { session = null, since = null } = {}) {
```

**23 个调用点，0 个传参**（`lib/` 与 `scripts/` 全扫，只有定义行匹配得到 `{`）。`since` 更是从头到尾没人用。

CHANGELOG 说"改成调用点漏了"，最后修的是测试里的调用点——所以测试绿了，生产没变。

**两个选择，别留着当装饰：**

- **A（推荐，现在）**：删掉 `since`，`session` 保留但在注释里写清"留给 S4 的记忆点层用，现在没有调用方"。
- **B（跟 S4 一起）**：真用起来——`voice/alias/cliche` 传"人格层的会话集合"。

留着一个没人拉的开关，比没有更糟：下次读代码的人会以为隔离已经做了。

---

## 7. E6（P1）· `looksLikeWork` 还是两份

`textkind.js:16` 和 `wakeup.js:81` 各有一份，内容逐字相同。只有 `index.js` / `voice.js` 引了 `textkind`；`wakeup.js` 自己定义自己用。

CHANGELOG 写着"同一判据两套标准"——这一半没修完。改 `textkind` 不会影响唤醒包的取样。

**修法**：`wakeup.js` 删掉本地实现，改 `import { looksLikeWork } from './textkind.js'`（`textkind` 零依赖，不会成环）。

**验收**：`grep -c "export function looksLikeWork" lib/*.js` = 1；一条测试钉住"改 textkind 的规则，wakeup 的取样跟着变"。

---

## 8. E7（P2）· 文档债（第二次同类事故）

`CHANGELOG.md` 的「一页看完」表格塌了：v0.64.0 / v0.65.0 的明细段被插进表格中间。

```
117  - 测试 753 → 758（…）                        ← 明细段的最后一行
118   **到期块含逾期** | 753 | v0.63.0 只显示…      ← 丢了行首 `| v0.63.1`
119  | v0.64.0 |                                   ← 只剩一个格子
...
173   **她终于知道"今天是哪天"** | 758 | …          ← 同上
174  | v0.65.0 | 会话隔离四刀… | 769 | …            ← 真正的行在这
```

外加两处陈旧数字：

| 位置 | 写的 | 实际 |
|---|---|---|
| `CHANGELOG.md:176` | 235 个文件 | **239** |
| `CHANGELOG.md:177` | 测试 97 → 649（+552） | **97 → 769（+672）** |
| `README.md:4` | tests-722 | **769** |

**根因**：明细段是"插在表格最后一行之前"生成的，而不是"表格之后"。修法是把三段明细整体挪到表格结束之后，并在 `test/docs.test.js` 加一条：**CHANGELOG 表格区的每一行必须以 `| v` 开头**（塌了必红）。

---

## 9. 网盘备份：先回答"怎么做"

### 9.1 三条路，先看代价

| 路线 | 落地方式 | 门槛 | 适合谁 |
|---|---|---|---|
| **A · 同步文件夹** | 插件产出**一个文件**，扔进网盘同步目录 | 零 API、零凭据、任何网盘都行 | **推荐**，也是本文档的设计目标 |
| B · WebDAV | 插件直接 PUT 到 `https://dav.jianguoyun.com/dav/` | 需应用密码；坚果云免费版**每月上传 1 GB、下载 3 GB**，单文件 ≤ 500 MB，请求过密会 429/403 | 不想装同步客户端的人 |
| C · 网盘官方 API | 百度 / 阿里开放平台 | 百度：个人认证可建 1 个应用，"个人使用"免审核但**限 10 人**，2026-06-03 后新建应用只能访问 `/apps/{appname}`；阿里云盘 2024-07 起三方应用需购权益包 | 不建议 |

**为什么推荐 A**：这个库整库 gzip 后 **201 KB**。一天一个文件，一个月 6 MB，坚果云免费额度用掉 0.6%。为了省"手动拖动一次"去接 OAuth、管 token 刷新、处理限流，风险收益完全不成比例——尤其是凭据最终会落到某个配置文件里，而这个插件的第一条设计约束是**不发网络请求**（README 第 4 行）。

### 9.2 但**不要**把 `backupDir` 直接指向同步盘

今天就能这么干（`FISH_MEMORY_BACKUP=<同步盘目录>`，`index.js:608` 会照做），但后果是：

1. **同步粒度是文件，不是事务**。`packMemory` 先拷进 `dest.tmp-<pid>/` 再 `rename`，可同步客户端看得见 `.tmp` 目录——于是 90 个文件"边出现边上传"，rename 之后目录改名，再传一遍。
2. **冲突副本**。你在写、它在读，网盘会产出 `messages (1).jsonl`。`merge-check`（`mergecheck.js:33`）存在本身就说明"档案分叉"是真实发生过的风险，而 hash 链一旦分叉，`memory erase` / 审计全都会喊。
3. **删 7 份的时候最危险**。`pruneBackups` 是逐个 `unlinkSync`，同步客户端会把"删除"也同步一遍——如果这时另一台设备在线，它会把删除当成"用户删了文件"。

结论：**同步盘只该看见"一个已经写完的文件"。**

---

## 10. B1（P0）· 单文件包（`memory backup export`）

### 10.1 格式

```
fish-memory-20261106.fmb          ← 单文件，一次 rename 落盘
├─ 12 字节魔数  "FMBACKUPv1\n"
├─ 头部（明文 JSON，一行）
│    {v:1, enc:"aes-256-gcm"|null, scrypt:{N,r,p}, salt, iv,
│     created_at, library:{points, sessions, days}, bytes, files}
└─ 载荷
     明文：tar.gz
     加密：AES-256-GCM( tar.gz )
```

头部**明文**是刻意的：不解密也能看到"这是哪天的、多大、多少个文件"——网盘里翻文件时不用先掏口令。

### 10.2 为什么是 tar 而不是自造 zip/JSON

- Node 没有内置 zip，但有 `zlib`。ustar 头 512 字节，写起来 50 行，**零依赖**。
- 用户拿 7-Zip 能直接打开，出事时不必依赖这个插件——这对"备份"是硬要求。
- 路径全是 ASCII（`00_core/soul.md`、`10_archive/messages/2026-11-01.jsonl`），不存在长路径/PAX 问题。

### 10.3 顺手修：`MANIFEST` 里的绝对路径

`pack.js:98` 写 `source: src`。你 11-05 那份备份里实测是：

```json
"source": "D:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\fish-memory"
```

这份文件是要出门的。改成 `source: basename(src)`，或干脆删掉这个字段（`unpackMemory` 没读它）。

### 10.4 CLI

```
memory backup export [--out <文件>] [--encrypt] [--key-file <路径>]
memory backup list   [--dir <同步盘目录>]
```

默认落点：`cfg.backupDir` 里放单文件？不——单文件要放到**同步盘**，而 `backupDir` 是本地每日包的落点。新增配置键 `offsiteDir`（同步盘目录），两个用途分开，别复用。

### 10.5 验收

- 导出 → 文件名符合 `fish-memory-YYYYMMDD.fmb`，体积 < 400 KB。
- 导出过程中同步盘目录里**只出现一个文件**（先写 `.partial` 再 rename；`ls` 断言无中间文件）。
- `MANIFEST.json` 里不含盘符或 `\\`。
- 连续导出两天，文件名不同、内容 sha256 不同。

---

## 11. B2（P0）· 加密

### 11.1 为什么默认要加密

备份里有：`00_core/soul.md`（她是谁）、`relation.md`（你们的关系）、`10_archive`（逐字对话）。`memory privacy`（`privacy.js`）管的是"会不会被 git 带出去"——**网盘是同一件事的另一条出口**，而现在没有任何东西管它。

### 11.2 参数

| 项 | 值 | 理由 |
|---|---|---|
| 算法 | AES-256-GCM | Node `crypto` 内置，带认证标签（改一个字节就解不开） |
| 派生 | scrypt(N=2^15, r=8, p=1, salt=16B) | 内存 ~32 MB，单机一次 0.1–0.3 s，够挡离线爆破 |
| IV | 12 B 随机 | 每次导出全新，**绝不复用** |
| 口令来源 | `--key-file` > `FISH_MEMORY_BACKUP_KEY_FILE` > `FISH_MEMORY_BACKUP_PASSPHRASE` | 都不给 → 交互式读一次，**不落盘** |

### 11.3 口令丢了就是丢了

这是"她"的备份，不是配置文件的备份。所以：

1. 首次 `--encrypt` 时打印 **24 字恢复码**（口令的 BIP39 风格编码）并要求输入一次确认；
2. 恢复码保存提示写进输出："存到密码管理器，别存进这个库"（存进库里等于把钥匙和锁放一个包）；
3. 导出头部写明 `enc`，`memory backup verify` 不解密也能告诉你是加密包。

**不做**：把密钥放进备份包、放进 `20_state/`、或"用设备指纹自动派生"（换机器 = 永久丢）。

### 11.4 验收

- 加密包用错误的 key 解 → 明确报"认证失败"，不是 "JSON 解析错误"。
- 包内任意一个字节被改 → 解密失败（GCM tag）。
- 明文包与加密包的文件名一致、头部 `enc` 不同。
- `--encrypt` 未给 key 时**不静默降级为明文**。

---

## 12. B3（P0）· 恢复（`memory restore`）

### 12.1 顺序（错一步就毁库）

```
1. 读头 → 判断 enc → 取 key（需要时）
2. 解密 → gunzip → untar 到 <临时目录>
3. 逐文件 sha256 与 MANIFEST 比对（不一致 = 整包拒绝，不部分恢复）
4. checkArchive(临时库)  ← 验 hash 链（integrity.js:127）
5. 目标目录必须不存在或为空（--force 才允许覆盖，且先备份到 .old-<pid>）
6. rename 换入（同一分区，原子）
7. 重建 20_index
```

第 4 步是关键：**哈希对得上 ≠ 链是连的**。`checkArchive` 会告诉你"第 3 天少了一条、seq 断了"，这是 `unpack`（`pack.js:120`）现在不做的事。

### 12.2 为什么不用 `unpack`

`unpackMemory` 只验文件哈希，不验链，也不管目标目录里有东西时"用户是不是选错了目录"。恢复是**破坏性操作**，标准要比导入严。

### 12.3 验收

- 删掉一条档案消息再打包 → restore 在链校验那步失败，目标目录**没被动过**。
- 目标目录非空且无 `--force` → 拒绝，且不写任何文件。
- 包被截断 → 在 untar 阶段报错，不留下半库。
- 恢复后 `memory verify` + `memory status` 全绿，`30_points` 索引已重建。

---

## 13. B4（P1）· 验过才算备份

三处校验，缺一处就等于没备份：

| 时机 | 命令 | 查什么 |
|---|---|---|
| 导出后（本地） | `memory backup verify <file>` | 能解开、能 untar、哈希全对、链完整（干跑，不落地） |
| 上传后（远端） | `memory backup verify <同步盘里的那个文件>` | 同上 + **sha256 与本地导出记录一致**（网盘会截断/改名） |
| 每月一次 | `memory backup list --check` | 最近一份是否 < 48h；本地/远端/离线三处是否都在 |

第 2 条是重点：同步盘的失败模式是**静默的**（传了一半、名字带 `(1)`、体积 0）。没有远端校验，"我有备份"就只是信仰。

### 13.1 保留策略

```
memory backup prune --dir <同步盘目录> --keep 7 --monthly 6
```

只删自己命名的 `fish-memory-YYYYMMDD.fmb`；保留规则：最近 7 天 + 每月 1 号留 6 个月。**不碰目录里任何别的文件**（跟 `pruneBackups` 的两条安全规矩一致：只认名字、必须落在 base 之内）。

### 13.2 3-2-1

| 层 | 现状 | 缺口 |
|---|---|---|
| 本地每日（7 份） | ✅ `heal.js:125` | 与库同盘，盘坏一起没 |
| 异地（网盘） | ❌ 本文档 | — |
| 离线（U 盘/移动硬盘） | ❌ | 每月 1 号拷一份 `fish-memory-YYYYMM01.fmb` |

离线那份不做自动化（要插设备），但 `memory backup list` 该能看出"最后一份离线备份是哪天"。

---

## 14. B5（P2）· WebDAV 直传（可选）

只给"不想装同步客户端"的人。限定三件事：

- **只 PUT 单文件**（正好绕开坚果云的文件请求数限制）；
- 只支持 `MKCOL` + `PUT` + `HEAD`（不做 PROPFIND 遍历）；
- 凭据只从环境变量读（`FISH_MEMORY_WEBDAV_URL / USER / PASS`），**绝不写进库、绝不进日志**。

```
memory backup push --webdav
```

Node 内置 `fetch` 够用，零依赖。失败只告警，不影响本地导出（本地那份已经在盘上了）。

**注意**：坚果云必须用**应用密码**（账户信息 → 安全选项 → 添加应用密码），不是登录密码——第三方用登录密码会直接认证失败。

---

## 15. 不做的事

| 不做 | 为什么 |
|---|---|
| 把记忆库目录直接放进同步盘 | §9.2：同步粒度是文件不是事务，`pruneBackups` 的删除会被同步成"用户删了" |
| 接百度/阿里官方 API | 要实名认证、应用审核、token 刷新；收益只是省一次拖拽，风险是凭据进配置 |
| 增量/去重备份 | 201 KB/天，一年 73 MB。做增量要先有"上一份"的索引，等于给备份加状态 |
| 自动"上传成功就删本地" | 网盘失败是静默的；本地 7 份是最后一道，不动 |
| 用设备指纹派生密钥 | 换机器 = 永久丢；而这是她的记忆，不是配置文件 |
| 备份里带 `20_index` / `90_snapshot` | 派生数据，恢复后能重建（`pack.js:10-11` 已经这么做了） |
| 把 `backupDir` 与 `offsiteDir` 合并成一个键 | 一个要"原子目录"，一个要"单文件"，合并就是 §9.2 的坑 |

---

## 16. 修改单

| 版本 | 内容 | 测试 |
|---|---|---|
| **v0.66.0** | E1 情绪判据（新 `hasFeel`）、E2 档案 `mode` + 纸条取数、E3 人格包只读不消费、E5 会话数 OR 天数、E6 删重复 `looksLikeWork` | 约 12 条 |
| **v0.66.1** | B1 单文件导出（tar+gzip，无加密）、`MANIFEST` 去绝对路径、`backup prune` | 约 10 条 |
| **v0.67.0** | B2 加密（AES-256-GCM + scrypt）、B3 `memory restore`（验链 + 原子换入） | 约 12 条 |
| **v0.67.1** | B4 三处校验（`verify` 干跑 / 远端 sha256 / `list --check`） | 约 6 条 |
| **v0.68.0** | E4 `readArchive` 参数收口（删 `since`，或跟 S4 一起落地）、E7 文档债 | 约 3 条 |

顺序理由：E1/E2/E3/E5 都是"每天在错"的小改，一个版本清掉；B1/B2/B3 必须同一版——**只导出不加密是裸奔，只加密不恢复是安慰剂**；B4 依赖 B1 的文件名与头部格式，等格式稳定再加。

---

## 17. 对比源

**备份与同步**

1. Nutstore WebDAV 限制（1 GB/月上传、3 GB/月下载、单文件 500 MB、429 限流、必须用应用密码）—— https://www.jianguoyun.com/ 与社区实测：https://blog.csdn.net/weixin_29913663/article/details/165668899
2. "不要把数据库/正在写入的目录直接扔到 WebDAV 同步"（中间态与整库重传）—— https://blog.csdn.net/weixin_28700411/article/details/166109837
3. 百度网盘开放平台「创建应用」（个人认证 1 个应用；"个人使用"免审核限 10 人；2026-06-03 后新应用仅可访问 `/apps/{appname}`）—— https://pan.baidu.com/union/doc/使用入门/创建应用/
4. 百度网盘「应用用途」与审核问答 —— https://pan.baidu.com/union/doc/使用入门/应用上线审核/应用上线审核试运行/
5. 阿里云盘 2024-07 起三方应用限制（需三方权益包）—— 见 AutoDL 接入说明：https://blog.csdn.net/2301_79760264/article/details/160324588
6. Node `crypto` scrypt / AES-256-GCM —— https://nodejs.org/api/crypto.html
7. 3-2-1 备份原则（近线 / 异地 / 离线）—— https://www.backblaze.com/blog/the-3-2-1-backup-strategy/

**会话隔离（v0.65 复审依据）**

8. SillyTavern lorebook 四级作用域（chat / persona / character / global）—— 见 `docs/PLAN-2026-11-06-session-contamination.md` §2
9. `dsh-memory-portrait`（taint 隔离、审批四不可见）—— https://deepseekharnessplugins.com/zh/plugins/bangbang-03/dsh-memory-portrait
10. ChatGPT Projects 的 project-only memory（双向才有效）—— https://help.openai.com/
11. Letta / MemGPT：写 core memory 是特权操作 —— https://docs.letta.com/
12. 本仓实测：`docs/RESEARCH-2026-11-05-context-handoff.md`（交接四流派）、`docs/PLAN-2026-11-05-v053-hardening.md`（H1–H10）
