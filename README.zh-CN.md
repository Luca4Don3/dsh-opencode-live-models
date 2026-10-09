# dsh-opencode-live-models

[English](README.md) | 中文

DeepSeek Harness（DSH）自带的 pi-ai 模型目录可能跟不上 OpenCode Go。这个插件在运行时更新目录。

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

> **0.3.0 起不再内置模型描述符。** 已安装目录没有的模型，现在只有在 Pi 的目录可达时才会出现，因此完全离线的首次启动会比 0.2.1 少一个模型：`space-bunny-free`。原因见[工作方式](#工作方式)。

> **0.1.1 仅作版本记录保留，请勿安装。** 其中两个缺陷已在 0.1.2 修复：adapter 注册前到达的名单可能绕过规模校验而隐藏已安装模型；卸载后叠加层不会被撤除，插件已不再维护，选择器却仍显示那些模型。原地升级即可，无需先移除现有安装。

## 工作方式

- 从 [Pi 模型目录](https://pi.dev/api/models/providers/opencode-go?types=chat) 读取模型描述符。**插件不内置任何模型**：叠加层就是 Pi 当前发布的内容，上游新增、改名或下线都不需要这里发一次版本。获取失败时保留已安装的目录。
- 对照 [OpenCode Go 模型列表](https://opencode.ai/zen/go/v1/models) 检查**已安装目录**中下线的模型，并报告缺少描述符的模型 ID。

Pi 自己的条目豁免这项检查：Pi 仍在发布、而 OCG 已经下线的模型会留在选择器里，直到 Pi 也移除它。跟随 Pi 的节奏是本插件的约定；把网关的缺口当成下线，退掉的恰恰是 Pi 领先的那批 id。

插件更新 pi-ai 中 `opencode-go` 的模型列表。请求仍由已安装的 pi-ai 处理，包括传输和鉴权。

两个数据源并行获取，且都不被允许"缩小"目录：空、格式错误或明显小于上一轮正常值的响应会被拒绝而不是采纳，因此一次坏响应无法悄悄清空选择器。

挂载过程不等它们。已安装目录**本身**就是一份正确的目录——不装这个插件时你看到的就是它——所以插件加载的瞬间就发布；网络刷新在其后进行，有变化才再次发布。在完全离线的首次启动里，这份目录加上磁盘缓存就是插件能提供的全部，这是"不内置任何模型"刻意付出的代价。

被采纳的目录还会落盘，下次启动时读回，因此一次故障不会让你失去那些只有 Pi 才有的模型。DSH 暴露了 profile 目录就写在那里，否则写 `~/.dsh`。缓存读入时会重新校验，超过一周的缓存直接忽略，读写失败也只是跳过。Pi 提供 ETag，所以目录没变时只发一个条件请求，而不是整个响应体。

**怎么看日志。** pi.dev 返回 304 时，插件保留目录和 ETag、不重写文件，所以缓存的 mtime 不变是**预期结果，不是失败**。`catalog updated` 只表示**可见目录发生了变化**，不代表别的：启动时从磁盘恢复缓存也可能触发这一行，而它没出现也说明不了刷新是否成功；首次 `catalog published` 的数量同样不是固定值。

受控重启后要确认的是三件事：叠加层已安装、出现了 `catalog published`、且没有 `pi.dev catalog refresh failed`——**但要看告警，得等首轮刷新结束后再看**。两个请求并行、各有 8 秒超时，失败要等两边都落定才记录，所以刚看到 `catalog published` 时没有告警说明不了任何事。把超时窗口等过去再下结论。

## 测试

```sh
npm test
```

用 `test/fixtures/` 中随仓库提交的固件运行 `probe.mjs`——固件抓自真实端点，新克隆后无需联网或任何准备。

## 刷新固件

三个固件里有两个就是端点自己的响应体，原样保存：

```sh
curl -sS https://opencode.ai/zen/go/v1/models \
  -o test/fixtures/ocg-models.json
curl -sS 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  -o test/fixtures/pi-dev-opencode-go.json
```

第三个是已安装 pi-ai 自带的目录，它在客户端内部而不在磁盘上：
`app.asar` → `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`。
读这个归档的方法见 `docs/catalog-injection.md`。取出来之后要在**两处**记下它来自哪个
pi-ai 版本——文件名（`opencode-go-<版本>.json`）和 `probe.mjs` 里的 `CATALOG_SOURCE`。
引用它的那些断言是在描述一份只存在于某个版本里的目录；固件悄悄地和客户端对不上，
这个套件就曾经对着没人会发布的东西全绿过。

然后跑一遍套件。规模大多由固件推导而不是写死在断言里，所以上游真的变了应该仍然是绿的。
**不能悄悄变的是漂移报告点名的模型集合**——如果它变了，「哪些实时模型没有 descriptor」
这个答案也跟着变了，改任何点名模型的断言之前先读 `docs/protocol-probing.md`。

想试固件而不提交：

```sh
OCG_FIXTURES=/path/to/fixtures npm test
```

## 限制

- 没有描述符的模型不会出现在选择器中。
- 两个端点、5 分钟轮询间隔和缓存有效期都固定在源码里。其中网关 base URL **是刻意固定的**——远端目录只决定有哪些模型，绝不决定请求发去哪里——所以要指向别的网关就得改 `lib/index.js`。
- 插件依赖 `llm-pi-ai` 的内部接口。如果 DSH 更新后接口发生变化，插件会记录警告并保留原有目录。

## 许可证

MIT
