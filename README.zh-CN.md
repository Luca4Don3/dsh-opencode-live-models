> 一个 DSH bundle，让 OpenCode Go 的模型目录保持最新，不必等 pi-ai 随版本更新。

**[English](README.md)**

# dsh-opencode-live-models

在 DeepSeek Harness 中保持 OpenCode Go 模型目录新鲜，无需等待 pi-ai（以及随之而来的 DSH）发版来携带更新。

它只打**一个**补丁：运行中的 pi-ai `Models` 集合里 `opencode-go` provider 的 `getModels()`。请求链路上的其他一切——wire transport、鉴权解析、provider 请求头——都完全沿用已安装的 pi-ai 原有实现，因此旧版 pi-ai 从未听说过的模型同样能被正确路由。

## 为什么需要它

`opencode-go.json` 目录随 pi-ai 一起分发，在打包时生成，不跟随网关更新。在已安装的桌面客户端（`dsh 0.1.7-rc.2`，pi-ai `0.85.1`）上于 2026-09-28 实测：

| 来源 | 模型数 |
|---|---|
| 已安装的 pi-ai 目录 | 27 |
| `https://pi.dev/api/models/providers/opencode-go?types=chat` | 29 |
| `https://opencode.ai/zen/go/v1/models`（实时） | 43 |

网关在服务的模型中，有 16 个在已安装目录里没有对应描述符，其中包括 `space-bunny-free` 和 `deepseek-v4.1-flash`。

## 它如何打补丁

DSH 的 `llm-pi-ai` adapter 每次操作都会构建一个 pi-ai `Models` 集合，并从中读取全部目录事实：

- `listModels()` → `snapshot.models.getModels(provider)`
- `resolveModel()` → `snapshot.models.getModel(provider, id)`
- 派发 → `snapshot.models.streamSimple(model, ...)`

在 pi-ai 中，`getModel(provider, id)` 就是 `getModels(provider).find(m => m.id === id)`，而 `setProvider()` 允许在运行时替换 provider。因此包装 `opencode-go` provider 的 `getModels()`，就能同时覆盖模型选择器、能力解析和请求派发，**而无需重新实现任何 transport**。

插件挂在 `PiAiAdapter.current()` 上——它会 memoize 一份 snapshot，并在每次配置变更时重建，因此这层覆盖能在修改设置后依然存活。

## 刻意做到零 import

本模块在运行时没有 import 任何东西。profile 的 `node_modules` 无法解析 DSH 包，因为它们位于已安装桌面客户端的 `app.asar` 内部：

```
$ node -e "require('module').createRequire('~/.dsh/profiles/desktop/x.js').resolve('@deepseek-ai/dsh-web')"
MODULE_NOT_FOUND
```

因此在已安装客户端中，任何 `import '@deepseek-ai/dsh-llm'` 都会失败。插件改为通过 `ctx.llm.adapters` 触达运行中的 pi-ai 实例——那是一个 TypeScript `private` 字段，运行时不过是一个普通 `Map`。这与 `dsh-opencode-session` 走的是同一条路径，也正是本插件能安装、而带 dsh import 的插件装不上的原因。

## 数据来源与优先级

1. **Pi 的目录**——`https://pi.dev/api/models/providers/opencode-go?types=chat` 返回完整的描述符（api、baseUrl、容量、compat、thinkingLevelMap）。它是权威来源，且已预先校验。
2. **`FALLBACK_MODELS`**——`deepseek-v4.1-flash` 与 `space-bunny-free` 的描述符，在远端目录不可达时兜底。
3. **已安装的目录**，原样保留，这样 Pi 尚未发布的模型不会仅仅因为一次抓取不完整就被丢掉。

来自 `https://opencode.ai/zen/go/v1/models` 的实时名单**只用于漂移报告**。遇到没有描述符的名字，只报告、不猜测：`/models` 只返回 id，别的什么都没有，而猜测 `api` 或 `contextWindow` 会让失败发生在对话中途，而不是加载时。

### 为什么覆盖层不按实时名单做过滤

只有当某模型**存在于已安装目录**、同时又**不在实时名单**里，它才会从选择器中被移除。覆盖层条目享有豁免：一次失败的或滞后的名单抓取绝不该把目录清空；而 Pi 仍在发布、网关尚未索引的模型属于发布节奏滞后，不等于模型下线。

## 安装

在 DSH 插件页面中操作，或：

```sh
dsh plugin --profile desktop add dsh-opencode-live-models
```

要求 `dsh >= 0.1.5-rc.1`（见 `dsh.engines.dsh`）。

## 预期日志

```
opencode-live-models: installed live catalog overlay on opencode-go
opencode-live-models: loaded 29 model descriptors from pi.dev
opencode-live-models: OpenCode Go currently exposes 43 models
opencode-live-models: 14 live model(s) have no descriptor yet and are NOT added: ...
```

最后一行是正常现象：这些模型目前在任何地方都还没有描述符。它们只被报告，不会被加入。若要采纳其中某个，需要把它的 `api`、`baseUrl`、`contextWindow` 和 `maxTokens` 补进 Pi 目录或 `FALLBACK_MODELS`。

## Probe

`probe.mjs` 用抓取到的真实响应验证合并逻辑：两个兜底模型都带着完整描述符进入目录、已安装目录永远不会被清空、没有描述符的模型永远不会被加入，以及上游两次故障都能优雅降级而不清空选择器。

```sh
# 抓取 fixtures（需要网络）
mkdir -p ../.temp/ocg-fixtures
curl -s https://opencode.ai/zen/go/v1/models > ../.temp/ocg-fixtures/ocg-models.json
curl -s 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  > ../.temp/ocg-fixtures/pi-dev-opencode-go.json
# opencode-go-0.85.1.json 取自已安装客户端的 app.asar

node probe.mjs          # 20/20
```

可用 `OCG_FIXTURES` 覆盖 fixtures 目录。

## 已知限制

- **只会加入已存在的描述符。** 若 OCG 上线某模型早于 Pi 发布它，在有人补上描述符之前它就不会出现在列表中。补上这个缺口需要对协议做探测，而本插件刻意不去猜。
- **挂载 TypeScript `private` 字段**（`ctx.llm.adapters`、`adapter.current`）会让插件与 llm-pi-ai 的内部实现耦合。一旦某个版本重命名它们，插件会打印一条警告并保持目录原样——它是显式失败，而不是静默失败。
- **不支持 replay 状态**、**不支持 `developer` 角色**、**不支持延迟工具加载**：这些都与底层 `llm-pi-ai` 完全一致，本插件并不替换它。

## License

MIT
