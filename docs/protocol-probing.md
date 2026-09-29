# 为什么不做协议探测

插件的既定策略是：OCG 已上线、但 Pi 尚未发布描述符的模型，**只报告、不猜测**。
本文记录"通过探测网关来自动推断描述符"这条路为什么走不通，以及替代方案。

结论先说：**探测得到的信号只有否定、没有肯定，能排除不能确认；而 `contextWindow` /
`maxTokens` 无论怎么探测都拿不到。** 同一批模型改用 `models.dev` 查表，命中率
13/14。

## 需要推断的东西

一个模型要能被 DSH 选中，描述符至少要有：

| 字段 | 用途 | 能否探测 |
|---|---|---|
| `api` | 决定请求打到哪个端点 | 部分（见下） |
| `contextWindow` | 上下文上限 | 否 |
| `maxTokens` | 单次输出上限 | 否 |
| `cost` | 计费，`model.cost.input` 被直接读取 | 否 |
| `input` | 是否接受图片 | 否 |
| `name` | 选择器显示 | 可从 id 推断 |

`baseUrl` 不需要推断，`OCG_BASE_URLS` 已经按协议固定。

## 难点一：上游根本不给能力信息

```
GET https://opencode.ai/zen/go/v1/models
→ 43 条，每条只有: id, object, created, owned_by
```

没有 `api`、没有 `contextWindow`、没有 `maxTokens`。`owned_by` 全部是
`opencode`，没有区分度。

## 难点二：错误信号是单向的

用**无效 token** 发请求（不产生推理费用）观察错误类型：

- `ModelError: Model X is not supported for format Y` → 确定不支持
- `AuthError: Invalid API key.` → **不知道**

`AuthError` 既可能是"格式检查通过、走到认证了"，也可能是"这个端点根本没做格式
检查"。两者的区别决定了探测能否成立，而它恰恰是不可见的。

交叉验证坐实了这一点 —— 用 pi.dev 已知的协议做对照：

| 模型 | pi.dev 声明 | chat/completions | responses | messages |
|---|---|---|---|---|
| `deepseek-v4-flash` | openai-completions | AuthError | AuthError | AuthError |
| `gpt-5.6-luna` | openai-responses | **AuthError** | AuthError | AuthError |
| `gpt-6-luna` | openai-responses | **AuthError** | AuthError | AuthError |
| `minimax-m3` | anthropic-messages | AuthError | **ModelError** | AuthError |
| `qwen3.8-flash` | anthropic-messages | AuthError | **ModelError** | AuthError |

`gpt-5.6-luna` 和 `gpt-6-luna` 被 pi.dev 声明为 `openai-responses`，但在
`chat/completions` 上同样返回 `AuthError` —— 网关并没有对每个端点都做格式匹配。
所以 `AuthError` 不能当作"该端点可用"的证据。

## 难点三：能排除，不能确认

待救的 14 个模型实测：

| 模型 | chat/completions | responses | messages |
|---|---|---|---|
| `minimax-m2.5` | AuthError | **ModelError** | AuthError |
| `kimi-k2.6` | AuthError | AuthError | AuthError |
| `kimi-k2.5` | AuthError | AuthError | AuthError |
| `glm-5.1` | AuthError | AuthError | AuthError |

`minimax-m2.5` 能排除掉 `responses`。其余三个**一个都排除不掉** —— 三个端点
全部 `AuthError`，无法在 `openai-completions` / `openai-responses` /
`anthropic-messages` 之间做三选一。

## 难点四：容量数字没有任何来源

即使 `api` 猜对了，`contextWindow` / `maxTokens` / `cost` / `input` 也不在任何
响应里，也没有任何错误信息会透露它们。填错的后果不是"显示不准"：

- `cost` 缺失或错误 → 计费出错（`model.cost.input / 1000000 * input`）
- `contextWindow` 猜小 → 长对话被静默截断
- `input` 猜成 text-only → 拒绝本来就支持的图片

而插件从 0.1.1 起就把"猜错协议会让请求在派发时失败、而不是加载时失败"写成了硬
约束。协议探测恰好会破坏它。

## 难点五：确认需要真实调用

`AuthError` 之后就是真实的推理请求。要把它变成"确认"，必须有有效 API key 并
**真的发一次请求** —— 于是探测变成了试错调用：有费用、有速率限制、有触发内容
过滤的可能。对一个每 5 分钟轮询的插件，这条路和"减少无谓请求"的初衷直接冲突。

## 替代方案：查表

同一批 14 个模型喂给 [`models.dev`](https://models.dev/api.json)：

```
命中 13 / 14
  glm-5[zai]  glm-5.1[zai]  qwen3.7-max[alibaba-token-plan]  kimi-k2.6[...]
  kimi-k2.5[...]  qwen3.6-plus[...]  deepseek-flash[deepseek]  qwen3.5-plus[...]
未命中: omen-alpha
```

纯查表，零费用、零副作用、可以在 CI 里跑。而且**命中与否是可验证的**，不像探测
只能得到一堆无法解读的 `AuthError`。

如果要做，需要处理的细节：

1. **同名模型出现在多个 provider 下**（`kimi-k2.6` 同时挂在
   `alibaba-token-plan` 等条目下），选错 provider 会拿到错的 `api`。
2. **数据滞后**：models.dev 更新慢于 OCG 上线，滞后期间仍需走"只报告"分支。
3. **命名不一致**：`models.dev` 用 `kimi-k2.6`，OCG 也用 `kimi-k2.6`（一致），
   但这类一致性不能假定，需要逐个核对。
4. 缓存与失效策略：查表结果同样需要写进现有的 last-known-good 缓存。

结论是：把这条列为 `pi.dev → models.dev → 本地 FALLBACK 覆盖` 的多源查找，比协议
探测更稳、更可测，也更符合插件既有的"显式失败优于静默降级"。
