# 审计：记忆之外的问题（v0.69.0）

> 2026-11-07。对象：`fish-memory-plugin-v0.69.0.zip`（836 测试，835 过 / 1 skip）。
> 问题不是"她记不记得住"，而是**库本身在长、在联网、在被人用**之后会出什么事：
> 性能、并发、隐私边界、服务面、打包交付、以及"缺了会难受"的功能。
>
> 方法：解包在工作目录、跑全量测试、造 5 万条合成档案做实测、逐文件读热路径。
> 每条都给了 `文件:行` 和复现方式。**没有一条是猜的。**

---

## 0. 一页结论

| # | 问题 | 类 | 优先 | 一句话 |
|---|---|---|---|---|
| A1 | 每轮全量读档案 | 性能 | **P0** | `tidyLine` 每轮调 `countRows()`→`readArchive()`，5 万条时每轮 +110ms，线性增长 |
| A2 | 整理材料包每来一条新建一个目录 | 性能/磁盘 | **P0** | due 期间每个 turn 新建 `90_snapshot/tidy-<rows>/`，实测 40/41/42 三个目录并存，永不清理 |
| A3 | `scope` 列没有写入方，隔离层空转 | 隐私 | **P1** | 缺省 global + 全仓无写入点 → 接群那天私聊记忆进群（标题级）、群记忆回流私聊（全文） |
| A4 | 本地 HTTP 服务无鉴权 / 无 body 上限 / 不校验 Host | 安全 | **P1** | 任何本机进程可读整段注入记忆；`POST /outcome` 可撑爆内存、可覆盖 `event` 字段 |
| A5 | 墓碑账本用"读全文+重写"而非追加 | 数据 | P2 | `refute` 与 `erase` 两种写法并发会丢条；账本越长越慢 |
| A6 | 原子写没有 fsync | 数据 | P2 | tmp+rename 断电可能丢最新写入；档案 append 同理 |
| A7 | 写锁 3s 超时 / 30s 判残留 | 并发 | P2 | 大库上 `redact --apply`/`promote` 跑 >30s 会被抢锁；插件侧失败只留一行 warn |
| A8 | 发布 zip 中文文件名乱码 + 反斜杠路径 | 交付 | P2 | `unzip` 直接告警；`docs/发布到GitHub.md` 解出来是 `ÕÅæ...md` |
| A9 | 配置校验不认 `tidy` / `habits` | 工程 | P2 | 代码在读、校验层当"拼错的键"丢掉：`tidy.every` 永远 35，`habits.enabled:false` 关不掉 |
| A10 | `checkPayload` 死代码 + 假绿风险 | 工程 | P3 | 全仓无调用，且它的哈希口径永远对不上头部 |
| A11 | tar 头 100 字节硬截断 | 交付 | P3 | 中文文件名 >33 字被静默截断 |
| A12 | 日志无轮转 | 运维 | P3 | `ability.log`（还被 HTTP 无限追加）/`pressure.log`/`tamper.log` 只增不减 |
| A13 | 发布包缺契约 → 每次发布少 3 条断言 | 工程 | P3 | 那个 skip 就是它 |
| A14 | `detect()` 会 spawn `reg.exe` | 环境 | P3 | 管控机器上被拦/变慢（本次沙箱就拦了） |

缺失功能见 §3：通道写入、导入、跨设备合并、草稿审阅界面、档案冷存、`doctor`、服务鉴权、i18n。

---

## 1. 性能：档案在长，热路径在按 O(n) 付费

### A1 每轮全量读档案（P0）

`lib/index.js:1292` 在**每轮**的 `systemPrompt.context` 里调 `tidyLine`：

```js
const tidy = tidyLine(dir, { every: tidyEvery })   // index.js:1292
```

而 `tidyLine` → `tidyStatus` → `countRows` → `readArchive`（`lib/tidy.js:84, 70-73`）：

```js
const rows = Math.max(st.rows, countRows(dir))     // tidy.js:84
```

`readArchive` 没有缓存：读到每个 `10_archive/messages/*.jsonl`、逐行 `JSON.parse`、再全量排序（`lib/toolkit.js`）。

**实测**（合成库，10 个日文件 / 5 万条 / 短文本）：

```
messages 50000   first call 122.4ms   second call 109.4ms
```

真实文本更长，只会更慢。真库 196 条约 2–3ms，所以现在**完全无感**——这正是它危险的地方：等有感觉时已经改不动了。

而且这个计数**根本不需要读档案**：`lib/archive.js:264` 每写一条已经调了 `noteArchived()` 累加计数器（`lib/tidy.js:59`）。`Math.max` 那一行是"不信任自己的账本"，把 O(1) 退化成 O(n)。

**修**：`tidyStatus` 直接用 `st.rows`；只在三处校正——启动后第一次、`tidy --done`、以及每 6 小时一次（或计数器文件 mtime 早于最新日文件时）。约 15 行改动，`test/tidy.test.js` 加一条"5 万条时 tidyLine 不读档案"（可以用 `readArchive` 打桩计数）。

### A2 整理材料包每来一条消息新建一个目录（P0）

`lib/tidy.js:108` 的幂等条件只挡"条数没变"：

```js
if (st.lastPackRows === s.rows && existsSync(...)) return { ok: true, reused: true, ... }
```

一旦 due（自上次整理 ≥35 条），**每来一条新消息 `rows` 就 +1**，于是每轮都：`readArchive` 第二遍（tidyPack 里再读一次）+ 新建目录 + 写 4 个文件。实测：

```
packs: tidy-40, tidy-41, tidy-42
```

`90_snapshot/` 不进备份、不进注入（这点是对的），但**没有任何清理**。due 状态可能持续几天（等人有空 `--done`），于是几天里每个 turn 都留一个目录，每个都带一份"最近 N 条原文"。

**修**：包名用**水位起点**而不是当前条数（`tidy-<lastTidyRows>`），一个 due 周期只建一次；或加 `lastPackAt` 冷却（≥10 分钟）+ 保留最近 3 个包、更老的 `rm`。顺手把 `tidyPack` 的 `readArchive` 换成 `slice(-since)` 的增量读（见 A1 的缓存）。

### 顺带：`memory today` 每 2 秒一次全量读（P2）

`lib/today.js:76` 的 `readArchive(dir).messages` 是 `/today` 的主数据源，而 dashboard 是 2 秒轮询（`scripts/dashboard-html.mjs`）。页面开着时 = 每 2 秒一次全量解析。同样用 A1 的缓存/增量方案解决；或者 `/today` 的结果按 10 秒缓存。

---

## 2. 隐私与安全

### A3 `scope` 没有写入方：隔离只做了读侧（P1）

三件事拼起来才是完整隔离：**写的时候标归属 → 读的时候按归属过滤 → 跨场合降级**。
现在只有第二、三件。

- 缺省值：`lib/scope.js:31-33` —— 没写 scope 的点按 `global` 处理，而 `global` 在 `visible()` 里对**所有**作用域可见；
- 读侧：`lib/index.js:991` 确实过滤了（这点没问题）；
- 写侧：**没有任何地方给点写 scope**。`grep` 全仓，只有 `lib/toolkit.js:210` 在读、`:431` 在按 `group:*` 加限制；
- 她写草稿用的技能模板（`lib/index.js:118-160`）里字段清单有 `type/cluster/event/tags/status/source/links`，**没有 `scope`**（也没有 `visibility`）。

后果分两层：

1. **接群那天**（你正在做的下一步）：所有历史点都是 global。私聊记忆虽然因为 `visibility` 默认 `private` 只给"索引行"，但**标题会进群**——"他怕被丢下"这种标题本身就是隐私。
2. **更远的将来**：群里产生的点同样不带 scope → 变 global → 群聊内容回流私聊全文，直接违背 v0.58 写的"主人的库不该因为群聊膨胀"。

`memory scope` 的输出还明确写着"历史点没有 scope 的按 global 处理，不用迁移"（`scripts/memory.mjs:977`）——这句话在只有私聊时是对的，接了群就是错的。

**修**（都不大）：
- 技能模板加两行：`scope`（默认取 `cfg.scope`）、`visibility`（默认 `private`）；
- `memory scope stamp --default dm:master [--dry]`：给所有无 scope 的历史点补一列，写日志；
- 反向测试：`group:A` 的注入里不许出现任何 `dm:master` 点的**标题**（现在会出）。

### A4 本地 HTTP 服务：无鉴权、无 body 上限、不校验 Host（P1）

`scripts/serve.mjs:87-146`：

- `/context` 返回**整段注入文本**（核心层 + 关系状态 + 检索到的记忆 + 最近 6 条对话）——任何本机进程 `curl 127.0.0.1:8787/context` 就能读到她的全部私聊记忆；
- `POST /outcome` 没有 body 上限（`req.on('data')` 一路拼字符串），本机进程可以几秒撑爆内存；
- 写日志用 `{ at, event: 'outcome', ...o }`，`o.event` 能覆盖 `event` 字段——账本可被污染成任意 event；
- 没有 `Host` 头校验。绑 `127.0.0.1` 挡不住 DNS rebinding：恶意网页把域名解析到 127.0.0.1，就能用浏览器打这个接口（`/outcome` 用 `text/plain` 是简单请求，不需要预检）。

只读、只本机，所以是 P1 不是 P0。但你要接 QQ——一旦有常驻服务，这个面就不再是"只有我自己"。

**修**：可选 `FISH_MEMORY_TOKEN`（`Authorization: Bearer`，没配就不启用，保持现在的手感）；body ≤64KB；`Host` 必须是 `127.0.0.1`/`localhost`；`event` 固定为 `'outcome'`（`...o` 放前面）。

---

## 3. 数据可靠性

### A5 墓碑账本两种写法（P2）

`lib/refute.js:92-94`：

```js
const prev = existsSync(log) ? readFileSync(log, 'utf8') : ''
atomicWriteText(log, `${prev}${JSON.stringify(row)}\n`)
```

而 `erase.js` 用的是追加。同一个 `50_log/erasure.log`，两个写入方两种策略：并发时"读—改—写"会丢掉另一方刚追加的那行；账本变长后每次 refute 都要整读整写。墓碑账本是**改错闭环的唯一凭证**，丢一条就等于"这次改错没有发生"。

**修**：统一 `appendFileSync`（墓碑不需要原子整体替换，单行追加才是正确语义）。

### A6 原子写没有 fsync（P2）

`lib/util.js:136-141 / 167-172`：`writeFileSync(tmp)` + `renameSync`。rename 保证"要么旧的要么新的"，不保证**内容已落盘**。断电时可能出现：文件存在但长度 0 / 尾部截断。核心层（`soul.md`）和 `30_points/*.md` 都走这条路径。

档案同理：`lib/archive.js:254` `appendFileSync`，OS 缓冲，掉电丢最后几条是"正常"；但 `20_state/cursors.json` 也走原子写，两者落盘顺序无保证 → 极端情况下**游标前进了、消息丢了**，重启后按游标去重，那几条永远补不回来。

**修**：给核心层与点文件加 `fsync`（`openSync`+`writeSync`+`fsyncSync`+`closeSync`，约 10 行）；档案每 N 条（如 20）`fsync` 一次；游标写之前先 `fsync` 档案 fd。成本可忽略（一天几十次）。

### A7 锁的租约太短（P2）

`lib/lock.js:19`：`timeoutMs = 3000, staleMs = 30_000`。

- 大库上 `redact --apply`（全库重写+重算链）、`promote`（几十条校验）、`ingest` 都可能 >30s → 另一个进程判"残留"直接抢锁，两边同时写；
- 插件侧每次状态写入只等 3s，等不到就抛；上层全是 `catch { warn }`（`lib/index.js:333-339` 一带）→ 用户只会看到"刚才那步没生效"，日志里一行字。

**修**：锁文件写 pid + 租约时间，长操作每 10s `utimes` 续租；`staleMs` 提到 5 分钟；插件侧把"锁超时"计数进 `50_log` 并在 dashboard 显形（不要让失败只活在日志里）。

---

## 4. 交付与工程

### A8 发布 zip：中文名乱码 + 反斜杠路径（P2）

```
$ unzip -l fish-memory-plugin-v0.69.0.zip
warning: ... appears to use backslashes as path separators
   lib\alias.js
```

解包后 `docs/` 里出现：

```
ÕÅæթâÕê¦GitHub.md        ← 发布到GitHub.md
ÕÅæթâÕîà.md              ← 发布包.md
```

这是 PowerShell 5.1 `Compress-Archive` 的典型产物：路径用 `\`、文件名按 OEM 代码页（中文系统是 CP936）写且不设 UTF-8 标志位（zip spec bit 11）。Windows 资源管理器看着正常，mac/Linux 的 `unzip`、7-Zip、任何 CI 解包都会乱码，部分工具会真的创建出带反斜杠的文件名。

**修**：改用 `tar -a -c -f out.zip`（Win10+ 自带 bsdtar，写 UTF-8 标志）或 7-Zip `-mcu=on`；发布脚本里加断言：`unzip -l out.zip | grep -q '\\\\' && exit 1`，再加一条"解包后 `docs/` 里没有 `Ã`/`Õ` 这类字符"。

### A9 两个配置键读得到、写不进（P2）

`lib/config.js:46`：

```js
const TOP_KEYS = new Set(['memoryDir','backupDir','backupKeep','inject','retrieval','pressure','emotion','remind','scope'])
```

但代码在读 `cfg.tidy`（`lib/index.js:1291`）和 `cfg.habits`（`lib/index.js:1238`）。校验层会把它们当"拼错的键"告警并丢掉（`config.js:132-133`）。后果：`tidy.every` 永远 35；`habits.enabled: false` 怎么配都关不掉——和你之前修过的"情绪默认值从没开过"是同一类 bug，只是这次方向相反（用户改不动）。

**修**：`TOP_KEYS` 加 `tidy`、`habits`，并补 `NUMBER_RULES`/`BOOLEAN_RULES`（`tidy.every` 5–500，`habits.enabled` bool），README 加一小段。

### A10 `checkPayload` 是死代码且会假绿（P3）

`lib/restore.js:112`：全仓无调用；它算的 `sha256` 是"所有文件内容拼接"的哈希，而头部记的是**gzip 载荷**的哈希——两者永远不可能相等。现在不调用所以无害；哪天有人把它接进 `verify`，就是第二个 v0.67.1 修掉的"无条件打印链完整"。

**修**：删掉，或改名 `payloadDigest` 并只用来做"包内一致性"对比（同一份清单两边各算一次）。

### A11 tar 文件名硬截断（P3）

`lib/tar.js:31`：`buf.write(name.slice(0, 100), 0, 'utf8')`。按字节截断，中文名超过 33 个字就断在半截上，恢复时文件名损坏、甚至两个文件撞名。库里路径目前都是 ASCII（`00_core/...`），只有库根的中文 `.md` 会踩到。

**修**：长度 >100 字节直接抛错（宁可备份失败，不要备份出一个坏名字）；或实现 ustar `prefix` 字段。

### A12 日志没有轮转（P3）

`50_log/` 下有 `behavior.jsonl`（有 prune）、`cliche.log`（有 prune），但 `ability.log`、`pressure.log`、`self.log`、`tamper.log`、`inject-oversize.log` 只增不减。`ability.log` 还能被 `POST /outcome` 无限追加（见 A4）。

**修**：`logLine` 统一加按大小滚动（2MB → `.1`），或给每个日志定一个"保留最近 N 行"的 `pruneLog`。

### A13 发布包里的那 1 个 skip（P3）

`test/docs.test.js:56-70`：找不到 `../../大肥鱼-插件接口契约-v1.0.md` 就 `t.skip`。所以每次发布都是 835/836——少的三条断言恰好是"契约里的硬说法和代码一致"。

**修**：把契约放进 `docs/`（脱敏后）随包发；或 CI 显式 checkout 工作区文档。不要让"绿"里有一个洞。

### A14 测试/启动会 spawn `reg.exe`（P3）

`lib/everything.js:52-60`：`detect()` 会 `reg query HKLM\SOFTWARE\voidtools\Everything`（4000ms 超时）。在注册表被管控 / EDR 拦进程的机器上会失败——**本次审计的沙箱就把它拦了**（`PROGRAM BLOCKED BY SECURITY POLICY: reg.exe`），测试仍然 835 过，说明容错是对的，但没必要每次走这条路。

**修**：`detect()` 默认不查注册表（env → 配置 → PATH 三步够了），把注册表探测挪到 `memory es --detect` 显式调用并缓存结果。

---

## 5. 缺失功能（不是 bug，是"还没有"）

按"你已经说过要做"的顺序排：

| # | 缺什么 | 现在有什么 | 影响 |
|---|---|---|---|
| M1 | **通道写入路径**（QQ/微信） | `scope` 判定 + `/context` 读接口 + 契约文档；`serve.mjs` 明写"不做消息写入，等适配器" | 群聊现在只能读不能记；接通道前必须先修 A3/A4 |
| M2 | **导入**（ChatGPT / Claude / SillyTavern / 其他伴侣导出） | 只有 `ingest`（把 40_pending 提升），没有"外部记录 → 档案/pending" | 换栈迁移只能手抄；旧聊天记录无法变成她的记忆 |
| M3 | **跨设备合并/同步** | `merge-check` 只诊断（天文件分叉/点 id 冲突/核心层两边改过），明确"不做双向同步" | 两台机器各聊一半，只能人工挑；网盘备份只能整库回滚 |
| M4 | **草稿审阅界面** | `dashboard` 只读；`40_pending` 靠编辑器或 CLI | 草稿越积越多（A2 的 due 状态也不会消）；手机上看不了 |
| M5 | **档案冷存** | 日文件只增不减，`readArchive` 永远全量；备份把整个 `10_archive` 塞进 `.fmb` | 5 年后的备份包 = 整个聊天史；A1 的 O(n) 没有尽头 |
| M6 | **一键体检** | `selfcheck` / `hostcheck` / `envcheck` / `audit` / `verify` / `compat` 六个命令各自为政 | 用户不知道该跑哪个；`memory doctor` 汇总 + 给修复建议，是给"非作者"用的 |
| M7 | **服务鉴权/限流** | 无（见 A4） | 见 A4 |
| M8 | **多角色** | 一个目录一条鱼（`memoryDir`） | 如果你以后想养第二条鱼，只能开新 workspace；写清楚"不支持"也行 |
| M9 | **英文/i18n** | README 59KB 全中文，代码注释全中文 | 开源给非中文用户时是硬门槛；至少 README 顶部加一段英文摘要 |

---

## 6. 已经做对的（这次不用动，列出来防止下次又被"优化"掉）

- **零依赖、零网络**：`lib/` 里没有 `fetch`/`http`；唯一的网络是 `scripts/serve.mjs`（显式启动）。
- **定时器全部 `unref`**（`lib/host.js:435`、`lib/store.js:616`）——不会拖着宿主进程不退出。
- **dashboard 无 XSS**：全部 `textContent`，没有 `innerHTML` 拼数据（`scripts/dashboard-html.mjs:68-83`）。
- **脱敏在入库前**（`lib/archive.js:110`），不是展示时——档案里从来没有明文密钥/手机号。
- **写入锁 + 跨进程竞态自愈**（`lib/archive.js:227-244`）：外部改了日文件，重读链头并留 `archive-race.log`。
- **备份恢复是"验链后才换入"**：`restore.js` 的三道闸（路径安全 / 暂存验链 / 目标非空拒绝）是对的。
- **测试门禁三时区**：`npm run test:tz` 真的在跑三个时区（v0.67.1 修过"假绿"）。

---

## 7. 建议顺序

1. **A1 + A2**（半天）：同一个文件、同一类问题（把 O(n) 改回 O(1)，把包改成"一周期一个"）。这是唯一会随使用变烂的一条。
2. **A3 + A9**（半天）：都是"默认值/校验层"的小改，但 A3 决定你接群那天会不会翻车。
3. **A4 + A7**（一天）：服务鉴权 + 锁租约，为常驻服务做准备。
4. **A5 + A6 + A10 + A11**（半天）：数据与交付的小口子，一起扫掉。
5. **A8 + A13**（一小时）：打包脚本换 bsdtar + 契约进包。
6. **M2 / M4**（各 1–2 天）：导入和审阅界面，直接决定"养鱼的日常手感"。
7. **M3 / M5**（设计题）：跨设备合并和档案冷存都需要先定策略（分叉怎么裁、冷存怎么检索），别急着写代码。

## 8. 验收

- `test/tidy.test.js`：5 万条时 `tidyLine` 不读档案（打桩计数 = 0）；同一 due 周期只建一个包。
- `test/scope.test.js`：`group:A` 的注入里没有任何 `dm:master` 点的标题；无 scope 的历史点经 `stamp` 后归属正确。
- `test/serve.test.js`：无 token 时 `/context` 401（启用 token 后）；body >64KB 返回 413；`Host: evil.com` 返回 403。
- `test/lock.test.js`：持锁 >30s 不被抢（续租生效）；抢锁失败有日志。
- 打包脚本：`unzip -l` 无 `\` 路径、`docs/` 无乱码名；`test/docs.test.js` 不 skip。
- 全量门禁 ≥836，且 0 skip。
