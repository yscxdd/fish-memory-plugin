# 发版与维护（给维护者）

> 这份是"改了代码之后怎么让它真的生效"的仪式清单。这套东西最贵的教训就是：
> **改了源码 ≠ 生效**（v0.6.1 实测四组）。所以每一步都要能留下证据。

## 0. 一次改动的完整生命周期

```powershell
cd fish-memory-plugin

node --test                        # 1) 单测：全绿（当前 227）
node scripts/memory.mjs verify     # 2) 包自检：文件齐、无 BOM
node scripts/memory.mjs hostcheck  # 3) 宿主口子：17 个都在、lib/ 没越权
node scripts/memory.mjs gold       # 4) 金标：20/20、负例 0、边际 ≥0.68

node scripts/inject-diff.mjs --capture        # 5) 若动了注入相关：先拍"她读到什么"
# …改…
node scripts/inject-diff.mjs --compare        # 6) 逐段对比：少了哪一段、哪层核心被裁

node scripts/memory.mjs vault --dir ../fish-memory   # 7) 派生视图（可选）
node scripts/sync.mjs                          # 8) 拷 lib/ 到 profile
# 9) 插件管理器里把 fish-memory 关一次再开（或完全退出 DSH）
node scripts/selfcheck.mjs                     # 10) 12 个闸门；看「运行时版本」= 一致
```

**第 10 步是最容易漏的**：`sync` 只保证磁盘一致，不保证进程重载。`selfcheck` 的「运行时版本」比的是 **`lib/` 指纹**（不是版本号）——它显示"进程里的 lib 与磁盘一致"才算真的生效。

## 1. 版本号怎么定

| 改了什么 | 版本 | 例子 |
|---|---|---|
| 只改文档/仓库脚手架 | 不动 | 加 LICENSE、CI、issue 模板 |
| 修 bug / 加一个字段 / 加一个命令 | `0.x.+1` | v0.14.0 → v0.14.1 |
| schema 或行为不兼容 | `0.+1.0` | 改记忆点字段语义、改注入结构 |

一个版本要同步改这几处（漏一处就是"两个版本"）：

1. `package.json` 的 `version`
2. `README.md` 标题里的版本
3. `CHANGELOG` 的表格 + 新增一节（写清"为什么"和"不良后果"）
4. 契约（如果动了约定/字段/不变量）
5. 交接文档（如果换了人接手）

## 2. 发版后要确认的东西

```powershell
node scripts/selfcheck.mjs     # 12 个闸门，退出码 0
node scripts/memory.mjs check --dir ../fish-memory
node scripts/memory.mjs audit --dir ../fish-memory
```

- 「运行时版本」显示 `进程里的 lib 与磁盘一致（lib XXXXXXXX，进程 vX.Y.Z）`
- `档案完整性` 是 `改过 0 · 丢了 0 · 坏链 0`

## 3. 绝对不要做的事

| 不要 | 为什么 |
|---|---|
| 在 `10_archive/*.jsonl` 里改/删行（除 `memory erase`） | 那是真相层；改了就毁证。`erase` 也必须重算链 + 同步备份 + 重写清单 |
| 原地改记忆点来"更新事实" | 用 `invalid_at`（加新点 + 标旧的失效）。原地改会留下"档案 A / 点 B"的漂移 |
| 提交 `fish-memory/` 或 `fish-memory-backups/` | 真库里有逐字对话。`.gitignore` 已挡，但仓库根别设错 |
| 在插件目录里跑 `npm install` 之类引入依赖 | 零依赖是卖点，也是迁移能力（换机器只拷一个目录） |
| 给记忆内容加"自动改写/自动合并" | 契约 §11.5：明确不做。要推翻先改那节并给证据 |
| 把 `debug` 日志里塞 query 原文 | 日志会随库被云盘带走；v0.14.1 起只记库名 |

## 4. 换机器 / 迁移

```powershell
# 旧机器
node scripts/memory.mjs pack D:\backup\fish-memory-YYYYMMDD.zip --dir ../fish-memory
# 新机器
node scripts/memory.mjs init <新库目录>
node scripts/memory.mjs unpack D:\backup\fish-memory-YYYYMMDD.zip <新库目录> --force
node scripts/memory.mjs audit --dir <新库目录>
```

`pack` **包含** `00_core / 10_archive / 15_self / 20_state / 30_points / 35_ability / 40_pending / 50_log`，**排除** `20_index`（可重建）、`_samples`、`_debug`。
**备份是明文**：进网盘前请加密（`7z a -p …` / Cryptomator / VeraCrypt）。

## 5. 什么时候该停下来问人

- 要改 `00_core/`（她的身份/规则）→ 先问，且 `core_changelog` 一条 + `soul_guard` 7 天 ≤2 条
- 要改"什么算记忆"/"遗忘怎么算"→ 那是语义层，先写设计说明
- 要引入依赖 / 网络 / 模型调用 → 先确认预算与隐私影响

## 6. 仓库卫生

**上传/提交前先跑自检**（它会挡住"把记忆库带上去"这类最坏的错，顺序是提交前最后一道）：

```powershell
node scripts/preflight-open.mjs      # 或 npm run preflight
```

它查五件事，任何一件不对就退 1 并说怎么修：必需文件在不在、有没有把记忆库/备份/日志带进来、有没有 zip 之类的打包产物、文本里有没有个人路径或用户名（`C:\Users\<用户名>` 这种**占位符不算**）、有没有 >5 MB 的大文件。

- 提交前：`node scripts/memory.mjs privacy --dir ../fish-memory` 应显示"不在 git 仓库里"
- 别提交 `*.zip`、`.inject-baseline.json`、`node_modules/`（`.gitignore` 已挡）
- CI 跑 `npm test` + `verify` + `hostcheck` + `gold`（见 `.github/workflows/ci.yml`），四步都过才合

## 7. 第一次上传（完全没用过 git 的人看这里）

`git` 没装也可以用 **GitHub Desktop**（图形界面，点鼠标）：

```powershell
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements          # 想用命令行就装这个
winget install --id GitHub.GitHubDesktop -e --accept-source-agreements --accept-package-agreements   # 想点鼠标就装这个
```

装完打开 GitHub Desktop → 登录 → `File → Add Local Repository` → 选**插件目录本身**（不是上一级）→
它会提示"这个目录还不是仓库"，点 `create a repository` → `Publish repository`。
详细到每一步点哪里，见仓库根目录的 `docs/发布到GitHub.md`。

