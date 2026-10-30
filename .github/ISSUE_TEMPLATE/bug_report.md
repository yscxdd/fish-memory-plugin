---
name: Bug 报告
about: 报一个能复现的问题（请先跑一遍下面的自查）
title: "[bug] "
labels: bug
---

## 先自查（不回填的话大概率会被问回来）

```
node --version                          # 版本
node -e "console.log(require('./package.json').version)"   # 插件版本
node scripts/memory.mjs verify          # 包自检输出
node scripts/memory.mjs hostcheck       # 宿主口子输出
```

## 现象

<!-- 发生了什么。如果是"她失忆了/没注入"，说清是哪种：整块没注入、注入但内容旧、注入但触发报错 -->

## 复现步骤

1.
2.
3.

## 相关日志（记得脱敏）

<!-- 50_log/host.log 最后一行、50_log/retrieval.log 最后一行。
     把 query 换成 ...，不要贴真实的对话内容。 -->

```json

```

## 环境

- OS：
- DSH 版本（`host.log` 里的 `plugin` / `verifiedAgainst`）：
- 是否重启过插件（`selfcheck` 的「运行时版本」那行显示什么）：

## 你猜的原因（可选）

<!-- 有就写，没有就删掉这一节。猜错也没关系。 -->
