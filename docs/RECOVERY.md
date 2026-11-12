# 升级 / 故障时的恢复手册（v0.86.0）

> 这份手册回答一个问题：**DSH 升级、插件丢失、库损坏时，她的记忆还在不在、怎么拿回来。**
> 每一条都是跑过的命令，不是设想。

---

## 0. 先分清三种"消失"

| 会消失的东西 | 存在哪 | DSH 升级会不会动它 |
|---|---|---|
| **她的记忆**（档案 + 记忆点 + 核心层） | `workspace\fish-memory\` | **不会**。它是普通目录，跟 DSH 安装位置无关 |
| **DSH 的会话列表**（界面上那些聊天） | `%USERPROFILE%\.dsh\sessions` | 可能。那是 DSH 自己的数据 |
| **插件加载** | `profiles\desktop\package.json` 里的一行 `link:` | **最可能被升级/插件操作弄丢** |

**关键**：插件会双向记档，所以只要聊天时插件在跑，`10_archive` 里就有一份**逐字副本**。
她不会因为 DSH 界面被清而失忆——记忆从来不在 DSH 里。

---

## 1. 一秒钟判断"她还好吗"

```powershell
cd <工作区>\fish-memory-plugin
node scripts/doctor.mjs
```

输出长这样（五条全 ✓ 才算好）：

```
  ✓ profile 声明：link: 指向本仓库（…/fish-memory-plugin）
  ✓ 装进去的那份：v0.86.0 · …\node_modules\dsh-fish-memory\lib\index.js
  ✓ 记忆库：core 7 个 · 档案 2 条 · 链完整
  ✓ 最近备份：最近一份 fish-memory-2026-11-12 · 0 小时前 · 52 个文件
  ! 备份位置：备份和库在同一个盘（d:）…
  ✓ 体检通过：她去接话时读得到记忆
```

**任何一条 ✗** → 工作区根会出现 `⚠️-fish-memory-体检失败.md`（他打开就能看见，不用记得去查）。

---

## 2. DSH 升级之后（每次升级都做一次）

```powershell
node scripts/doctor.mjs --drill     # 五条 + 真的从备份恢复一次并验链
node scripts/memory.mjs hostcheck   # 17 个宿主口子还在不在
node --test                         # 全量测试
```

三件都过 → 可以继续聊。

**只跑 doctor 不跑 hostcheck 也行**，但 hostcheck 会逐条说明"这个口子坏了会怎样"——升级改 API 时它比 doctor 更早报警。

---

## 3. 插件"消失"了（她有记忆但不再被加载）

**症状**：对话正常，但她什么都不记得；`doctor` 第一/二条 ✗。

```powershell
node scripts/doctor.mjs --fix
```

它只做一件事：把 `dependencencies["dsh-fish-memory"] = "link:…/fish-memory-plugin"` 补回去，
**改之前先备份 profile**（`package.json.bak-doctor-<时间>`）。补完重启 DSH。

> 为什么会有这一步：`profiles/desktop/package.json.bak-fish-missing-20261103-235500` 说明 11 月 3 日它**真的缺过一回**。
> 而它现在也不在 `dsh.profile.bundles` 清单里，只靠这行 `dependencies` 挂着。

---

## 4. 库坏了 / 想回到昨天

```powershell
# 看有哪些备份
dir ..\fish-memory-backups

# 恢复到临时目录先验（不要直接覆盖活库）
node scripts/memory.mjs unpack ..\fish-memory-backups\fish-memory-2026-11-12 $env:TEMP\restore-check
node scripts/memory.mjs verify --dir $env:TEMP\restore-check

# 验过没问题，再决定要不要覆盖（覆盖前先把活库挪开，别删）
```

**恢复命令是 `unpack`，不是 `backup restore`**（后者只吃 `.fmb` 单文件包，会报 `EISDIR`）。

---

## 5. 备份的边界（必须知道的坏消息）

- 自动备份**每天一份**，默认落 `workspace\fish-memory-backups\`，保留份数由 `backupKeep` 控制（默认 7）。
- **它和库在同一个盘**。这块盘坏了两份一起没。
- 想更稳：把 `FISH_MEMORY_BACKUP` 指到**另一块物理盘**，或每周手动把 `fish-memory-backups` 复制到网盘/U 盘。
- `doctor` 会一直提示这条，但**不判失败**——挪到哪块盘是你的决定，不是 bug。

---

## 6. 一条命令的定期体检（可选）

Windows 任务计划程序，每天开机后跑一次：

```powershell
node scripts/doctor.mjs --quiet --drill
```

失败时退出码 1，且工作区根会出现告警文件。**这是唯一在"插件没加载"情况下也能报警的机制**——
因为它在插件外面。

---

## 附：这份手册对应的事实

| 说法 | 证据 |
|---|---|
| 插件靠 profile 里一行 `link:` 挂着 | `profiles/desktop/package.json` |
| 它丢过一次 | `package.json.bak-fish-missing-20261103-235500`（11-03） |
| 备份能恢复 | `unpack` 实测 52/52 校验通过、链完整 |
| 宿主已升过一版 | `desktop-runtime.json`：宿主 **0.2.2-rc.1**，插件 `compat.verified` **0.2.1-rc.5**，仍在跑 |
