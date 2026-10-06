# 为什么不做协议探测

插件的既定策略是：OCG 已上线、但 Pi 尚未发布描述符的模型，**只报告、不猜测**。
本文记录"通过探测网关来自动推断描述符"这条路为什么走不通，以及替代方案。

结论先说：**协议探测走不通，而查表这条路也救不了真正缺 descriptor 的那批模型。**
两者卡在同一个地方——没有任何来源会告诉你 OCG 上某个模型该用哪个 `api`。

## 真正缺 descriptor 的是 9 个，不是 14 个

"不在 pi.dev" 的 14 个里，有 5 个（`kimi-k2.6`、`glm-5.1`、`qwen3.7-max`、
`qwen3.6-plus`、`omen-alpha`）在 installed pi-ai 里**本来就有 descriptor**，当前即可使用。
真正没有 descriptor 的是 9 个：

```
minimax-m2.5  kimi-k2.5  glm-5  deepseek-flash  qwen3.5-plus
mimo-v2-pro   mimo-v2-omni  hy3-preview  grok-4.5
```

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

没有 descriptor 的模型实测（`kimi-k2.6` 和 `glm-5.1` 已由 installed 目录覆盖，
一并列出以说明信号本身的样子）：

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

## 查表：models.dev 能给能力字段，但给不了 `api`

[`models.dev`](https://models.dev/api.json) 收录 225 个 provider，其中 `opencode-go`
正是 OCG 的对口岸位。先验证它靠不靠得住——拿 pi.dev 已知的 29 个模型逐项比对：

| 字段 | 与 pi.dev 一致 |
|---|---|
| `contextWindow` | **29 / 29** |
| `maxTokens` | **29 / 29** |
| `cost.input` | **29 / 29** |

它是可靠的——但**不含 `api` 字段**。models.dev 的模型对象只有
`id / name / description / family / attachment / reasoning / tool_call /
modalities / limit / cost …`，`attachment` 是"是否支持附件"的布尔值，不是协议。

而 `api` 恰恰是五个必需字段里最关键的一个：它决定请求发往哪个端点，猜错就是
404 或协议错误。

更要紧的是覆盖度。`opencode-go` 收录 33 个模型，与网关当前 43 个的交集是 33，
对那 9 个待救模型**只命中 1 个**（`grok-4.5`）——它和 pi.dev 一样滞后。

至于其他 provider 下的同名模型，**不能代表 OCG**。同一模型在不同 provider 下的
容量声明并不一致：

| 待救模型 | 其他 provider 数 | `contextWindow` 取值数 |
|---|---|---|
| `minimax-m2.5` | 8 | **5 种** |
| `kimi-k2.5` | 20 | **3 种** |
| `glm-5` | 15 | **5 种** |
| `qwen3.5-plus` | 7 | 2 种 |
| `grok-4.5` | 10 | 2 种 |

一个模型在 8 个 provider 下有 5 种不同的上下文窗口——从这些数字里挑一个填进
descriptor，就是在编造。`zai`、`alibaba-token-plan`、`deepseek` 的协议选择和价格
同样不代表 OCG。

所以「ID 能查到」这件事本身没有价值：**查到之后，五个必需字段里最关键的那个
仍然缺失，其余的又不可信。**

## 结论，以及仍然可行的做法

两条自动路径堵在同一处：**没有任何来源能给出 OCG 上某个模型的 `api`**。

- **协议探测** 能排除端点，不能确认端点。
- **查表** 能给容量和价格，不给协议。

所以这 9 个模型**目前无法自动上架**，插件继续报告它们是正确的行为，不是缺陷。

## 人工覆盖入口已经取消

0.2.1 及更早版本里，`FALLBACK_MODELS` 可以把某个模型连同它的 `api` 写死在插件里，
人工补上这个缺口。它已被删除，理由记在 `lib/index.js` 的 `buildOverlay` 上：手写描述符
是一份快照，它只会静静过期而不会报错——`space-bunny-free` 就是现成的例子，OCG 已经
不再提供它，而一份内置副本会继续把这个 id 挂进选择器，让它每一次派发都返回
`ModelError`，而插件里没有任何东西会发现这件事。

所以现在**没有本地覆盖入口**，这是刻意的：描述符只来自 Pi。缺描述符的模型要上架，
只有两条路。

一是 **Pi 发布它**，插件下一轮轮询自动接上——这本来就是设计意图。二是**把模型连同
它的 `api` 补进 Pi 的目录**，也就是补上游而不是补插件。这一步需要知道 OCG 为该模型
选定的协议：`minimax-m2.5` 在 `/v1/responses` 上返回 `not supported for format
openai`（见上文探测），说明它不是 `openai-responses`；但剩下两个端点网关不给区分
信号，最终仍需一次真实请求来确认。

如果将来 OCG 在 `/v1/models` 上补上 `api` 字段，协议这一项就不用再猜了。但按本文的
测量，光有 `api` 还不够：`contextWindow`、`maxTokens`、`cost` 三个字段没有任何来源
能给出 OCG 上的真值。**那条链路只有在容量与价格也一并公开之后才成立**——本文早先
的说法（补上 `api` 即可）比实测支持的结论走得更远。
