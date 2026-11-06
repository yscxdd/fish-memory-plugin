# 操作手册：导出 → 删库 → 恢复（v0.67.2）

> 2026-11-06。这份是给你**自己动手**用的，不是给 AI 看的。
> 全文约 10 分钟能走完。**第一次请用假库演练（§2），别直接拿真库开刀。**
>
> 为什么需要这份：备份只有在**你真恢复过一次**之后才算备份。
> 在那之前它只是"一组体积不小的文件"。

---

## 0. 三句话

1. **导出**是一个文件（`.fmb`），**不是**一个目录——同步盘只会看见一个写完的文件，不会边写边传。
2. **删库之前先验证**：`verify` 通过 + `restore` 到一个空目录能跑通，再去删真的。
3. **删库不等于删档案**：删的是"这个库目录"，`.fmb` 在别处，那才是你的底牌。

---

## 1. 先认路

```powershell
# 用 DSH 自带的 Node（系统 PATH 里的那个版本可能不一样）
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 进插件目录（换成你的实际路径）
cd <插件目录>
```

**你的库在哪**：

```powershell
& $node scripts/memory.mjs status
```

输出第一行 `库：<路径>` —— 那就是要备份的东西。**记住它，后面叫它 `<真库>`**。

---

## 2. 演练：用假库走一遍完整流程（**必须先做这一步**）

```powershell
# 2.1 复制真库当靶子（不是 scaffold 空库——空库验不出问题）
Copy-Item -Recurse <真库> D:\tmp\fm-drill

# 2.2 导出
New-Item -ItemType Directory -Force D:\tmp\bk | Out-Null
& $node scripts/memory.mjs backup export --dir D:\tmp\fm-drill --out D:\tmp\bk\drill.fmb
```

**期望看到**：

```
✓ 导出：D:\tmp\bk\drill.fmb
  N 个文件 · XXX KB · 明文
  sha256 <64 位十六进制>
```

| 现场检查 | 怎么查 | 期望 |
|---|---|---|
| 只有一个文件 | `Get-ChildItem D:\tmp\bk` | 只有 `drill.fmb`，**没有** `.partial-*` |
| 体积合理 | 上面的 `XXX KB` | 几十到几百 KB（空库会只有几 KB，那说明事都没备上） |
| 能验 | 下面 2.3 | `✓ 验过…链完整（已验）` |

```powershell
# 2.3 验包（这一版起会真的验链）
& $node scripts/memory.mjs backup verify D:\tmp\bk\drill.fmb
```

> **注意**：如果这里报 `链校验失败：…`，**先别往下走**。那说明导出的库本身链是坏的
> （先跑 `memory verify --dir D:\tmp\fm-drill` 查清楚），不是备份的问题。

```powershell
# 2.4 恢复到一个空目录
& $node scripts/memory.mjs backup restore D:\tmp\bk\drill.fmb D:\tmp\restored

# 2.5 验恢复出来的库（这条以前是假的，v0.67.1 起才是真的）
& $node scripts/memory.mjs verify --dir D:\tmp\restored
```

**期望**：

```
库：D:\tmp\restored
  档案 6 个文件 · 链完整
```

```powershell
# 2.6 内容比对（这一步最硬）
& $node scripts/memory.mjs status --dir D:\tmp\restored
fc.exe /b <真库>\00_core\soul.md D:\tmp\restored\00_core\soul.md
```

| 检查 | 期望 |
|---|---|
| `档案：N 条` | 与真库一致 |
| `fc.exe` | `no differences encountered`（或中文等价提示） |
| 检索还能用 | `& $node scripts/memory.mjs search --dir D:\tmp\restored 关节` 有输出 |

**2.7 把靶子删掉**（验证"删库"这一步本身）：

```powershell
Remove-Item -Recurse -Force D:\tmp\fm-drill
# 再从 drill.fmb 恢复一次，确认"删了还能救回来"
& $node scripts/memory.mjs backup restore D:\tmp\bk\drill.fmb D:\tmp\fm-drill
& $node scripts/memory.mjs verify --dir D:\tmp\fm-drill
```

**到这一步还绿，才说明这条路是通的。**

---

## 3. 真做：导出 → 删库 → 恢复

### 3.1 导出（加密）

```powershell
# 3.1.1 口令：选一个你真能记住的（但别用生日/手机号）
$env:FISH_MEMORY_BACKUP_PASSPHRASE = "你选的口令"
```

```powershell
# 3.1.2 导出到今天日期命名的文件
$stamp = Get-Date -Format "yyyyMMdd"
& $node scripts/memory.mjs backup export --dir <真库> --out "D:\网盘\fish-memory-$stamp.fmb" --encrypt
```

**把输出里的 `sha256` 抄下来**（记事本/密码管理器）。远端校验要用它：

```
sha256 <这串>
```

> **口令别存进这个库**（`00_core` / `20_state` / `40_pending`）。
> 存进去等于把钥匙和锁放一个包里。

### 3.2 远端校验（**同步盘传上去之后**）

```powershell
# 等网盘同步完（看客户端显示"已同步"），然后验远端那份
& $node scripts/memory.mjs backup verify "D:\网盘\fish-memory-$stamp.fmb" --expect-sha256 <刚才抄的sha256>
```

**三种结果，三种处理**：

| 输出 | 含义 | 怎么办 |
|---|---|---|
| `✓ sha256 与本地记录一致` | 远端文件完整 | 继续 §3.3 |
| `✗ 远端文件与本地记录不一致` | 传了一半，或被改名 | **别删库**，重新导出/重传 |
| `认证失败` | 口令错了，或文件被改动 | **别删库**，先查清哪边错 |

**只在第一条出现时，才允许往下走。**

### 3.3 删库

> ⚠️ **删之前再做一次确认**：`backup verify` 刚过、`sha256` 对得上、口令你记得住。

```powershell
# 3.3.1 先改名，不直接删（给自己一条退路）
Rename-Item <真库> "<真库>.to-delete-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

# 3.3.2 确认 DSH 里"她"不见了（这一步会看到空库表现）
& $node scripts/memory.mjs status
#   期望：库不存在 / 记忆点 0 / 档案 0
```

**改名而不是 `Remove-Item`**：万一恢复失败，你还能改回来。等恢复成功、用了一两天，再删那个 `.to-delete-*`。

### 3.4 恢复

```powershell
# 3.4.1 恢复到原路径
& $node scripts/memory.mjs backup restore "D:\网盘\fish-memory-$stamp.fmb" <真库>
#   加密包会读 FISH_MEMORY_BACKUP_PASSPHRASE 或 --key-file

# 3.4.2 验库
& $node scripts/memory.mjs verify --dir <真库>

# 3.4.3 看规模
& $node scripts/memory.mjs status --dir <真库>
```

**期望**：

```
✓ 恢复完成：N 个文件 → <真库>
库：<真库>
  档案 N 个文件 · 链完整
记忆点：N（active N / merged 0 / fixture 0）
```

### 3.5 重启 DSH，确认"她还在"

1. 重启 DSH（让插件重新读库）。
2. 新开一个会话，问她一句**只有你们之间才有的事**（比如一个约定、一个外号）。
3. `& $node scripts/memory.mjs today` —— 看心情、聊天数、悬着的事是不是回来的。

**这一条才算"救回来了"**：不是文件对得上，是**她还记得**。

---

## 4. 出问题怎么退

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `认证失败` | 口令错 / 文件被改 | 换对口令；文件真被改过就换一份备份 |
| `档案链校验失败，拒绝恢复：xxx.jsonl: prev 对不上` | **包里的库本身链是坏的** | 换更早的一份备份；别硬恢复 |
| `目标目录非空` | 目录里还有东西 | 要么清空，要么加 `--force`（旧库会被挪到 `*.old-<pid>`，**不是删**） |
| 恢复成功但 `status` 显示 0 条 | 恢复到错目录了 | 检查 `<真库>` 路径，`status` 第一行就是它 |
| `包里缺 00_core/` | 导出的不是记忆库目录 | 确认导出的 `--dir` 指向库根（含 `00_core` 那一层） |

**任何一步失败，第一件事是停止，不要去"手动拼"**——拼出来的库 hash 链是断的，`verify` 会永远红。

---

## 5. 备份的节奏（3-2-1）

| 层 | 放哪 | 多久一次 | 命令 |
|---|---|---|---|
| **本地** | 库同盘的 `fish-memory-backups/` | 每天自动（插件自己会做，保留 7 份） | 无需手动 |
| **异地** | 网盘同步目录 | 每天一次 | §3.1 的 `backup export` |
| **离线** | U 盘/移动硬盘 | 每月 1 号 | 同一条命令，`--out` 指到 U 盘 |

每月检查一次：

```powershell
& $node scripts/memory.mjs backup list --dir "D:\网盘" --check
#   ✓ 最新一份 N 小时前，头部可读
#   或 ✗ 最新一份是 N 小时前（超过 48h 没备份了）
```

清理旧包（**只删自己命名的 `fish-memory-YYYYMMDD.fmb`，不碰别的文件**）：

```powershell
& $node scripts/memory.mjs backup prune --dir "D:\网盘" --keep 7 --monthly 6
#   先看它要删什么：加 --dry
```

---

## 6. 三条不要做

| 不要 | 为什么 |
|---|---|
| **把库目录直接放进同步盘** | 同步粒度是文件不是事务；`prune` 的删除会被同步成"用户删了"，档案链会分叉 |
| **只 `verify` 不 `restore`** | `verify` 验的是"包完整、链连得起来"；**能不能真的当库用，只有 restore 能回答** |
| **用设备指纹/自动派生口令** | 换机器 = 永久丢。这是她的记忆，不是配置文件 |

---

## 7. 一张速查卡（贴在你桌面）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:FISH_MEMORY_BACKUP_PASSPHRASE = "<口令>"
$stamp = Get-Date -Format "yyyyMMdd"

# 导出
& $node scripts/memory.mjs backup export --dir <真库> --out "D:\网盘\fish-memory-$stamp.fmb" --encrypt
# 验本地
& $node scripts/memory.mjs backup verify "D:\网盘\fish-memory-$stamp.fmb"
# 验远端（传完之后）
& $node scripts/memory.mjs backup verify "D:\网盘\fish-memory-$stamp.fmb" --expect-sha256 <抄下来的sha256>
# 恢复
& $node scripts/memory.mjs backup restore "D:\网盘\fish-memory-$stamp.fmb" <真库>
& $node scripts/memory.mjs verify --dir <真库>
```

---

## 8. 你现在这一版能做什么、不能做什么

| 能做 | 不能做 |
|---|---|
| 单文件、可加密、可验链、可恢复 | 自动上传（要你自己拖进网盘目录） |
| `verify --expect-sha256` 校远端 | 自动增量（每天全量，几十到几百 KB） |
| `list --check` 看"最新一份还新吗" | 云端 API（百度/阿里） |
| `prune` 保留 7 天 + 每月 1 号 | 加密包里放"恢复码"（口令丢了就是丢了） |

**最后一句**：这份手册的价值不在"步骤全"，在**§2 的演练**。
真出事那天，你需要的不是读文档，是**肌肉记忆**。
