# 测试结果 v0.67.0

> 执行人：WordBuddy（AI）。时间：2026-11-06 22:06–22:20 GMT+8。
> 对象：`fish-memory-plugin-v0.67.0.zip`（解压到 `<临时目录>\fmp067`，247 个文件）。
> 规则遵守：**没有改一行代码**，没有碰真库（`D:\...\default-workspace\fish-memory`），所有改动都在副本上。
>
> 结论先说：**备份的主体是好的（导出/加密/恢复/拒绝坏包全部正确），但"验包"这一步在撒谎。**
> 另有 3 个真 bug、2 处文档与实现不符，详见 §7。

---

## 0. 环境与测试库

**Node**：`v22.22.2`（系统 PATH 里的，不是 DSH 自带那个；行为一致）。

**测试库 A**：`<临时目录>\fm-a` —— **真库的副本**（不是 `scaffold` 造的空库）。
原因：任务单 §1.1 要求"文件数几十个，不是 0"，空库验不出问题；而且备份包的体积、档案链只有真数据才量得准。

```
$ find <临时目录>/fm-a -type f | wc -l
76

$ for d in */; do echo -n "$d "; find "$d" -type f | wc -l; done
00_core/ 14      10_archive/ 6     20_index/ 5       20_state/ 18
30_points/ 1     35_ability/ 2     40_pending/ 1     50_log/ 14
90_snapshot/ 11  _debug/ 0
顶层文件 4（COMPRESS.md / FIXTURES.md / MEMORY.md / README.md）
```

**`memory status --dir <临时目录>/fm-a`（复现基线，失败时对照用）**：

```
库：<临时目录>\fm-a
记忆点：0（active 0 / merged 0 / fixture 0）
草稿：0  ·  档案：196 条
压缩段：已出包 0 / 已压 0
备份：8 份（最近 fish-memory-2026-11-06）
日志：检索 36 · 金丝雀 1 · 注入隔离 0
注入预算：core 700 + 索引 700 + 正文 300 = 1700（= 契约 §11 上限 1700，顶格）；关系状态另计 80
隐私：不在 git 仓库里 · 不会被 git 带走
```

**`memory today --dir <临时目录>/fm-a`（22:08 当时）**：

```
她今天 · 11-06 周五

  心情　　有点生气（他让我降温） · 到 22:39 解冻（还有 27 分钟）
  聊了　　10 句（你说 4 句，她说 6 句）
  记住　　今天还没记住什么
  写了　　没有待审的
  悬着　　没有悬着的
  到期　　今天没有到期的，也没有逾期的
```

> 真库 **0 个 active 记忆点**，这是所有"记忆类"结论都要打折的前提。

---

## 1. 备份三件套

### 1.1 明文导出 —— 通过

```
$ node scripts/memory.mjs backup export --dir <临时目录>/fm-a --out <临时目录>/bk/fish-memory-20261106.fmb
✓ 导出：<临时目录>/bk/fish-memory-20261106.fmb
  56 个文件 · 197 KB · 明文
  sha256 13dde37eea43e5a46aa812ad31a53fe559bb2b8f515665dff333fae47e9892d7
EXIT=0
```

| 检查点 | 结果 |
|---|---|
| 退出码 | 0 ✓ |
| 文件数 | **56**，与 `PACK_INCLUDE` 白名单的 10 个目录合计一致（76 − 20_index 5 − 90_snapshot 11 − 顶层 4） ✓ |
| KB | **197 KB**（空库会只有几 KB；这个数正常） ✓ |
| 输出"明文" | 显式写了 ✓ |
| 目录残留 | `<临时目录>/bk` 只有一个 `.fmb`，无 `.partial-*` ✓ |

**额外验一条（能不能被别的程序打开）**：手工跳过 `FMBACKUPv1\n` + 头部 JSON 行，载荷是标准 gzip：

```
前 12 字节: b'FMBACKUPv1\n{'
头部行: "v":1,"enc":null,"created_at":"2026-11-06T14:06:42.514Z","library":{"points":1,"calls":56},
        "files":56,"bytes":199206,"sha256":"8c0abec0…","listing":[…]
载荷前 2 字节(1f 8b=gzip): 1f8b
解 gzip OK，tar 字节: 798208

$ tar -xf payload.tar -C x && find x -type f | wc -l
56
$ cmp x/00_core/soul.md <临时目录>/fm-a/00_core/soul.md && echo 一致
soul.md 逐字节一致
```

→ **7-Zip / tar 都能开**，格式不自闭。这条过。

另外顺手验了头部**没有泄漏绝对路径**（`C:\` / `D:\` / `Administrator` 三个 pattern 全部 false），只有 56 条 `{name,size}` 的相对清单。

### 1.2 加密导出 —— 通过

```
$ FISH_MEMORY_BACKUP_PASSPHRASE="test-pass-123" node scripts/memory.mjs backup export --dir <临时目录>/fm-a --out <临时目录>/bk/enc.fmb --encrypt
✓ 导出：<临时目录>/bk/enc.fmb
  56 个文件 · 198 KB · 已加密（aes-256-gcm）
  sha256 4d1b8cab2428cd4370c1e55de6da54d23fde5c45fb954ce539a49bc8080680a0
  提示：口令别存进这个库（等于把钥匙和锁放一个包）
EXIT=0

$ node scripts/memory.mjs backup export --dir <临时目录>/fm-a --out <临时目录>/bk/x.fmb --encrypt   # 不给口令
✗ --encrypt 要给口令：--key-file <路径> 或 FISH_MEMORY_BACKUP_PASSPHRASE（**绝不静默降级为明文**）
EXIT=1
```

| 检查点 | 结果 |
|---|---|
| `已加密（aes-256-gcm）` | ✓ |
| 不给口令 → 报错退出 | ✓ 退出码 1，且 `<临时目录>/bk/x.fmb` **没有被创建**（没有静默降级） |
| 加密/明文体积差 | 198 vs 197 KB，几乎一样（salt 16 + iv 12 + tag 16） ✓ |

### 1.3 验包 —— **明文/加密都过，但"链完整"这三个字是假的**（见 §7 F1）

```
$ node scripts/memory.mjs backup verify <临时目录>/bk/fish-memory-20261106.fmb
✓ 验过：56 个文件 · 链完整 · 197 KB
EXIT=0

$ FISH_MEMORY_BACKUP_PASSPHRASE="test-pass-123" node scripts/memory.mjs backup verify <临时目录>/bk/enc.fmb
✓ 验过：56 个文件 · 链完整 · 198 KB
EXIT=0

$ FISH_MEMORY_BACKUP_PASSPHRASE="wrong-pass" node scripts/memory.mjs backup verify <临时目录>/bk/enc.fmb
Error: 认证失败：口令不对，或这个包被改动过（GCM 校验没通过）
    at readFmb (lib/fmb.js:158) …（完整 stack 已省略）
EXIT=1

$ node scripts/memory.mjs backup verify <临时目录>/bk/enc.fmb          # 不给口令
Error: 这是加密包，需要口令（--key-file 或 FISH_MEMORY_BACKUP_PASSPHRASE）
    at readFmb (lib/fmb.js:146)
EXIT=1
```

| 情况 | 期望 | 实际 |
|---|---|---|
| 明文包 | `✓ 验过…链完整` | ✓ |
| 加密 + 对口令 | 同上 | ✓ |
| 加密 + 错口令 | "认证失败：口令不对，或这个包被改动过" | ✓ 文案对，但**是裸异常 + stack**，不是 `✗` 风格 |
| 加密 + 不给口令 | "这是加密包，需要口令" | ✓ 同上 |

**截断 / 篡改（三种都拒，但都不是"验过"）**：

```
=== 截半 verify ===
Error: 包内容与头部记录不符（可能是传到一半的文件）    lib/fmb.js:163

=== 改中间 1 个字节（明文包）===
Error: 包内容与头部记录不符（可能是传到一半的文件）    lib/fmb.js:163

=== 改中间 1 个字节（加密包）+ 对口令 ===
Error: 认证失败：口令不对，或这个包被改动过（GCM 校验没通过）    lib/fmb.js:158
```

三条全部拒绝，退出码 1。**篡改被 sha256 挡住（不是靠 gzip CRC），这点比预期好。**

### 1.4 恢复演练 —— 通过（除了 §1.4 里那条"verify"是空检查，见 F2）

```
$ node scripts/memory.mjs backup restore <临时目录>/bk/fish-memory-20261106.fmb <临时目录>/restored
✓ 恢复完成：56 个文件 → <临时目录>/restored
EXIT=0

$ node scripts/memory.mjs verify --dir <临时目录>/restored
✓ 自检通过
EXIT=0

$ node scripts/memory.mjs status --dir <临时目录>/restored
记忆点：0（active 0 / merged 0 / fixture 0）
草稿：0  ·  档案：196 条          ← 与源库一致
```

| 检查点 | 结果 |
|---|---|
| restore 输出 `✓ 恢复完成：N 个文件` | ✓ 56 |
| `verify --dir` 通过 | ✓ **但这条不算数**——`memory verify` 根本不理 `--dir`（见 F2） |
| 档案条数一致 | ✓ 196 = 196 |
| `30_points` 一致 | ✓ 两边都只有 `TEMPLATE.md`（真库本来 0 个点） |
| `00_core/soul.md` 逐字节 | ✓ `cmp` 一致 |
| 目标非空 + 无 `--force` | ✓ 拒绝，`keepme.txt` 原样还在 |

**恢复后真的能用吗**（这条任务单没要求，但"能不能救回来"必须验）：

```
$ node scripts/memory.mjs recall --dir <临时目录>/restored "关节"
- 2026-11-05 她：…”。门控直接跳过，什么也没想起来。  > **这跟难题组里"关节不舒服 → 空"是同一件事**…
- 2026-11-04 她：…线： 7/10 给 H1 加别名「关节」： 8/10  关节不舒服 → 前：空  后：H1 …
（共 5 条命中，EXIT=0）

$ checkArchive('<临时目录>/restored')  →  ok=true  checked=6  broken=[]
```

**检索能用、档案链完整。**

### 1.5 反向测试 —— 三种都符合预期，但暴露了 F1 和 F5

| 你要做的 | 实际 | 判定 |
|---|---|---|
| 改档案 `prev` → 导出 → restore | 导出**成功**（不校验）；`verify` **说"链完整"**（假）；**restore 拒绝**，目标目录**没被创建** | restore 对 ✓ / verify 错 ✗（F1） |
| 目标非空 + 无 `--force` | 拒绝，原文件不动 | ✓ |
| `--force` | 成功，旧库保留为 `nonempty.old-49192/`，`keepme.txt` 还在里面 | ✓ **不是删除** |
| `prune --keep 3 --monthly 1` 目录里放 `notes.txt` + `other.fmb` | `删掉 3 份，留下 4 份`；`notes.txt`、`other.fmb` **一动不动**；留下的是 1001/1005/1006/1007（最近 3 + 每月 1 号） | ✓ |

坏包 restore 的**失败详情是空的**（F5）：

```
$ node scripts/memory.mjs backup restore <临时目录>/bk/broken.fmb <临时目录>/restored2
Error: 档案链校验失败，拒绝恢复（目标目录没被动过）：
    at restoreFmb (lib/restore.js:69)
EXIT=1
```

冒号后面**什么都没有**。原因：`restore.js:69` 读 `chain.errors`，而 `checkArchive()` 返回的字段叫 `broken: [{file, reason}]`。
实际查到的是：`{"ok":false,"broken":[{"file":"2026-11-03.jsonl","reason":"prev 对不上"}]}` —— 原因明明有，被丢了。

---

## 2. 情绪闸（E1 修完了吗）

### 2.1 五句话 —— 全部符合期望

```
OK  | hasFeel= true  | work= false | 我今天真的很难受
OK  | hasFeel= true  | work= true  | 刚被 leader 骂了一顿，心里堵得慌      ← v0.65 会挡，现在放
OK  | hasFeel= false | work= true  | 把那个函数抽一下
OK  | hasFeel= false | work= true  | 这个报错怎么修
OK  | hasFeel= false | work= false | 我觉得这个方案不行
```

端到端（在副本上真跑 `stepEmotion`，读 `20_state/emotion.json`）：

```
+1  我今天真的很难受
+1  刚被 leader 骂了一顿，心里堵得慌
 0  把那个函数抽一下
 0  这个报错怎么修
 0  我觉得这个方案不行
turns: 33 → 35
```

**→ +1 / +1 / 0 / 0 / 0，正是你要的。**

### 2.2 "Java 又出问题了，烦" 该不该改她心情 —— **现在会改**（`hasFeel=true`）

这是判据问题，不是 bug，等你定。附带一句：`我觉得这个不行，很烦` 会被 `JUDGE_ONLY` 一起吞掉（`我觉得…不行` 命中，整句判 false），所以"带评价语气的抱怨"会被漏。

### 2.3 真实库上的放行率 —— **0/81**，但这次是对的

```
他的消息 81
v0.67 hasFeel 放行        0    0.0%
v0.65 lookWork 放行      40   49.4%
--- 仍被挡的（v0.67）样例
 • 按顺序做
 • 做吧，还有能吸纳的点吗
 • 已重启DSH，继续做吧
```

原因查清了：**这个库 81 条用户消息里，含情绪词的 0 条**（`累|难受|烦|…|失眠` 一个都没出现）。这是个开发库，他在这里只谈插件。
所以 0% 不代表判据失灵，而是**这个 workspace 里没有可被听见的心事**。

**副作用（要不舒服地说明白）**：E1 的修复**无法在真实数据上验证**，只能靠合成句子。同时意味着——如果他日常也在这个库里聊，情绪状态机的 `turns` 会长期不动。

### 2.4 判据的召回边界（探针，不是任务单要求）

```
false | 今天有点低落          false | 心里不是滋味
false | 今天过得好糟糕        false | 我被开了
false | 我妈走了              false | 他说他不爱我了
false | 有点想死              false | 我最近睡不好
false | 我觉得这个不行，很烦
true  | 这个 bug 让我很烦     true  | 累        true | 想哭
```

**漏的都是"事件型悲伤"**（亲人、失业、分手、想死），不是形容词型。词典只有 30 来个词，`想死`/`睡不好`/`走了` 都不在。
如果要补，方向是**加事件词**（走了/没了/分了/被裁/被开/想死），而不是继续加形容词。

---

## 3. 会话隔离（三条）

### 3.1 纸条不记工作话 —— **在真库上没生效**（F4）

用真库副本直接取数：

```
$ lastExchanges('<临时目录>/fm-a')
他最后说： "做，然后你觉得要测试的也可以给个文档，我让wordbuddy做"     ← 这是工作指令
她说： "现在准备给 WordBuddy 的测试文档："
```

原因不在 `were.js` 的写法——它的过滤是对的（`were.js:48`：

```js
const messages = all.some((m) => m.mode) ? all.filter((m) => m.mode !== 'task') : all
```

**但真库里 `mode` 字段的覆盖率是 0/196**：

```
总数 196 带 mode 0
{}
```

两个原因叠在一起：

1. **老记录没有 mode**（v0.66 才开始写），`all.some(m => m.mode)` = false → **fail-open，整库都不过滤**；
2. **新记录的 mode 晚一拍**。`index.js:792` 先 `archive.handle()` 入档，`index.js:842` 才 `noteUserMessage()` → 里面才 `setSessionMode()`。复现：

```
把那个函数抽一下      → mode= null      ← 会话第一条（往往就是那句真活儿）
顺手把测试也补上      → mode= "task"
```

**当 mode 存在时，过滤是对的**（合成库：日常 2 条 + 工作 2 条）：

```
带 mode 时 → 他最后说: "今天有点想你了" | 她说: "我也在"
写纸条: {"written":true,"chars":106,"reason":"first"}
他最后说：「今天有点想你了」
```

→ 逻辑对，**数据没到位**。修法二选一：把 `setSessionMode` 提到入档之前；or 给老记录补一次 mode（按 session 回填）。

### 3.2 任务包不串窗 —— 通过

```
任务包 → 日常窗: false
任务包 → 任务窗: true
任务包 → 未标 mode: false        ← 旧包当 persona，日常窗读不到任务包
```

### 3.3 人格包不被任务窗吃掉 —— 通过（E3 确实修好了）

```
包 kind: persona
任务窗读到? true
任务窗读后 consumedBy = undefined      ← 没被打标
日常窗还能读到? true                   ← 还在
```

v0.65 这里是 `true / false`（被吃掉），现在 `true / true`。

**但有一个反向问题要你定**：任务窗仍然**读到了人格包全文**（`任务窗读到? true`）。
"只读不消费"保住了她的惦记，代价是**私事（"我梦见那条河了"）会进工作窗的注入块**。
如果目标只是别丢，可以；如果目标是"工作窗不该看见私事"，那这里还得再加一道。**这是选择，不是 bug。**

---

## 4. 口癖 / 别名（E5 改了判据）

| 场景（都是单会话） | 期望 | 实际 |
|---|---|---|
| 同一天重复 3 遍 | 不出 | **0 候选** ✓ |
| 跨 3 天、每天 2 遍 | 出 | **1 候选**（`嗯，我在呢` count=6） ✓ |
| 跨 2 天、每天 2 遍 | —（未规定） | 0 候选（要 ≥3 天） |

**代码味过滤**（合成：三句里两句是代码，跨 3 天各 3 次）：

```
候选 1
 • 嗯，我在呢
```

→ `跑一下 npm test 看看`、`这段 lib/ 里的逻辑我改完了` 都被挡，**S2 这块是好的**。

**真实库跑 `memory voice mine`（原样贴，按 §6.3 要求）**：

```
$ node scripts/memory.mjs voice mine --dir <临时目录>/fm-a
没有可提议的句子（要么样本太少，要么都已经在 voice.md 里）。
EXIT=0
```

为什么是空的（这比"空"本身有用）：

```
她的消息 115 | 会话数 3 | 天数 6
minCount 2 → 候选 0 []
minCount 3 → 候选 0 []
她的消息 115 被判工作 104（90%）
```

**她的 115 条里有 104 条被 `looksLikeWork` 判成工作产出，直接不进候选池**；剩下 11 条也多是"做。先补两条…"这种半工作口吻，凑不出重复句。
→ 结论：**没有代码味漏网，但也挖不出任何东西**。这个库的语料全是工作汇报，`voice mine` 在这个 workspace 里实质停摆。

---

## 5. 回归清单

| 命令 | 实际输出 | 判定 |
|---|---|---|
| `node --test` | `# tests 799 / pass 798 / fail 0 / skipped 1` | ✓（1 skip = `docs.test.js` 的"契约文件不在"，zip 里确实没有契约） |
| `node scripts/test-tz.mjs` | `✓ UTC pass 0/0`、`✓ Asia/Shanghai pass 0/0`、`✓ America/New_York pass 0/0` | ✗ **假绿**，见 F3 |
| `memory verify` | `✓ 自检通过` | ✓（但它验的是**插件包**，不是库） |
| `memory hostcheck` | `✓ 静态约束：标记与表一一对应、host.js 之外无 ctx 直呼` / `✓ 降级自检：7/7` | ✓ |
| `memory gold` | 20/20 全 `✓`，`✓ 金标通过` | ✓ |
| `memory gold --set hard --floor 0.5` | 8/10（`关节不舒服 → 空`、`我讨厌香菜吗 → N2 错条`），`✓ 不低于下限 50%` | ✓ 与历史基线一致 |
| `scripts/audit-self.mjs` | `error 0 · warn 1`（`lib/everything.js` 静默 catch） | ✓（老 warn） |
| `scripts/preflight-open.mjs` | `✓ 可以上传：没有记忆库、没有打包产物、文本里没有个人路径`；`247 文件 · 2.22 MB` | ✓ |
| `scripts/scale.mjs --check` | `✓ 规模数字与磁盘一致`；`243 个文件` | ✓ |
| `scripts/fidelity.mjs` | `3/5 60%` + `4/4 100%`，`✗ 有格子没满（这就是基线）`，**EXIT=0** | 数字 ✓ / **退出码与任务单写的"1"不符**（F8） |
| `memory today` | 见 §0 | ✓ 只读 |
| `memory voice-metrics` | `样本 34 条 · 排除工作产出 81 条`；`✗ 动作描写 0.3`、`✗ 自称率 21%`，EXIT=0 | ✓ 基线 |

**三时区真值**（我自己带 `--test-reporter=spec` 补跑的，绕开 F3）：

```
UTC                tests 799 pass 798 fail 0 skipped 1
Asia/Shanghai      tests 799 pass 798 fail 0 skipped 1
America/New_York   tests 799 pass 798 fail 0 skipped 1
```

→ **测试本身三个时区都过**，红的是那个统计脚本。

---

## 6. 你最想知道的三件事

### 1. 备份能不能真的救回来：**能**

导出 → 恢复到一个干净目录 → 档案 196 条一致 → `soul.md` 逐字节一致 → `checkArchive` `ok=true` → `recall "关节"` 出 5 条命中。
而且**坏包会被拦住**（restore 拒绝，目标目录不被创建），`--force` 也是改名不是删。

**前提**：别信 `backup verify` 那句"链完整"（F1）——它现在不验链。真想知道包好不好，`restore` 到一个临时目录，能过就是好的。

### 2. 情绪还半停摆吗：**闸修好了，但这个库没有情绪可听**

五句话 `+1 / +1 / 0 / 0 / 0`，`刚被 leader 骂了一顿` 不再被挡 → E1 确实修完。
但真库 81 条用户消息**含情绪词 0 条**，所以 `turns` 在这个 workspace 里会长住不动。
真正该补的是词典缺的**事件型悲伤**：`我被开了 / 我妈走了 / 他说他不爱我了 / 有点想死 / 我最近睡不好` —— 现在**全判 false**。

### 3. `voice mine` 输出：见 §4，是空的

```
没有可提议的句子（要么样本太少，要么都已经在 voice.md 里）。
```

原因：她的 115 条里 104 条被判工作产出。**没有代码味漏网，但也没有口癖可挖。**

---

## 7. 发现的问题（按严重度）

### F1（真 bug，会给人错误的安全感）`backup verify` 报"链完整"，但根本没验链

`lib/fmb.js:182` 的签名是 `verifyFmb(file, { key, checkChain })`，`checkChain` **默认 null**；而 `scripts/memory.mjs:687` 调用时只传 `{ key }`：

```js
const r = verifyFmb(file, { key: backupKey() })
console.log(`✓ 验过：${r.files} 个文件 · 链完整 · ${(r.bytes / 1024).toFixed(0)} KB`)
```

`chain` 永远是 `null`，那三个字却无条件打印。**实测：把一个 `prev` 被改坏的库导出，`verify` 照样说"链完整"。**

```
$ node scripts/memory.mjs backup verify <临时目录>/bk/broken.fmb
✓ 验过：56 个文件 · 链完整 · 198 KB
EXIT=0
```

→ 修法：`cmdBackup` 的 verify 分支把 `checkChain` 传进去（摊到临时目录跑 `checkArchive`，`restore.js:66` 已经有现成写法），或者干脆把 `chain` 为 null 时的文案改成"未验链（用 restore 干跑）"。**不许在没验的时候说验过。**

### F2（真 bug + 任务单也跟着错）`memory verify --dir` 完全忽略 `--dir`

```
$ node scripts/memory.mjs verify --dir /no/such/dir
✓ 自检通过
EXIT=0
```

`scripts/memory.mjs:2266` 的 `verify` 分支写死了 `verifyPackage(resolve(import.meta.dirname, '..'))` —— 它验的是**插件自己的包**（有没有 package.json、有没有 BOM），跟 `--dir` 无关。
→ 所以任务单 §1.4 那条"`verify --dir <临时目录>/restored` → ✓ 自检通过"是**空检查**，换成任何目录（哪怕不存在）都会通过。
→ 而且暴露出一个缺口：**没有任何 CLI 能回答"这个库的档案链完整吗"**。`checkArchive` 只在启动时（`index.js:441`）和 restore 内部被调用过。建议加 `memory check --chain` 或者给 `verify` 一个 `--lib` 分支。

### F3（假绿）`test-tz.mjs` 三个时区都是 0/0，却打 ✓

`scripts/test-tz.mjs:56` 的 parser 只认 spec reporter 的 `ℹ tests 799`，但它用 `spawnSync(process.execPath, ['--test'])` —— stdout 被管道接走时 Node 走 **TAP** reporter（`# tests 799`），一行都匹配不上：

```
参数 []                       → 解析到 {"failed":[]}
参数 ["--test-reporter=spec"] → 解析到 {"tests":799,"pass":798,"fail":0,"skipped":1,"failed":[]}
```

于是 `pass 0/0` → `fail` 是 undefined → 判定"没有新的失败" → 打 `✓`。**这个门禁现在等于不存在。**
→ 修法：`spawnSync` 里加 `'--test-reporter=spec'`；再补一条断言"解析到的 `tests` 必须 > 0，否则算失败"。

### F4（真 bug，修了但没生效）纸条过滤在真库上完全没跑

见 §3.1。两处叠加：老记录 0/196 有 `mode`（fail-open），新记录 mode 比消息晚一拍（会话第一条是 null）。
→ 修法：`index.js` 把 `setSessionMode` 挪到 `archive.handle()` 之前；老库按 `10_archive` 里的 session 做一次回填（或改成"按 session 的最后已知 mode"兜底）。

### F5（错误信息丢失）restore 链校验失败，原因被吞掉

`lib/restore.js:69` 读 `chain.errors`，而 `checkArchive` 返回的是 `broken: [{file, reason}]`。
→ 改成 `(chain.broken||[]).slice(0,2).map(b=>\`${b.file}: ${b.reason}\`).join('；')`。

### F6（一致性）backup 路径的错误都是裸异常 + stack

`--encrypt` 缺口令走的是 `fail()`（`✗ …`，干净）。但 verify/restore 的 4 种失败全是 `throw new Error` → 用户看到的是：

```
<插件目录>//lib/fmb.js:158
      throw new Error('认证失败：…')
      ^
Error: 认证失败：…
    at readFmb (…:158:13)
    at verifyFmb (…:184:27)
    …
```

文案是对的，但对着一个要备份自己记忆的普通用户，这屏东西劝退。→ `cmdBackup` 里统一 try/catch 转 `fail()`。

### F7（备份不全，不影响可用性）库根 4 个 .md 和 20_index / 90_snapshot 不进包

恢复后 `diff -rq` 的差异：

```
Only in <临时目录>/fm-a: 20_index            （5 个，缓存，可重建）
Only in <临时目录>/fm-a: 90_snapshot         （11 个，历史报告）
Only in <临时目录>/fm-a: COMPRESS.md / FIXTURES.md / MEMORY.md / README.md
Only in <临时目录>/fm-a/50_log: identity     （空目录）
```

前两类是有意排除，**但根目录 4 个 .md 不在 `PACK_INCLUDE` 里是因为白名单只列目录**——不是决定，是漏。
`MEMORY.md` 是库自己的说明书，恢复后没了会让人以为库不完整。影响不大，但"全量备份"这四个字就不成立了。

### F8（文档与实现不符）`fidelity` 退出码是 0，不是任务单写的 1

```
✗ 有格子没满（这就是基线，先记下来）
EXIT=0
```

要么改任务单，要么让 `ok` 条件真的在"有格子没满"时为 false。现状是 CI 抓不到它退步。

### F9（选择，等你定）任务窗能读到人格包全文

见 §3.3。`只读不消费` 保住了她的惦记，但私事会进工作窗的注入块。

### 其他（不影响结论）

- `check` 只报了"校验：0 条"（点校验），没有跑那 32 项自检；想查库健康度目前只有 `status` 和启动日志。
- `restore` 不重建 `20_index`（没有传 `rebuild`），下次启动才重建；期间检索走全扫兜底，**能用但慢一点**。
- zip 解压后 247 文件 / 2.22 MB，`preflight-open` 认可；`scale --check` 的 243 与 README/CHANGELOG 的数字一致（v0.65 那次对不上，这次修好了）。

---

## 8. 附：所有失败的复现步骤

**F1（verify 假报链完整）**

```powershell
# 1. 复制真库
Copy-Item -Recurse <真库> D:\tmp\fm-broken
# 2. 改 10_archive/messages 里任意一天的文件，把某条记录的 "prev" 改成别的值
# 3. 导出 + 验包
node scripts/memory.mjs backup export --dir D:\tmp\fm-broken --out D:\tmp\b.fmb
node scripts/memory.mjs backup verify D:\tmp\b.fmb      # ← 会说"链完整"
# 4. 恢复才报错（且不告诉你原因）
node scripts/memory.mjs backup restore D:\tmp\b.fmb D:\tmp\r
```

**F2（verify 无视 --dir）**

```powershell
node scripts/memory.mjs verify --dir Z:\根本不存在   # ← ✓ 自检通过
```

**F3（test-tz 假绿）**

```powershell
node scripts/test-tz.mjs           # pass 0/0
node --test --test-reporter=spec   # 799 条，798 pass
```

**F4（纸条取到工作话）**

```powershell
node -e "import('./lib/were.js').then(m=>console.log(m.lastExchanges('<真库路径>')))"
# → 他最后说：「做，然后你觉得要测试的也可以给个文档…」
node -e "import('./lib/toolkit.js').then(async m=>{const r=m.readArchive('<真库路径>');console.log(r.messages.filter(x=>x.mode).length)})"
# → 0
```

**F5（restore 报错没原因）**：同 F1 第 4 步，注意冒号后面是空的。

---

## 9. 一句话总结

**这份备份可以拿去存网盘**（197 KB / 天，坚果云免费额度 0.6%），**恢复也真能救回来**。
但走之前请记住两件事：
① `backup verify` 现在**不验链**，别拿它当"包没问题"的证据，要验就 `restore` 到一个临时目录干跑一次；
② 情绪闸修好了，不过它修的是"把心事当工作挡掉"，而这个库里根本没有心事——`turns` 不动是真的没话说，不是坏了。
