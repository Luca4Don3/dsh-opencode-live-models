# dsh-opencode-live-models

[English](README.md) | 中文

DeepSeek Harness（DSH）自带的 pi-ai 模型目录可能跟不上 OpenCode Go 与 OpenCode Zen。这个插件在运行时把两者的目录都更新掉，并为它管理的模型保留网关要求的两项逐请求配置——会话头与可用的提示缓存保留时长。

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

> **0.5.0 起同时覆盖 `opencode`（OpenCode Zen）与 `opencode-go`。** 以前 Zen 这条路由用的是 DSH 内置 pi-ai 那一刻的快照，现在它有自己的 Pi 目录、自己的实时名单和自己的协议表。两条路由彼此独立：一个网关不可达或响应被拒，不会影响另一个的目录。

> **0.3.0 起不再内置模型描述符。** 已安装目录没有的模型，现在只有在 Pi 的目录可达时才会出现，因此完全离线的首次启动会比 0.2.1 少一个模型：`space-bunny-free`。原因见[工作方式](#工作方式)。

> **0.1.1 仅作版本记录保留，请勿安装。** 其中两个缺陷已在 0.1.2 修复：adapter 注册前到达的名单可能绕过规模校验而隐藏已安装模型；卸载后叠加层不会被撤除，插件已不再维护，选择器却仍显示那些模型。原地升级即可，无需先移除现有安装。

## 工作方式

- 从 Pi 模型目录读取模型描述符，每条路由一个地址：[`opencode-go`](https://pi.dev/api/models/providers/opencode-go?types=chat) 与 [`opencode`](https://pi.dev/api/models/providers/opencode?types=chat)。**插件不内置任何模型**：叠加层就是 Pi 当前发布的内容，上游新增、改名或下线都不需要这里发一次版本。获取失败时保留已安装的目录。
- 对照各网关的实时名单——[OpenCode Go](https://opencode.ai/zen/go/v1/models) 与 [OpenCode Zen](https://opencode.ai/zen/v1/models)——检查**已安装目录**中下线的模型，并报告缺少描述符的模型 ID。
- 不发布「只是目录条目、不是对话模型」的条目。Pi 把 OpenCode Zen 的两条 `type: "classifier"` 记录和聊天模型列在一起；它们没有 `maxTokens`，插件只点名一次并跳过，不放进模型选择器。

Pi 自己的条目豁免这项检查：Pi 仍在发布、而 OCG 已经下线的模型会留在选择器里，直到 Pi 也移除它。跟随 Pi 的节奏是本插件的约定；把网关的缺口当成下线，退掉的恰恰是 Pi 领先的那批 id。

插件更新 pi-ai 中 `opencode-go` 与 `opencode` 的模型列表，并在请求发往线上之前改写两样东西。请求仍由已安装的 pi-ai 处理，包括传输和鉴权。

**两条路由，不是同一个东西的两个名字。** 它们是不同的端点：`opencode-go` 把 Anthropic、OpenAI-completions 与 OpenAI-responses 的流量发往 `/zen/go`；`opencode` 是 OpenCode Zen，往 `/zen` 发第四种协议（Google 的），Anthropic 的根路径也不同。每条路由有自己的协议表、自己的目录和自己的缓存条目；只有 DSH 实际注册过的路由才会被轮询——没在任何地方配置的路由不会每五分钟发一次请求。

**会话头，覆盖每一条 opencode 路由。** OpenCode Go 会拒绝不带 `x-opencode-session` 的请求（`400 MissingSessionID`），并要求客户端自报身份、不要看起来像一个通用 SDK——而 pi-ai 在每条路由上带的是 **pi 的** user agent。pi-ai 自己的注入只覆盖它那两个内置 provider 描述符，别的一概不管；因此本插件包装 `Models` 原型，为 provider 是 `opencode`/`opencode-go`、或 baseUrl 落在 `opencode.ai` 的任何模型补上 `x-opencode-session`（取自会话 ID）与 `x-opencode-client: dsh`。选原型这一层有两个原因：为自定义 id 新增的路由——同一个网关换个名字——对内置注入是不可见的；而 `Models` 集合会在 profiles 变化时重建，它背后的类不会。已经在请求选项或模型描述符上显式配置的头始终优先。

**为什么是这个选项。** `cacheRetention` 是 DSH 暴露的、唯一能左右网关前缀缓存存活的两个线上字段的开关——`prompt_cache_key` 与 `prompt_cache_retention: "24h"`。pi-ai 默认取 `"short"`，这两个字段一个都不发，于是每轮只能靠网关自己大约五分钟的自动窗口命中；而 DeepSeek 官方端点的磁盘缓存可以存活数小时到数天。同一个会话走 `opencode-go` 的命中率低于走官方 API，原因就在这里。该设置在 pi-ai 里是**提供方级**字段、没有按模型的形态，放任不管会波及这条路由上的每一个模型；本插件点名的是匹配 `/^deepseek/i` 的那些。`kimi-k2.6` 是上游唯一一个已经通过 `compat.supportsLongCacheRetention` 主动退出的模型，而这条路由上没有任何模型声明 `cacheControlFormat`，所以匹配到的 id 正好就是行为会变的那些。叠加层的 `stream` / `streamSimple` 带着这个选项转发给原 provider，传输、鉴权与提供方级标头都不受影响。

两个数据源并行获取，且都不被允许"缩小"目录：空、格式错误或明显小于上一轮正常值的响应会被拒绝而不是采纳，因此一次坏响应无法悄悄清空选择器。

挂载过程不等它们。已安装目录**本身**就是一份正确的目录——不装这个插件时你看到的就是它——所以插件加载的瞬间就发布；网络刷新在其后进行，有变化才再次发布。在完全离线的首次启动里，这份目录加上磁盘缓存就是插件能提供的全部，这是"不内置任何模型"刻意付出的代价。

每条路由被采纳的目录都会落盘，下次启动时读回，因此一次故障不会让你失去那些只有 Pi 才有的模型。两份目录共用同一个文件、按 provider id 分键 —— 一次原子 rename 让两者始终一致 —— 而每个条目各自判定有效期，所以某条路由停止刷新后，不会被另一条持续成功的路由一直续命。DSH 暴露了 profile 目录就写在那里，否则写 `~/.dsh`。缓存读入时会重新校验，单个条目超过一周就忽略，读写失败也只是跳过。Pi 为每条路由提供 ETag，所以目录没变时只发一个条件请求，而不是整个响应体。

**怎么看日志。** pi.dev 返回 304 时，插件保留目录和 ETag、不重写文件，所以缓存的 mtime 不变是**预期结果，不是失败**。`catalog updated` 只表示**可见目录发生了变化**，不代表别的：启动时从磁盘恢复缓存也可能触发这一行，而它没出现也说明不了刷新是否成功；首次 `catalog published` 的数量同样不是固定值。

受控重启后要确认的是三件事：叠加层已安装、出现了 `catalog published`、且没有 `catalog refresh failed`——**但要看告警，得等首轮刷新结束后再看**。两个请求并行、各有 8 秒超时，失败要等两边都落定才记录，所以刚看到 `catalog published` 时没有告警说明不了任何事。把超时窗口等过去再下结论。

## 测试

```sh
npm test
```

用 `test/fixtures/` 中随仓库提交的固件运行 `probe.mjs`——固件抓自真实端点，新克隆后无需联网或任何准备。

## 刷新固件

两条路由的固件都直接取自线上端点，原样保存：

```sh
curl -sS https://opencode.ai/zen/go/v1/models -o test/fixtures/ocg-models.json
curl -sS https://opencode.ai/zen/v1/models -o test/fixtures/zen-models.json
curl -sS 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  -o test/fixtures/pi-dev-opencode-go.json
curl -sS 'https://pi.dev/api/models/providers/opencode?types=chat' \
  -o test/fixtures/pi-dev-opencode.json
```

另外两个固件是已安装 pi-ai 自带的目录，它们只存在于桌面客户端里，不在磁盘上：
`app.asar` → `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`
以及 `.../data/opencode.json`。
`docs/catalog-injection.md` 里有一个可用的读取器。请在**文件名**
（`opencode-go-<version>.json`、`opencode-<version>.json`）和 `probe.mjs` 里的
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
