# 第一次上传到 GitHub（不用懂 git）

> 这份是给**完全没用过 git** 的人写的。全程点鼠标，只有两条命令。
> 每一步都写了"你应该看到什么"，看到了才做下一步。

---

## 第 0 步：先自检（1 条命令）

在文件管理器里打开 `fish-memory-plugin` 文件夹 → 地址栏输入 `powershell` 回车（会在这个目录打开命令行），粘贴：

```powershell
node scripts/preflight-open.mjs
```

**你应该看到**：

```
仓库目录：...\fish-memory-plugin
文件数：92 · 合计 0.86 MB

✓ 可以上传：没有记忆库、没有打包产物、文本里没有个人路径
```

如果看到 `✗`，**停下**，照着它写的修（最常见的是"你在上一级目录建仓库"，那会把整库真对话传上去）。

---

## 第 1 步：装 GitHub Desktop（1 条命令）

同一窗口粘：

```powershell
winget install --id GitHub.GitHubDesktop -e --accept-source-agreements --accept-package-agreements
```

装完在开始菜单搜 **GitHub Desktop** 打开。（如果没有 winget，去 https://desktop.github.com 下载安装。）

**第一次打开它会要你登录** → 点 `Sign in to GitHub.com` → 浏览器会弹出来 → 点 `Authorize desktop` → 回到窗口。

**你应该看到**：左上角显示你的头像和用户名。

---

## 第 2 步：把这个文件夹添加进来

菜单 `File` → `Add Local Repository…`

在弹出的选择框里，**定位到**：

```
<你的工作区>\fish-memory-plugin
```

（选的是 **fish-memory-plugin 这一层**，不是上一层的 default-workspace。）

点 `Add Repository`。

**这时它大概率会说**：`This directory does not appear to be a Git repository. Would you like to create a repository here instead?`

→ 点 **`create a repository`**。

---

## 第 3 步：确认创建参数

窗口里会出现 Create a New Repository：

- **Name**：`fish-memory-plugin`（默认应该就是这个）
- **Local path**：保持它自动填的（指向上一级目录 `default-workspace`）
- 其余（Description、README、.gitignore、License）**全部留空/不勾**——这些文件我们已经有了，勾了会覆盖。

点 **`Create Repository`**。

**你应该看到**：左边栏出现 `fish-memory-plugin`，中间 `Changes` 标签下是一长串文件，顶部写着 **92 changed files**。

---

## 第 4 步：**核对文件列表**（这一步最重要）

在 `Changes` 的列表里，确认**没有**下面这些名字：

- ❌ `fish-memory`
- ❌ `fish-memory-backups`
- ❌ `20_index`、`50_log`
- ❌ 任何 `.zip`
- ❌ `_refs`

如果出现了任何一个，**立刻停**：说明你选错了目录（选成上一级了）。
关掉 GitHub Desktop → 把那个错误的仓库文件夹删掉（`default-workspace\.git` 那个隐藏文件夹）→ 回到第 2 步重新选。

**你应该看到的**是这些：`lib` `scripts` `test` `samples` `docs` `.github` `LICENSE` `README.md` `CONTRIBUTING.md` `SECURITY.md` `CODE_OF_CONDUCT.md` `CHANGELOG.md` `.gitignore` `package.json` `cordis.patch.yml`。

---

## 第 5 步：提交（写一句话）

左下角 `Summary` 框里写：

```
feat: fish-memory-plugin v0.14.1 — file-based long-term memory for AI companions
```

点蓝色按钮 **`Commit to main`**。

**你应该看到**：左边 `Changes` 变成 `0`，`History` 里多了一条记录。

---

## 第 6 步：发布到 GitHub

右上角点 **`Publish repository`**。

弹窗里：

- **Name**：`fish-memory-plugin`
- **Description**：空白没关系（下一步在网页填）
- **`Keep this code private`**：**先勾上**（第一次先私有，确认没漏东西再改公开，更稳）
- 点 **`Publish repository`**

**你应该看到**：右上角出现 `Push`/`Fetch origin`（说明已经连上远程仓库了）。

---

## 第 7 步：去网页上检查，然后公开

1. 浏览器打开 `https://github.com/<你的用户名>/fish-memory-plugin`
2. 确认文件都在、**没有** `fish-memory/`
3. 点 `Actions` 标签 → 应该看到一个叫 `ci` 的工作流在跑；等 1–2 分钟变绿 ✓（红的话把日志发我）
4. 没问题后公开：`Settings` → 最下面 `Danger Zone` → `Change repository visibility` → `Make public` → 按提示输入仓库名确认
5. 填介绍：仓库首页右上 `⚙️`（About 旁边）→ Description 粘这句：
   ```
   给 AI 伴侣的零依赖记忆插件：记忆是你能直接读的 markdown，对话是只追加的 JSONL；注入有预算，每条记忆都能追到原话，进模型前一律净化。
   ```
   → Topics 依次加：`ai-memory` `long-term-memory` `markdown` `prompt-injection` `deepseek-harness` → `Save changes`
6. 开安全上报：`Settings` → `Code security and analysis` → 找到 **Private vulnerability reporting** → `Enable`

---

## 第 8 步：以后改了怎么更新（就用这个桌面应用）

1. 改完代码，先跑一次 `node scripts/preflight-open.mjs`（绿了再传）
2. GitHub Desktop → `Changes` 会列出你改过的文件 → 写一句 Summary → `Commit to main`
3. 点右上 `Push origin`
4. 网页上刷新，改动就到了；CI 会自动再跑一遍

---

## 传错了怎么办（别慌）

如果发现自己把记忆库传上去了：

1. **先删仓库**：网页 `Settings` → 最下面 `Danger Zone` → `Delete this repository` → 按提示确认
2. 本地也要删：`default-workspace\.git` 这个隐藏文件夹（这是误建的仓库）
3. 回到第 0 步自检，重新来

**为什么必须删掉重建**：GitHub 会缓存已推送的历史，就算你后来删了文件，别人仍能从历史里翻出来。所以"传了隐私就删仓库"，不要试图补救。

---

## 卡住了看这里

| 现象 | 原因 / 怎么办 |
|---|---|
| 开始菜单搜不到 GitHub Desktop | 用 `winget list GitHub` 看装没装；没装成功就重启一次，或去官网下 exe |
| `Add Local Repository` 是灰色的 | 先登录账号 |
| 提示 "not a Git repository" | 正常，点 `create a repository` |
| 中间列了 1000+ 文件 | 你选成上一级目录了，删掉重来（见第 4 步） |
| `Publish repository` 报错 403/401 | 账号没权限或没登录成功；退出登录重登 |
| Actions 里 CI 红灯 | 把红色那一段日志发给我，我按报错改 |
| 公开后想改回私有 | `Settings` → Danger Zone → Change visibility → Make private |

---

## 附：如果你更想用命令行

装 git（一条命令）：

```powershell
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
```

**关掉再重开** PowerShell（让它认到新装的 git），然后在 `fish-memory-plugin` 目录里：

```powershell
node scripts/preflight-open.mjs                 # 先自检，绿了再继续
git init
git add -A
git status --porcelain | Select-String "fish-memory|\.zip|50_log"   # 必须没有任何输出
git commit -m "feat: fish-memory-plugin v0.14.1"
git branch -M main
git remote add origin https://github.com/<你的用户名>/fish-memory-plugin.git
git push -u origin main
```

推送时会弹出浏览器让你授权（Git Credential Manager 自动处理），点同意即可。
