# dsh-opencode-live-models

[English](README.md) | 中文

DeepSeek Harness（DSH）自带的 pi-ai 模型目录可能跟不上 OpenCode Go、OpenCode Zen 与原生 OpenAI Codex。这个插件在运行时更新三者的目录，为 OpenCode 保留网关要求的会话头与提示缓存配置，在插件详情页提供 ChatGPT 登录，并在「设置 → 账号与余额」显示 OpenAI订阅／OpenCode Go 订阅额度与 OpenCode Zen 余额；Codex 继续使用原生传输和 OAuth。

## 安装

**桌面端** —— 侧栏打开「插件」页面，点「添加插件」，粘贴下面的 spec，再点「立即启用」并重启 DSH：

```
github:Luca4Don3/dsh-opencode-live-models
```

**CLI** —— `add` 会同时安装并选中该组合包，重启 DSH 后生效：

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

`github:` spec 通过 HTTPS 从 codeload.github.com 拉取，npm 镜像不代理它，因此需要宿主机能访问 GitHub。

需要 DSH 0.1.5-rc.1 或更新版本，以及**本插件 0.3.0 或更新版本**。

> **0.11.3：清除已经修复的启动目录错误。** 完整实时描述符补齐已保存模型的调用协议后，同步更新运行状态和模型设置页的错误提示；仍缺少描述的模型和其他配置错误继续显示。
>
> **0.11.2：修复模型勾选的删除语义。** 「获取可用模型」中的取消勾选会在应用选择并保存后移除已有模型，不再只是添加新项。
>
> **0.11.0：增加 OpenCode Console 官方账号登录。** 在插件详情页完成设备授权并选择工作区，Zen 余额优先使用该工作区登录凭据；模型 API Key 保持原用途。HTTP 403 不再直接解释为 Key 缺少权限。
>
> **0.10.2：调整启动加载提示。** “正在加载设置…”与原生 DeepSeek Harness logo 上下居中排列，提示位于 logo 下方。
>
> **0.10.1：明确 Zen 余额查询权限。** 支持新版和旧版 Key，权限不足时显示 Console 操作入口，缺失余额的响应不会覆盖已有金额缓存。
>
> **0.10.0：增加压缩恢复。** 长历史按当前摘要模型的容量分段生成并合并摘要；压缩请求断流时最多重试一次，取消和失败保留原历史。
>
> **0.9.0：接通原生「设置 → 模型 → 获取可用模型」及模型目录选择，支持 API Key 与 OAuth 路由；增加 OpenCode Zen 余额整行显示。**
>
> **0.8.0：模型目录更新、ChatGPT 登录和订阅额度查询合为一个插件。** 登录入口位于插件详情页，订阅额度位于账号设置的官方余额下方。升级时停用旧 `dsh-subscription-usage` 组合包，继续复用宿主已有凭据。
>
> **0.7.0：新增原生 OpenAI Codex 模型目录更新**，可补齐 `gpt-6.1-sol`，复用既有校验、ETag、缓存与生命周期机制。Codex 保留原生 OAuth 和传输，不注入 OpenCode 会话头或缓存选项。
>
> **0.6.0：卸载时主动取消在途目录请求；修复刷新进行中新注册 Provider 被推迟到下一轮轮询的问题；补上跨代（HMR 接管）场景下旧实例迟到回调的防护。** 目录合并与网关行为不变；probe 回归同时纳入 CI。
>
> **0.5.0 起同时覆盖 `opencode`（OpenCode Zen）与 `opencode-go`。** 以前 Zen 这条路由用的是 DSH 内置 pi-ai 那一刻的快照，现在它有自己的 Pi 目录、自己的实时名单和自己的协议表。两条路由彼此独立：一个网关不可达或响应被拒，不会影响另一个的目录。

> **0.3.0 起不再内置模型描述符。** 已安装目录没有的模型，现在只有在 Pi 的目录可达时才会出现，因此完全离线的首次启动会比 0.2.1 少一个模型：`space-bunny-free`。原因见[工作方式](#工作方式)。

> **0.1.1 仅作版本记录保留，请勿安装。** 其中两个缺陷已在 0.1.2 修复：adapter 注册前到达的名单可能绕过规模校验而隐藏已安装模型；卸载后叠加层不会被撤除，插件已不再维护，选择器却仍显示那些模型。原地升级即可，无需先移除现有安装。

## 登录和订阅额度

打开侧栏「插件」→「dsh-opencode-live-models」，详情页提供「使用 ChatGPT 账号登录」、重新登录、授权状态、回调地址粘贴与取消操作。

打开「设置 → 账号与余额」，官方 DeepSeek 余额下方会自动显示已登录／已配置凭据的订阅，最多同时显示 3 个供应商，不重复显示 DeepSeek 官方余额。优先显示 OpenAI订阅和 OpenCode Go 的百分比额度卡片，OpenCode Zen 等金额余额以整行长框放在最下方。进入页面时查询，也可点击刷新。订阅卡片显示剩余额度百分比与重置时间，不换算为现金金额；缺失数据保持未知，过期数据保留原查询时间。额度查询与模型目录的后台刷新相互独立。

账号页会将成功查询的额度卡片保存到本地显示缓存，`Command+Q` 完全退出 DSH 后仍保留。重新启动或打开设置时立即显示上次结果，同时后台核对本机凭据状态；重新启动后的首次进入会后台查询最新额度，查询期间保留缓存，只有没有缓存时才显示「正在查询额度」。运行期间缓存的新鲜度由 `freshMs` 决定（默认 5 分钟），过期结果也先显示再更新，各张卡片独立完成。核对或查询失败时保留旧结果及原查询时间；确认退出登录或切换账号／Go key 后移除对应旧缓存。点击「刷新额度」会强制重新查询。本地存储不可用时会明确提示，在线查询仍可继续。

需先在 DSH 的 `llm-pi-ai` 中配置原生 `openai-codex` provider；Go 使用已有的 `OPENCODE_GO_API_KEY` 凭据引用，Zen 使用 `OPENCODE_API_KEY`。本插件通过宿主完成登录与令牌刷新，不自行实现 OAuth 或另存凭据。

从旧订阅插件迁移时，先停用 `dsh-subscription-usage` 组合包，再启用本版本，避免重复注册服务。已有 `llm-pi-ai/openai-codex` 凭据和 `subscriptionUsage` 服务 API 均可继续使用；旧插件文件可以保留安装并保持停用。

可在 `opencode-live-models` 条目的 `config` 中配置：

```yaml
config:
  freshMs: 300000
  timeoutMs: 15000
  goApiKeyRef: OPENCODE_GO_API_KEY
  zenApiKeyRef: OPENCODE_API_KEY
```

在侧栏「插件」页打开本插件详情，点击 **登录 OpenCode Console**。浏览器打开官方设备授权页，选择与你的 Zen Key 相同的工作区并批准授权。回到 DSH，显示已登录后，在「设置 → 账号与余额」刷新 Zen 余额。查询优先使用该工作区的 Console 登录凭据，没有登录记录时才尝试现有 API Key。已存在但失效的登录不会静默切换到另一个 Key／工作区。

OpenCode 使用官方文档中的设备授权流程，登录和刷新仅访问 `https://opencode.ai/console/auth/device/*`。令牌通过宿主凭据服务保存于独立的 `dsh-opencode-live-models/opencode-console` grant，不改写模型 API Key 或 Codex OAuth。余额和显示缓存按工作区摘要隔离。刷新令牌只用一次；请求前持久化刷新标记，网络结果不确定或进程中断后要求重新登录，避免重放旧刷新令牌导致整份登录失效。插件停用会取消在途设备授权与余额请求。

Zen 查询 Console 网页使用的 `GET https://opencode.ai/console/api/billing/status`，将有效响应中的 `availableMicroCents` 按 100,000,000 = 1 USD 转换。预付费显示「余额」，后付费显示「可用额度」。API Key 回退接受新版 `oc_sk_…` 和旧版 `sk-…` 格式，但不能保证网页计费接口允许 API Key 访问：已实测同一 All 权限 Key 的公开配置接口返回 200、计费接口返回 403，补充对应工作区请求头仍然被拒绝。因此 403 只显示「计费接口拒绝访问」，不会断言用户未开启权限，也不能保证增加 `billing:read` 或 All 权限可解决。Console 登录账号本身也需要所选工作区的计费访问权限。

新版 Console 的服务账号 Key 位于 **Settings → Service accounts → 对应账号**，个人 Key 位于右上角账号菜单的 **Account → Personal API keys**。`zenApiKeyRef` 可指向宿主凭据中的另一引用，只影响余额查询。接口拒绝或缺失金额时保留此前缓存及原更新时间，无缓存才显示失败状态，并提供 Console 入口查看官方余额。不会读取浏览器 cookie。

额度引擎缓存按已验证的账号标识隔离；缺少账号标识时不复用引擎缓存，包括当前的 Go 额度响应。账号页的显示缓存使用稳定的作用域摘要按当前 Codex 账号／Go、Zen key 隔离，通过 DSH 页面自身的 `localStorage` 保存。仅保存卡片显示字段和摘要，不保存原始凭据或上游账号标识。

## 压缩恢复

插件通过原生 `compaction.summarize()` 接口补充恢复逻辑，手动和自动压缩共用。短历史继续使用原摘要器；长历史按宿主 token meter 的估算分段，每段最多约 96,000 个历史 tokens，并预留系统提示、工具定义、摘要指令和输出空间。原生摘要目标、精确模型策略和输出上限继续生效，各段及合并过程使用同一供应商／模型。

工具调用及其结果保持成组；单个过大的纯文本工具组转为带角色和调用 ID 的引用片段。无法安全分片的超大非文本组会明确失败。分段结果按时间顺序合并，全部成功后才由宿主原有事务生成检查点并保存。任何阶段失败或取消都不会用半成品替换历史。

`TRANSPORT`、超时、临时服务错误等每次最多重试一次；仍然断流或收到明确的上下文超限时，较大的批次继续减半。每次压缩总计最多 64 次摘要请求，归并层数同样有上限，认证失败、额度耗尽和截断不会被当作成功。分段需要多次模型调用，额度按供应商实际计费；最终 usage 汇总成功摘要请求。插件不会修复持续不可用的网络或上游服务，重试耗尽时保留错误和原历史。

禁用或热更新会撤销摘要包装并取消在途恢复请求。宿主安装文件和现有会话文件无需修改。重启加载本版本后，重新执行压缩即可应用恢复逻辑。

## 模型显示选择

在「设置 → 模型」进入供应商，点击「获取可用模型」，勾选要展示的模型，点击「应用选择」，再保存供应商设置。已有目录项会按当前配置勾选，取消勾选会移除对应项；默认继承全部目录时初始全部勾选。应用选择保留其他模型的自定义名称、容量与输入类型，以及未出现在查询结果中的手工模型。搜索后的全选／取消全选只影响当前可见结果。保存后取消的模型不会再进入聊天下拉列表，后台刷新也不会将其重新添加。API Key 和 OAuth 供应商使用同一套原生操作。Go、Zen 与 OpenAI订阅的获取结果及保存校验使用插件维护的完整描述符；其他供应商沿用宿主原生发现机制。

按宿主惯例，未自定义模型目录或将目录重置为空时会使用全部可用模型。已自定义目录时，上游新增模型会出现在获取结果中，需手动加入后才显示在下拉列表。插件停用时撤销运行时目录补充，不修改宿主安装文件或用户的模型配置。

## 工作方式

三路已配置的模型目录都会在启动时更新，之后每 5 分钟检查一次；新增模型和能力变化会自动发布到现有模型选择器，无需为每次上游更新重装插件。网络失败时保留最后可用目录，下一轮继续重试。目录采用完整模型描述符；缺少描述或协议尚不支持的条目会记录明确告警。

兼容性限制：当前 DSH 内置 pi-ai 0.87.1 的 OpenCode Go provider 没有 Google 传输，所以最新 Go 目录中的 `gemini-4-argon-contributor` 暂不加入可选列表，需先补齐宿主传输支持。OpenCode Zen 已有的 Google 模型不受此限制。

- 从 Pi 模型目录读取模型描述符，每条路由一个地址：[`opencode-go`](https://pi.dev/api/models/providers/opencode-go?types=chat)、[`opencode`](https://pi.dev/api/models/providers/opencode?types=chat) 与 [`openai-codex`](https://pi.dev/api/models/providers/openai-codex?types=chat)。**插件不内置任何模型**：叠加层就是 Pi 当前发布的内容，上游新增、改名或下线都不需要这里发一次版本。获取失败时保留已安装的目录。
- 对照各网关的实时名单——[OpenCode Go](https://opencode.ai/zen/go/v1/models) 与 [OpenCode Zen](https://opencode.ai/zen/v1/models)——检查**已安装目录**中下线的模型，并报告缺少描述符的模型 ID。
- 不发布「只是目录条目、不是对话模型」的条目。Pi 把 OpenCode Zen 的两条 `type: "classifier"` 记录和聊天模型列在一起；它们没有 `maxTokens`，插件只点名一次并跳过，不放进模型选择器。

Pi 自己的条目豁免这项检查：Pi 仍在发布、而 OCG 已经下线的模型会留在选择器里，直到 Pi 也移除它。跟随 Pi 的节奏是本插件的约定；把网关的缺口当成下线，退掉的恰恰是 Pi 领先的那批 id。

插件更新 pi-ai 中 `opencode-go`、`opencode` 与 `openai-codex` 的模型列表。OpenCode 请求另有下文所述的两项改写；所有请求仍由已安装的 pi-ai 处理传输和鉴权。

**原生 Codex。** `gpt-6.1-sol` 等新模型从 Pi 的公开 Codex 目录获取，使用 `openai-codex-responses`，端点固定为 `https://chatgpt.com/backend-api`。这条路由不查询需要账号认证的模型名单，不注入 OpenCode 会话头或缓存选项，并保留全部已安装的 Codex 模型。本插件不注册新路由；ChatGPT 登录入口由合并后的订阅模块提供，调用宿主的原生授权流程。目录刷新决定模型能否被选择，实际调用权限仍由账号决定。

**两条路由，不是同一个东西的两个名字。** 它们是不同的端点：`opencode-go` 把 Anthropic、OpenAI-completions 与 OpenAI-responses 的流量发往 `/zen/go`；`opencode` 是 OpenCode Zen，往 `/zen` 发第四种协议（Google 的），Anthropic 的根路径也不同。每条路由有自己的协议表、自己的目录和自己的缓存条目；只有 DSH 实际注册过的路由才会被轮询——没在任何地方配置的路由不会每五分钟发一次请求。

**会话头，覆盖每一条 opencode 路由。** OpenCode Go 会拒绝不带 `x-opencode-session` 的请求（`400 MissingSessionID`），并要求客户端自报身份、不要看起来像一个通用 SDK——而 pi-ai 在每条路由上带的是 **pi 的** user agent。pi-ai 自己的注入只覆盖它那两个内置 provider 描述符，别的一概不管；因此本插件包装 `Models` 原型，为 provider 是 `opencode`/`opencode-go`、或 baseUrl 落在 `opencode.ai` 的任何模型补上 `x-opencode-session`（取自会话 ID）与 `x-opencode-client: dsh`。选原型这一层有两个原因：为自定义 id 新增的路由——同一个网关换个名字——对内置注入是不可见的；而 `Models` 集合会在 profiles 变化时重建，它背后的类不会。已经在请求选项或模型描述符上显式配置的头始终优先。

**为什么是这个选项。** `cacheRetention` 是 DSH 暴露的、唯一能左右网关前缀缓存存活的两个线上字段的开关——`prompt_cache_key` 与 `prompt_cache_retention: "24h"`。pi-ai 默认取 `"short"`，这两个字段一个都不发，于是每轮只能靠网关自己大约五分钟的自动窗口命中；而 DeepSeek 官方端点的磁盘缓存可以存活数小时到数天。同一个会话走 `opencode-go` 的命中率低于走官方 API，原因就在这里。该设置在 pi-ai 里是**提供方级**字段、没有按模型的形态，放任不管会波及这条路由上的每一个模型；本插件点名的是匹配 `/^deepseek/i` 的那些。`kimi-k2.6` 是上游唯一一个已经通过 `compat.supportsLongCacheRetention` 主动退出的模型，而这条路由上没有任何模型声明 `cacheControlFormat`，所以匹配到的 id 正好就是行为会变的那些。叠加层的 `stream` / `streamSimple` 带着这个选项转发给原 provider，传输、鉴权与提供方级标头都不受影响。

两个数据源并行获取，且都不被允许"缩小"目录：空、格式错误或明显小于上一轮正常值的响应会被拒绝而不是采纳，因此一次坏响应无法悄悄清空选择器。

挂载过程不等它们。已安装目录**本身**就是一份正确的目录——不装这个插件时你看到的就是它——所以插件加载的瞬间就发布；网络刷新在其后进行，有变化才再次发布。在完全离线的首次启动里，这份目录加上磁盘缓存就是插件能提供的全部，这是"不内置任何模型"刻意付出的代价。

每条路由被采纳的目录都会落盘，下次启动时读回，因此一次故障不会让你失去那些只有 Pi 才有的模型。三份目录共用同一个文件、按 provider id 分键 —— 一次原子 rename 保持一致 —— 而每个条目各自判定有效期，所以某条路由停止刷新后，不会被另一条持续成功的路由一直续命。DSH 暴露了 profile 目录就写在那里，否则写 `~/.dsh`。缓存读入时会重新校验，单个条目超过一周就忽略，读写失败也只是跳过。Pi 为每条路由提供 ETag，所以目录没变时只发一个条件请求，而不是整个响应体。

**怎么看日志。** pi.dev 返回 304 时，插件保留目录和 ETag、不重写文件，所以缓存的 mtime 不变是**预期结果，不是失败**。`catalog updated` 只表示**可见目录发生了变化**，不代表别的：启动时从磁盘恢复缓存也可能触发这一行，而它没出现也说明不了刷新是否成功；首次 `catalog published` 的数量同样不是固定值。

受控重启后要确认的是三件事：叠加层已安装、出现了 `catalog published`、且没有 `catalog refresh failed`——**但要看告警，得等首轮刷新结束后再看**。两个请求并行、各有 8 秒超时，失败要等两边都落定才记录，所以刚看到 `catalog published` 时没有告警说明不了任何事。把超时窗口等过去再下结论。

## 测试

```sh
npm test
```

运行 `probe.mjs` 和 `test/` 下的模型选择、压缩、订阅、额度解析与客户端回归，直接验证产品模块。`docs/validation/` 中较早的独立解析脚本保留为历史验证材料，不再重复进入 CI。固件随仓库提交，新克隆后无需联网、凭据或额外准备。

CI 保留 Node 18（声明支持的最低版本）和 Node 24（DSH 使用的版本）两档验证。

## 刷新固件

三条路由的目录与 OpenCode 名单固件都直接取自线上端点，原样保存：

```sh
curl -sS https://opencode.ai/zen/go/v1/models -o test/fixtures/ocg-models.json
curl -sS https://opencode.ai/zen/v1/models -o test/fixtures/zen-models.json
curl -sS 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  -o test/fixtures/pi-dev-opencode-go.json
curl -sS 'https://pi.dev/api/models/providers/opencode?types=chat' \
  -o test/fixtures/pi-dev-opencode.json
curl -sS 'https://pi.dev/api/models/providers/openai-codex?types=chat' \
  -o test/fixtures/pi-dev-openai-codex.json
```

另外三个固件是已安装 pi-ai 自带的目录，它们只存在于桌面客户端里，不在磁盘上：
`app.asar` → `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`
以及 `.../data/opencode.json`、`.../data/openai-codex.json`。
`docs/catalog-injection.md` 里有一个可用的读取器。请在**文件名**
（`opencode-go-<version>.json`、`opencode-<version>.json`、`openai-codex-<version>.json`）和 `probe.mjs` 里的
`CATALOG_SOURCE` 两处都记下它来自哪个 pi-ai 版本 — 引用它的断言，说的是一份只存在于
某个发行版里的目录；固件悄悄与客户端对不上，正是这套测试曾经对着没人发布的目录判绿的原因。

然后跑测试。多数计数是从固件推导出来的、不是写死的，所以真正的上游变化应当让它保持绿色。
不能悄悄变化的是漂移报告点名的模型集合 — 一旦那批 id 变了，"哪些实时模型还没有描述符"的答案就跟着变了，
因此在改动任何点名模型的断言之前，先读 `docs/protocol-probing.md`。

想用不提交进仓库的固件试跑：

```sh
OCG_FIXTURES=/path/to/fixtures npm test
```
## 限制

- 没有描述符的模型不会出现在选择器中。
- 每条路由轮询哪些端点、5 分钟轮询间隔和缓存有效期都固定在源码里。其中网关 base URL **是刻意固定的**——远端目录只决定有哪些模型，绝不决定请求发去哪里——所以要指向别的网关就得改 `lib/index.js`。
- long 缓存保活写死在 `lib/index.js`，只匹配 `/^deepseek/i` 的模型 id。这条路由上其余模型保持 pi-ai 的默认值，且没有配置开关——想换一组就改那里的正则。
- 会话头包装装在 `Models` 原型上，因此它对进程注册的**每一个** provider 都会被问到，而不只是 opencode 的。是 `opencode.ai` 这个 host 判断让其余路由保持原样——这也意味着该包装并不局限于本插件管理的那些模型 id。
- 插件依赖 `llm-pi-ai` 的内部接口。如果 DSH 更新后接口发生变化，插件会记录警告并保留原有目录。

## 许可证

MIT
