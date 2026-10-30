## 这个 PR 做了什么

<!-- 一句话。然后写"为什么"——diff 已经说明改了什么。 -->

## 自查（勾掉不能做的）

- [ ] `npm test` 全绿（新增/修改的测试在里面）
- [ ] `node scripts/memory.mjs verify` 通过（无 BOM、必需文件齐）
- [ ] `node scripts/memory.mjs hostcheck` 通过（没在 `lib/host.js` 之外写 `ctx.`）
- [ ] `node scripts/memory.mjs gold` ≥ 16/20（动了检索才需要，但跑了更好）
- [ ] 修 bug 的测试**先红后绿**（能在改之前复现）

## 如果改的是"她读到什么"（阈值/权重/预算/注入顺序/模式分流）

贴 `inject-diff` 的对比（没贴的话这类 PR 没法合并——这类改动没有日志会告发）：

```powershell
node scripts/inject-diff.mjs --capture
# 改…
node scripts/inject-diff.mjs --compare
```

```
（粘贴输出；重点是"哪些查询变了、变了哪一段、有没有核心层被裁"）
```

## 有没有碰硬规矩

- [ ] 没有改写 `10_archive/*.jsonl`（除 `memory erase` 的授权删除流程）
- [ ] 新增的注入内容过了 `sanitizeForPrompt()`
- [ ] 没有引入运行时依赖 / telemetry / pickle / 自动改写记忆
- [ ] schema 改动是纯加法（新字段可缺省），带迁移与测试
- [ ] 没有提交 `fish-memory/`、`*.zip`、`.inject-baseline.json`
