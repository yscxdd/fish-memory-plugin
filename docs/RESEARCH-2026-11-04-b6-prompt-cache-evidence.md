# B6 宿主侧证据：DSH 有没有前缀缓存，命中率能不能读到

> 2026-11-04。为 v0.49.0 之后的决策写。
> 结论先行：**有，而且已经在 99.5% 上跑；B6 的收益上限是每千轮约 4 分钱，所以不做。**
> 本文所有数字都可用 `scripts/cache-audit.mjs` 复现（见文末）。

---

## 0. 一句话结论

| 问题 | 答案 | 依据 |
|---|---|---|
| DSH 有前缀缓存吗 | **有**，DeepSeek 侧自动前缀缓存，64 token 一块，只匹配前缀 | `dsh-llm-deepseek` 把 `cache_read_input_tokens` 映射进 `usage.cacheReadTokens`；DeepSeek 官方 Context Caching 文档 |
| 命中率能读出来吗 | **能，但不在 `token.log`**，在会话日志 `assistant/message.data.usage` 里 | 本机 13 个会话全部实测（§2） |
| 记忆块每轮变会把缓存打掉吗 | **不会**。`deepseek-flash` 声明 `systemPromptUpdate: in-history`，改提示词是**追加到历史尾部**，不是重写开头 | `dsh-llm-deepseek/lib/index.js:24`、`dsh-agent-loop/lib/index.js:272` |
| B6 第一步（块字节稳定性）值得做吗 | **数据是 4/4**（连续 5 轮窗口内相邻轮次逐字相同），但这是因为库是空的 | §4 |
| 该做 B6 吗 | **不做**。见 §5 的算术 | — |

---

## 1. 怎么读出来的（方法）

DSH 的会话日志是 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，zstd 压缩。
解压后每行一个事件，其中 `assistant/message` 带 `data.usage`：

```json
{"type":"assistant/message","data":{"usage":{
  "inputTokens":9695,"outputTokens":152,
  "cacheReadTokens":512,"cacheWriteTokens":0,"totalTokens":10359}}}
```

- `inputTokens` 是**未缓存**输入（`dsh-token-meter` 里 `bucketsFrom()` 把它映射成 `uncachedInputTokens`）。
- `cacheWriteTokens` 实测恒为 0 —— DeepSeek 不单独计缓存写，只在命中/未命中之间分价。
- 命中率 = `cacheReadTokens / (cacheReadTokens + inputTokens)`。**不要对逐轮比率取平均**，要先把分子分母各自求和再除，否则短请求会带偏。

请求头里能看到路由：`request/header.data.header.config = { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high", maxTokens: 256000 }`。

> `50_log/token.log` 里**没有**这些字段，也不该有：它记的是"插件注入了多少 token"，不是"模型侧缓存了多少"。这两件事以前被混为一谈，是 B6 立项时的信息缺口。

---

## 2. 实测数字

13 个本机会话，按 `cacheRead / (cacheRead + input)` 求和口径：

| 会话 | 模型 | 轮次 | 命中率 | 零缓存轮 |
|---|---|---|---|---|
| 6b34f3cb | deepseek-flash | 2698 | **99.5%** | 0 |
| 0c490c24 | deepseek-flash | 862 | 99.4% | 0 |
| ecc98763 | deepseek-flash | 684 | 99.6% | 0 |
| 17e11e10 | deepseek-flash | 433 | 99.7% | 0 |
| 7565ca34 | deepseek-flash | 473 | 99.3% | 1 |
| b7ed1c9f | deepseek-v4.1-flash-free | 359 | 97.9% | 4 |
| 53206fd7 | deepseek-flash | 158 | 99.4% | 0 |
| 84404444 | deepseek-flash | 152 | 99.2% | 1 |
| 06af4d86 | deepseek-flash | 50 | 97.2% | 0 |
| 3b0fad5e | deepseek-flash | 22 | 94.0% | 0 |
| 29e85cdc | deepseek-flash | 21 | 93.6% | 0 |
| 1aecef3c | qwen3.8-flash-next-iq2_xs | 9 | 74.1% | 2 |

短会话（20 轮左右）93–94%，长会话 99.5%+。差别全在开头几轮冷启动：第一轮 `cacheRead=512`，第三轮就到 15360，之后每轮只丢最后一个不满 64 token 的块。

同一个会话（2698 轮）的另外三个数字：

- 每轮提示词规模：p10 **219k** / p50 **432k** / p90 **678k** tok
- 每轮未命中输入：p50 **248** tok / p90 **829** tok
- 记忆注入块：**447** tok（`token.log` 里 519–554 的波动是 `core` 是否包含 `user.md` 的差别）

轻量会话（21–22 轮）提示词 p50 是 38k–44k，注入块占 1.1%。

---

## 3. 机制：为什么记忆块变了也没掉

`dsh-llm-deepseek` 的默认目录条目（`lib/index.js:24`）声明：

```js
systemPromptUpdate: "in-history"
```

`dsh-agent-loop` 的 `project()`（`lib/index.js:272`）据此分两路：

```js
if (!input.inHistory || input.startsSeries || rendered.length === 0) {
  // 重写 head、清掉后续 system 节点
}
if (latest.text === rendered) return []          // 没变就不动
return [{ message: createSystemMessage(rendered),   // 变了：整条追加到历史尾部
          intent: { surfaceOp: "append" } }]
```

也就是说：**变动落在尾部，前面（工具定义 + 原系统提示 + 全部历史）保持字节不变**，缓存前缀继续命中。
官方的说法在 `dsh-llm-deepseek/README.zh.md` §KV Cache 影响：

> 在声明了 `systemPromptUpdate: in-history` 的目录条目上，同一请求序列延续期间的系统提示词变化会追加到已缓存历史之后，因此直到该历史末尾的前缀仍可复用；工具 schema 变化仍会从第一个改变的 token 起阻止复用。

同一节还点名了会打断复用的东西：**换模型/换 provider（不同缓存域）、工具 schema 变化、图片 file_id 刷新**。记忆文本不在这个名单里。

这正好是上游一堆方案想手动达到的效果——"动态内容放最后"——宿主已经在协议层做了。B6 的第 3 步（"走 message"）是它的一个手工仿制品，而且更差。

---

## 4. B6 第一步的实测：连续 5 轮里有几轮块字节不变

方法：取真实会话里连续 80 条用户提问，逐条跑 `assemble()`，比相邻两轮的完整注入文本。

| 库 | body 非空轮次 | 相邻轮逐字相同 | 前缀重合率 p50 | 因变动丢的 token（64 块对齐） |
|---|---|---|---|---|
| 真实库（0 个 active 点） | 0 / 80 | **79 / 79** | 100% | 0 |
| 临时库（3 个点：台风天看海 / 楼下那家面 / 别夸她懂事） | 2 / 80 | 76 / 79 | 100% | 0 |

连续 5 轮窗口（76 个窗口）：**每个窗口内 4/4 对相邻轮次逐字相同**。

两个读数：

1. 验收标准"块字节不变 ≥3/5"**现在就是满分**，测不出任何改进空间——不是改得好，是库是空的。
2. 3 个点的库跑 80 条真实提问，body 只命中 2 次。陪伴型对话的检索命中本来就稀疏，所以即便库填满，body 的变化频率也远低于"每轮都变"的假设。

**未闭合的缺口（必须写明）**：本机没有任何一个会话是"库已填满 + 记忆块每轮变化"的状态，所以"变了之后命中率还稳在 99%"这句是**从机制推的，不是直接观测到的**。要直接证明，得先有真实点，跑 100 轮再看 `cacheReadTokens` 有没有塌。这件事等 P0-1（待审队列）把库填起来之后顺手就能做，成本为零。

---

## 5. 为什么不做了

B6 能省的东西，上限就是"记忆块从 0.10% 命中变成 0% 命中"的差额：

```
注入块                    447 tok
每轮提示词 p50        432,444 tok        → 注入占 0.10%
当前未命中输入 p50        248 tok
```

V4-Flash 价格（深求官方价目表，非高峰）：缓存未命中 $0.14/M，命中 $0.0028/M。

```
447 tok 全按未命中 = $0.0000626 / 轮 ≈ ¥0.00045 / 轮
447 tok 全按命中   = $0.0000013 / 轮 ≈ ¥0.00001  / 轮
差额               ≈ ¥0.0004 / 轮  →  ¥4 / 万轮
```

**改动面**是 `render.js` 拆块 + `index.js` 传参 + `host.js` 探宿主能力 + 3~5 条测试 + 重跑全部闸门。**收益上限**是每一万轮四块钱，而且实际会更小——因为宿主已经在尾部追加，本来就没掉。

判断：这不是"性价比低"，是**算错了对象**。真正贵的是 43 万 token 的上下文本身，不是那 447 token 的注入块。要想降成本，方向是压缩历史 / 减小工具 schema / 早做上下文整理，不是挪一个 0.1% 的块。

---

## 6. 上游资料（这条结论不是孤证）

| 来源 | 说了什么 | 和我们的关系 |
|---|---|---|
| [DeepSeek Context Caching 官方文档](https://deepseek.apidog.io/context-caching-836444m0) | **64 token 一个存储单元**；只匹配前缀；"best-effort，不保证 100%"；usage 里 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 解释了实测里 `cacheRead` 全是 64 的倍数、每轮固定丢 63 token |
| [DeepSeek 价目表](https://api-docs.deepseek.com/quick_start/pricing) | V4-Flash：命中 $0.0028 / 未命中 $0.14（每 M） | §5 的算术用的就是这两个数 |
| [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 缓存是**前缀哈希**；「把断点放在每次请求都变的块上」被明列为**常见错误**——每轮都付写入费、永远读不到；写入 1.25×、读取 0.1×、约 9 次复用才回本 | B6 想解决的问题在 Anthropic 上确实存在；我们这边被 `in-history` 绕过了 |
| [Don't Break the Cache (arXiv 2601.06007)](https://arxiv.org/abs/2601.06007) | 500+ agent 会话实测：缓存省 41–80% 成本、TTFT 降 13–31%；**赢的策略是"动态内容放系统提示末尾、动态工具结果排除在缓存区外"**；朴素全上下文缓存反而可能变慢 | 我们的记忆块已经在末尾（宿主保证），等于已经用上最优策略 |
| [hkxiaoyao/cubeplex `prompt-cache-discipline.md`](https://github.com/hkxiaoyao/cubeplex/blob/main/backend/docs/prompt-cache-discipline.md) | 稳定前缀清单 + **禁止项**：时间戳、每轮 nonce、随机顺序、按轮变化的用户信息；记忆快照按轮冻结进用户消息元数据；有 e2e 缓存测试当回归闸门 | 和我们 `status` 块里有时刻字段是同一类风险；但我们的宿主把它们放在了尾部 |
| [Chevey339/kelivo issue #1202](https://github.com/Chevey339/kelivo/issues/1202) | 记忆快照就地改写历史 → 缓存大面积失效；建议**尾部追加注入**，"破坏范围压成记忆块自身大小" | 这就是 DSH 的 `in-history` 做法；他们得自己实现，我们白拿 |
| [MyPrototypeWhat/context-chef](https://github.com/MyPrototypeWhat/context-chef) | `memoryPlacement: 'before_history_tail'`：把易变记忆块挪到历史尾部；附带 `auditAnthropicCachePlacement()` 做静态检查 | 同类工具的存在说明这确实是真问题——**在有显式断点的 provider 上** |
| [mnemoverse: What Breaks Prompt Caching](https://mnemoverse.com/docs/library/prompt-cache-stable-prefix) | hermes-agent 的 Honcho 集成每轮重写 system prompt，cadence=1 时**100% 未命中、每次重算约 20K**；修法是把动态记忆挪到用户轮 | 反例的代价量级：20K 全价重算才值得修；我们是 447 tok 且不掉 |
| Claude Code `/usage` + `prompt_cache.last_miss_cause` | 官方把 `hit_ratio`、`last_miss_cause`（`system_prompt_changed` / `tools_changed` / `ttl_expired_5m`）做成产品字段 | 如果以后真要盯，抄这个形状；但现在我们连"掉没掉"都不用盯——99.5% 没有优化空间 |

一句话对照：**所有上游资料都在教"怎么把易变内容挪到尾部"，而 DSH 的 `in-history` 已经替我们做了。B6 是在给一个已经解决的问题写补丁。**

---

## 7. 什么情况下要回头做（触发条件，写死在这儿）

只有下面任意一条成立，才重新评估 B6：

1. 库填满后，连续 100 轮的真实会话里 `cacheReadTokens/(cacheRead+input)` **跌破 90%**，且 `system/message` 事件数接近轮次数（说明块真的每轮在变）。
2. 换成一个**没有** `systemPromptUpdate: in-history` 的模型/供应商（目录里 `systemPromptUpdate` 缺省即 `leading-only`）——那时改提示词就是重写开头，会真掉。
3. 宿主改成"一个 name 一块、按 order 拼前缀"，块边界才重新有意义。

在那之前，`inject = ['systemPrompt', ...]` 这条不动。

---

## 附：复现步骤

```bash
# 1) 找一个会话
ls ~/.dsh/sessions/*/*/session.v4.jsonl.zstd

# 2) 解压（Node 原生没有 zstd；装 fzstd 是最省事的纯 JS 方案）
npm i fzstd
node scripts/cache-audit.mjs --session <path-to>.zstd --fzstd ./node_modules/fzstd/umd/index.js

# 想看块字节稳定性，加 --block 并指定记忆库目录
node scripts/cache-audit.mjs --session <path-to>.zstd --fzstd ./node_modules/fzstd/umd/index.js \
  --block <你的记忆库目录>
```

`scripts/cache-audit.mjs` 是**只读**的：不解压到磁盘、不改任何库、不联网。
它故意放在 `scripts/` 而不是 `lib/` —— 它需要 zstd 解压，而 `lib/` 守着"零依赖"。

---

## 附：这次顺带确认的两件事

1. **`token.log` 不该记缓存字段**。插件拿不到模型侧 usage（`TokenMeasurement` 只有整包总数），硬塞会变成假数据。要看得去会话日志，或者等宿主开一个口子。这一点在 `lib/toklog.js` 的注释里已经写对了，只是 B6 立项时没照着做。
2. **`cacheWriteTokens` 恒为 0** 不是 bug。DeepSeek 侧只有"命中/未命中"两档计价，没有独立的写入桶；`dsh-llm-deepseek` 的 `updateUsage()` 兼容 Anthropic 线格式才保留这个字段。
