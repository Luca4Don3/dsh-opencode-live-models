# 运行时目录叠加为什么不用 `registerModelDiscovery`

## 起因

DSH 升到 `0.2.0-rc.2`，内置 pi-ai 从 `0.85.1` 升到 `0.87.1`。新版里
`getAllModels` 已经不存在了——插件是运行时探测（`typeof base.getAllModels ===
'function'`），所以不会崩，但它说明 **pi-ai 的 Models 集合接口在漂移**。

插件的做法是 monkey-patch `pi-ai` 里 `opencode-go` provider 的 `getModels`，
耦合在 `llm-pi-ai` 的内部结构上。既然 DSH 提供了 `ctx.llm.registerModelDiscovery`，
就该查清它能不能替代。

## 候选接口

`@deepseek-ai/dsh-llm` 的类型定义（`lib/typert.host.js:150`）：

```ts
registerModelDiscovery(
  settingsNs: string,
  discover: (
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ) => Promise<readonly LlmDiscoveredModel[]>,
): () => void
```

```ts
interface LlmModelDiscoveryRequest {
  provider?: string;
  baseURL?: string;
  api?: string;
  apiKey?: string;
}

interface LlmDiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: readonly ModelModality[];
}
```

DSH 自己在 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2608` 用的就是它：

```js
ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels({
  ...request,
  ...(signal === undefined ? {} : { signal }),
}));
```

## 已验证的边界

以下是读 `app.asar`（`@deepseek-ai/dsh-desktop@0.2.0-rc.2`）与 DSH 内部实现核实的结论：

1. **它是设置页的"候选模型发现"接口。** discovery 的结果保存在一张独立的回调表里，
   供设置页在用户**选中之后**才写入配置。
2. **它不参与运行时目录。** `registerAdapter` 的路由、以及实际的 `listModels()` /
   `getModel()`，都不会把这些候选模型合并进去。
3. **pi-ai 对 `opencode-go` 的 discovery 还会优先返回安装包内的静态目录。**

于是即使不考虑下面的字段落差，单独切到这个 API 也解决不了插件的核心问题——
它改变的是"用户能选到哪些模型"，而不是"运行时目录里有哪些模型"。

## 字段落差（即使上面成立，仍然存在）

| `LlmDiscoveredModel` | 插件实际需要 |
|---|---|
| `id` / `name` / `contextWindow` / `maxTokens` / `inputModalities` | 同左 |
| — | `cost` |
| — | `reasoning`、`compat`、`thinkingLevelMap` |

`cost` 是硬依赖：计费时直接读 `model.cost.input`，缺了会在派发时抛错，而不是计成 0。
`thinkingLevelMap` 承载 DeepSeek 这类模型的 reasoning effort 映射。

## 结论

**保留现有实现。** 它的耦合对象是 pi-ai 的内部结构，风险是 DSH 升级后失效；但
插件对此的行为是"显式警告并保持原目录"，不会静默出错，代价可控。

`registerModelDiscovery` 是一个语义不同的扩展点，拿它来实现运行时目录叠加是
错配。若将来 DSH 提供真正的运行时 catalog 扩展接口（能影响 `listModels()` 的
那种），再评估迁移；在那之前，插件维持现状。

## 附：读 app.asar 的方法

手写偏移解析容易错（header 本身还是一个 Chromium Pickle）。可靠做法是按
`@electron/asar` 的实现：

```js
const sizeBuf = Buffer.alloc(8)
readSync(fd, sizeBuf, 0, 8, 0)
const headerSize = sizeBuf.readUInt32LE(4)   // pickle payload 的第一个 UInt32
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 8)
const strLen = headerBuf.readUInt32LE(4)     // headerBuf 又是 pickle：字符串长度
const tree = JSON.parse(headerBuf.toString('utf8', 8, 8 + strLen))
const dataStart = 8 + headerSize
// 读某个文件：dataStart + Number(entry.offset)
```

`app.asar` 内共 12973 个文件，根 `package.json` 可直接校验解析是否正确。
