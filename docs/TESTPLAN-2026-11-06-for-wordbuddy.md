# 测试任务单：给 WordBuddy（v0.67.0）

> 2026-11-06。对象：`fish-memory-plugin-v0.67.0.zip`（工作副本 799 测试全绿）。
> 这份单子写的是**你该怎么测**，不是"你该实现什么"。**不改代码，只交结论。**
>
> 三条要求：
> 1. **每条都要贴原始输出**（命令 + 完整 stdout/stderr），不要只写"通过/失败"；
> 2. **失败要能复现**：写清你用的库路径、时间、以及当时 `memory today` 的输出；
> 3. **不确定就写不确定**。这一版里有几处是"设计选择"，不是 bug——我在每节末尾写了"什么算 bug、什么算选择"。

---

## 0. 先准备：造一个假库（**不要用真库做破坏性测试**）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd <插件目录>

# A 库：用来测备份（会删、会覆盖，随便造）
& $node scripts/memory.mjs scaffold --dir D:\tmp\fm-a
# 如果 scaffold 不存在，就复制真库：Copy-Item -Recurse <真库> D:\tmp\fm-a
```

**真库路径**：工作区下的 `fish-memory/`（`memory status` 会打印出来）。
**只读测试可以用它；任何 restore / erase / prune 都要用假库。**

---

## 1. 备份三件套（B1 / B2 / B3）——**最高优先级**

这一版的卖点是"能把她的记忆带出这台机器"。**没验过的备份等于没有备份**，所以这一节要求最细。

### 1.1 导出（明文）

```powershell
& $node scripts/memory.mjs backup export --dir D:\tmp\fm-a --out D:\tmp\bk\fish-memory-20261106.fmb
```

| 检查点 | 期望 |
|---|---|
| 退出码 | 0 |
| 输出的 `文件数` | 与 `memory status` 里"点+草稿+档案"数量级一致（几十个，不是 0） |
| 输出的 `KB` | 几十到几百 KB；**如果是 0 KB 或几 MB，记下来** |
| 输出 `明文` | 明文包必须显式写"明文"，不能什么都不说 |
| 目录 `D:\tmp\bk` | **只有一个 `.fmb` 文件**，没有 `.partial-*` 残留 |

**额外验一条**：把 `.fmb` 用 7-Zip 打开（改名成 `.tar.gz` 再解）——**能解开就说明格式是标准的**，这条很重要：备份不能只有这个插件读得懂。

### 1.2 导出（加密）

```powershell
$env:FISH_MEMORY_BACKUP_PASSPHRASE = "test-pass-123"
& $node scripts/memory.mjs backup export --dir D:\tmp\fm-a --out D:\tmp\bk\enc.fmb --encrypt
```

| 检查点 | 期望 |
|---|---|
| 输出 `已加密（aes-256-gcm）` | 必须 |
| **不给口令跑 `--encrypt`** | **报错退出，不许静默降级成明文**（这条是硬要求） |

```powershell
$env:FISH_MEMORY_BACKUP_PASSPHRASE = $null
& $node scripts/memory.mjs backup export --dir D:\tmp\fm-a --out D:\tmp\bk\x.fmb --encrypt
# 期望：非 0 退出 + 明确说"要给口令"
```

### 1.3 验包

```powershell
& $node scripts/memory.mjs backup verify D:\tmp\bk\fish-memory-20261106.fmb
& $node scripts/memory.mjs backup verify D:\tmp\bk\enc.fmb        # 需口令
```

| 情况 | 期望 |
|---|---|
| 明文包 | `✓ 验过：N 个文件 · 链完整` |
| 加密包 + 对口令 | 同上 |
| 加密包 + 错口令 | **"认证失败：口令不对，或这个包被改动过"**（不是 JSON 解析错误） |
| 加密包 + 不给口令 | "这是加密包，需要口令" |
| 把文件截掉一半再 verify | 报错（要么认证失败、要么"不是完整的 gzip"），**不许"验过"** |
| 把中间一个字节改掉再 verify | 报错 |

### 1.4 恢复演练（**最重要的一条**）

```powershell
# 目标必须是不存在或空的目录
& $node scripts/memory.mjs backup restore D:\tmp\bk\fish-memory-20261106.fmb D:\tmp\restored
& $node scripts/memory.mjs verify --dir D:\tmp\restored
& $node scripts/memory.mjs status --dir D:\tmp\restored
```

| 检查点 | 期望 |
|---|---|
| restore 输出 | `✓ 恢复完成：N 个文件` |
| `verify --dir D:\tmp\restored` | `✓ 自检通过` |
| `30_points` 数量与源库一致 | 必须 |
| `00_core/soul.md` 逐字节一致 | 用 `Compare-Object` 或 `fc.exe` 比 |
| 目标非空 + 无 `--force` | **拒绝**，且目标里的原有文件**一个都没动** |

### 1.5 反向测试（这里最容易发现问题）

| 你要做的 | 期望 |
|---|---|
| 往假库的档案里手工改一行（改 `prev`）→ 导出 → restore | **在链校验那步失败，目标目录不被创建** |
| 目标目录非空 → restore 不带 `--force` | 拒绝，原文件不变 |
| restore 带 `--force` | 成功，且旧库被挪到 `*.old-<pid>`（**不是被删**） |
| `backup prune --dir <目录> --keep 3 --monthly 1` 里放一个 `notes.txt` | `notes.txt` **不许被动** |

**什么算 bug / 什么算选择**：
- 备份包体积大得离谱（> 5 MB）→ **bug**，记下来；
- 加密包在 7-Zip 里打不开 → **正常**（设计如此），但明文包必须能打开；
- `restore --force` 把旧库删了而不是改名 → **bug**（必须留 `.old-*`）。

---

## 2. 情绪闸（v0.66 的 E1 修完了吗）

v0.65 有个真 bug：**他用带英文词的话说心情，被当成"工作产出"挡掉了**（他的消息 50% 被挡）。
这一版换成 `hasFeel()`。你要做的是**在真实对话里抽查**。

### 2.1 黑盒测法

1. 打开正常会话，说这几句，每句之后看 `20_state/emotion.json` 的 `turns` 有没有 +1：

| 你说 | 期望 |
|---|---|
| 我今天真的很难受 | turns +1 |
| 刚被 leader 骂了一顿，心里堵得慌 | **turns +1**（v0.65 会不加，这是回归点） |
| 把那个函数抽一下 | turns 不变 |
| 这个报错怎么修 | turns 不变 |
| 我觉得这个方案不行 | turns 不变（判断，不是情绪） |

2. 被挡下的那句会记一行：`50_log/emotion-skip.log`，`why: "no-feel"`。

### 2.2 要你判断的（这是选择，不是 bug）

> **"Java 又出问题了，烦" 该不该改她的心情？**

现在的实现是**会**改（有"烦"）。如果你觉得"技术抱怨不该影响她"，告诉我——那是判据要收，不是 bug。

---

## 3. 会话隔离（v0.65 + v0.66）

| 测什么 | 怎么测 | 期望 |
|---|---|---|
| 纸条不记工作话 | 在一个会话里聊代码，然后在另一个会话看 `20_state/where-we-were.md` | 里面**不该**有"把 xxx.js 改一下"这种句子 |
| 任务包不串窗 | 压缩一次工作会话（让它生成 handoff），然后开一个新会话看注入 | 新会话里**不该**出现工作交接内容 |
| 人格包不会被任务窗吃掉 | 先在日常会话里聊到情绪点，让它生成 handoff；再去工作会话压缩；回日常会话 | 日常会话**还能**读到那段「接着上次」 |

**第三条最难测，也最重要**——它对应的 bug 是"工作窗读一次就把人格包吃了"（v0.66 E3 修的）。

---

## 4. 口癖 / 别名（v0.66 的 E5 改了判据）

1. 让一个**单会话**跨三天（伪造：改档案里的 `ts`）重复同一句 → `memory voice mine` 应**出候选**；
2. 单会话**同一天**重复三遍 → **不出**（那是"一次任务里刷三遍"）；
3. 跑 `memory voice mine` 看有没有**代码味**的句子（带 `lib/`、`npm`、`测试`）——有就是 S2 没修好。

---

## 5. 回归清单（跑一遍，贴输出）

```powershell
& $node --test                      # 期望 799 pass / 0 fail
& $node scripts/tz-check.mjs         # 期望三个时区都是 799/799
& $node scripts/memory.mjs verify
& $node scripts/memory.mjs hostcheck
& $node scripts/memory.mjs gold
& $node scripts/memory.mjs gold --set hard --floor 0.5
& $node scripts/audit-self.mjs
& $node scripts/preflight-open.mjs
& $node scripts/scale.mjs --check
& $node scripts/fidelity.mjs        # 期望 3/5 + 4/4，**退出码 1 是设计如此**
& $node scripts/memory.mjs today
& $node scripts/memory.mjs voice-metrics
```

---

## 6. 我最想知道的三件事（写完这三条就够了）

1. **备份能不能真的救回来**：导出 → 删掉假库 → restore → `verify` 通过？（§1.4）
2. **情绪还半停摆吗**：说五句心里话，`turns` 涨了几次？（§2.1）
3. **有没有新的"她说的话被当成工作"**：跑 `memory voice mine`，把输出原样贴给我（哪怕是空的）。

---

## 7. 不要做的事

| 不要 | 为什么 |
|---|---|
| 用真库做 restore / erase / prune | 这些是破坏性操作，测试一律用假库 |
| 改 `00_core/*` 来"修复"测试结果 | 那是人格层，改了就是在改她 |
| 把口令写进库里（`20_state/`、`40_pending/`） | 等于把钥匙和锁放一个包 |
| 为了让测试通过去调阈值 | 阈值是基线，改它等于改尺子 |

---

## 8. 交付格式

```markdown
# 测试结果 v0.67.0

## 1. 备份
- [x] 1.1 明文导出：<贴输出>
- [ ] 1.2 加密导出：<失败，贴输出>
...
## 2. 情绪闸
- turns 变化：+1 / +1 / 0 / 0 / 0
## 3. 会话隔离
...
## 6. 三件事
1. 能救回来：是/否 + 证据
2. 情绪：<数字>
3. voice mine 输出：<原样贴>
## 附：所有失败的复现步骤
```

**每条都要有原始输出。没有输出的"通过"我不采信。**
