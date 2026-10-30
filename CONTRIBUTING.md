# 贡献指南

> 这是一个**有硬规矩**的记忆插件，不是普通工具库。大部分坑都踩过、写进了测试和契约。
> 动手前花 5 分钟看完这份，能省你半天。

## 先跑起来（30 秒）

```bash
node --version          # 需要 ≥ 18（CI 跑 20 / 22）
npm test                # 227 个单测，约 1 秒，不需要 DSH、不联网
node scripts/memory.mjs verify      # 包自检：必需文件、BOM、导出 apply
node scripts/memory.mjs hostcheck   # 宿主口子：17 个都在、lib/ 没越界访问 ctx
node scripts/memory.mjs gold        # 金标：20/20、负例 0、边际 ≥ 0.68
```

零依赖：**没有 `npm install` 这一步**，也不该有。`package.json` 里没有 `dependencies` 是刻意的（见契约 §11.5）。

## 目录怎么分工

| 目录 | 是什么 | 改它的风险 |
|---|---|---|
| `lib/host.js` | **唯一**允许写 `ctx.` 的地方。17 个宿主口子 + 降级自检 | 高：宿主版更只改这里，改完要 `hostcheck` |
| `lib/*.js` 其余 | 纯逻辑：检索 / 渲染 / 存储 / 遗忘 / 完整性 / vault | 中：改渲染=改"她读到什么" |
| `scripts/` | 离线 CLI（`memory.mjs`）与开发者工具（`selfcheck` / `inject-diff` / `sync`） | 低 |
| `test/` | `node:test`，零依赖 | 低 |
| `samples/` | **合成**演示记忆点（不是任何人的真实经历），只用于说明格式 | 低 |

## 六条硬规矩（PR 会被按这个看）

1. **只追加。** 不要改写 `10_archive/*.jsonl`（唯一例外是 `memory erase`，它必须重算 hash 链 + 同步备份 + 重写清单）。不要原地改记忆点——要改事实用 `invalid_at`（加新点 + 标旧的失效，两条都留）。
2. **所有"进模型"的出口必须过 `sanitizeForPrompt()`。** 现有出口：正文三级渲染、工作记忆、索引层、dormant 行、场景展开、`memory_recall` 回查、`digest` 原文包、自述块。新增出口忘了净化 = 记忆内容能伪造块边界（v0.7.0 实测过）。
3. **`lib/` 里只有 `host.js` 能写 `ctx.`。** 其他地方要用宿主能力，走 `host.js` 的封装；`hostcheck` 会静态扫出来。
4. **不加运行时依赖、不加 telemetry、不用 `pickle`、不做自动改记忆。** 这是契约 §11.5 的"明确不做"，推翻要先改那节并说明证据。
5. **schema 改动必须纯加法**：新字段可缺省（老文件没有 = 默认值），要带迁移入口与测试。改完跑一遍 `memory check` 与 `memory audit`。
6. **改"她读到什么"要附证据。** 动了阈值 / 权重 / 预算 / 注入顺序 / 模式分流，请贴 `scripts/inject-diff.mjs` 的对比（`--capture` 改前、`--compare` 改后）：证明了"哪些查询的注入变了、变了哪一段"。没贴的这类 PR 没法合并——这类改动没有日志会告发。

## 提交 PR 前自查

```bash
npm test                        # 全绿
node scripts/memory.mjs verify  # 无 BOM、文件齐
node scripts/memory.mjs hostcheck
node scripts/memory.mjs gold    # 别跌破 16/20
```

- 每个修复/功能配至少一个测试；**修 bug 的测试要先能复现 bug**（先红后绿）。
- 提交信息写"为什么"，不是"改了什么"（diff 已经说明改了什么）。
- **不要提交你的记忆库**（`fish-memory/`）。它在插件目录旁边，`.gitignore` 已挡，但仓库根别设错。提交前跑 `node scripts/memory.mjs privacy --dir ../fish-memory`，应显示"不在仓库里"。

## 想改检索/注入？先看这三份

- `docs/ARCHITECTURE.md` —— 一轮对话里，记忆是怎么被选中、装配、注入的（含预算与降级顺序）
- `docs/MAINTAINING.md` —— 发版与"改了要生效"的仪式（sync + 重启 + 运行时版本）
- `README.md` —— 每个版本为什么这么改（含踩过的坑）

## 报告问题

用 issue 模板。请附上：

- `node --version` 和 `package.json` 里的 `version`
- `node scripts/memory.mjs verify` 的输出
- 相关日志的**脱敏**片段：`50_log/host.log` 最后一行、`50_log/retrieval.log` 最后一行（把 `query` 换成 `...`）

安全问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。
