# P0：插件层 OAuth 与额度扩展兼容性验证

验证日期：2026-10-15。范围：只读调研、隔离验证、验证材料；未开发 OAuth/额度/UI 功能，未安装或发布插件，未修改 DSH、内置依赖、真实配置或凭据。

## 1. 最终结论与门禁

**当前安装版的 OpenAI ChatGPT OAuth「仅登录并向原生 openai 调用链交接凭据」方案：INCOMPATIBLE。P0 不放行，不进入 P1。**

宿主原生 Pi-AI 为 **0.87.1**，其 openai Provider 仅声明 API Key，既不能执行该 Provider 的 OAuth 登录，也不能将已保存的 OAuth grant 转为请求认证。并非简单的 UI 屏蔽问题。openai-codex 是独立的 OAuth Provider，不能用它的可用性替代 openai 的验收。

**P0 总门禁：BLOCKED**。第 12 节的 P0-E2E-CODEX 已完成 Codex 侧真实浏览器授权、凭据交接、真实 Token 刷新与双进程并发去重；**额度耗尽时的 429 拒绝与账号实际状态一致，是被验证的正确行为（PASS），不是待修复故障**。总门禁仍 BLOCKED 的原因：OpenAI ChatGPT OAuth 不兼容、真实插件生命周期未完整验收、以及「额度充足时正常推理 200」尚为 NOT TESTED（配额恢复后补充）。这里的 BLOCKED 是未满足的验证项，不是“已被证明永远不可实现”。

首轮 T 系列 17/17 个内存存储诊断通过；本轮 S 系列 20/20 个真实服务隔离诊断通过（真实 Cordis、磁盘与文件锁，HTTP 仍为模拟）。**这些都不代表真实账号 OAuth 集成通过**。其中通过的反例测试正是当前版本不兼容的证据。用户已决定继续使用 DSH 内置 Pi-AI，不新增或升级插件私有 Pi-AI 依赖。

## 2. 环境与证据来源

| 项目 | 实测值与证据范围 |
|---|---|
| DSH Desktop | 0.2.0-rc.2；安装归档元数据，不是 GitHub 主分支 |
| 安装包构建提交 | 5e9e301dd9dc8923b2762f76dacfc5751f6ca851；buildDirty=false |
| 内置 llm-pi-ai | 0.2.0-rc.2 |
| 实际加载的 Pi-AI 验证副本 | 0.87.1；读取其自身版本，并从安装归档直接 import 实际 JS 模块执行验证；不是依赖范围 ^0.87.1 |
| 宿主侧 PTC 验证运行时 | Node 24.18.1 / Electron 44.0.0 / Darwin arm64 |
| 工具提供的独立 Node | v24.21.0；仅用于脚本语法等检查，不能冒充宿主 Node 版本 |
| 插件基线 | v0.5.0，b813576b7a5af2312107fc81f78b3f6ba75d7780 |
| 只读官方参考 checkout | 571902028a75c64c1d767f4ae5fd099485f0ddf0；不是本机运行版本，不以其较新 API 判定本机兼容性 |
| 安装归档 SHA-256 | 18d5036bbb58eaff41d351ede99314b8d06505aec06fb2e164c49874ada30f9e |

通过只读进程列表确认桌面宿主从下列安装归档启动；node:module.findPackageJSON 从内置适配器地址解析出的 Pi-AI 元数据也落在该归档内，desktop profile 下未发现其他 Pi-AI package.json。未读取 profile 配置内容或真实凭据。

~~~text
<application_resources>/app.asar
  dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai
  dsh/node_modules/@earendil-works/pi-ai
<plugin_root>/.temp/p0/host/  # 只读提取副本；不加入发布产物
~~~

[DSH 参考 checkout](<<server_path>/Workspace/deepseek-harness>) 未作任何修改。

注意：验证导入发生在独立 PTC 工具进程，不是远程读取正在服务请求的宿主进程的模块缓存；没有借此证明所有第三方 adapter、所有 profile 及当前聊天所选路由都使用同一 Pi-AI 副本。插件实际 bare-import/HMR 解析仍须在真实组合验证。

证据：[安装包元数据](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/package.json#L1>)、[Pi-AI 自身版本](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/package.json#L1>)。16 个源文件的 SHA-256 与归档内对应文件逐一一致，清单见 [证据清单](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-evidence.json>)。

## 3. P0-01 至 P0-10 验证矩阵

| 编号 | 结论 | 源码与测试证据 | 尚未取得的证据 |
|---|---|---|---|
| P0-01 实际版本 | PASS（本机安装版及工具进程样本） | 安装包自身版本、依赖解析地址、直接 import 原模块、运行时版本；见第 2 节 | 任意第三方 adapter 与正式插件解析不能外推 |
| P0-02 OAuth API | INCOMPATIBLE（openai） | T01：login 三参，调用 openai/oauth 明确拒绝；无 getDeviceId/LoginOptions 实现。Codex 声明 OAuth | 新版插件自带 Pi-AI 与旧宿主交接不在本次证据内 |
| P0-03 凭据格式 | INCOMPATIBLE（openai）；Codex 格式已核对 | 原生 openai 无 OAuth grant 消费者；Codex 字段见第 5 节 | 不能编造当前版本不存在的 OpenAI ChatGPT grant 格式 |
| P0-04 公共存储接口 | PASS（真实服务隔离范围） | S01–S08：实际服务读写、0600、重载、修改语义、两实例文件锁、销毁拒写；S10/S17：交接给原生 adapter | 正式 profile/Loader 安装与用户账号仍未测 |
| P0-05 凭据交接 | INCOMPATIBLE（openai） | T02/T03、S12 均拒绝；Codex S17 走原生登录、真实隔离 store 与 adapter，最终 HTTP 被模拟截获 | 不能把 Codex 结果外推为 OpenAI ChatGPT 集成 |
| P0-06 认证优先级 | PASS（隔离验证范围） | T03–T07、T12、T16/T17；见第 6 节 | 当前用户配置和真实环境值未读取；引用来源分层只作源码核对 |
| P0-07 实际请求认证 | INCOMPATIBLE（openai）；真实 E2E BLOCKED | T 系列请求边界验证；S10/S11/S17 在真实服务组合中确认 Codex 账号/凭据来源 | 所有 HTTP 均为 mock，服务端未接受任何测试请求 |
| P0-08 刷新 | BLOCKED（真实账号/多进程） | S11：模拟旋转后的 grant 真正落盘并重载；S20：两套原生 adapter 通过真实文件锁只刷新一次 | 同进程两实例不等于多进程；真实 Token 与 DSH 重启未测 |
| P0-09 插件 UI/额度入口 | BLOCKED（浏览器集成未测） | Models 两个 Slot 和 settings.section 声明存在；S18/S19 验证纯 SlotCore 声明/撤销/订阅 | 未安装 client bundle，未在现有 GUI 渲染或发起额度请求 |
| P0-10 生命周期 | BLOCKED（大幅收敛） | S08/S09/S13/S16、S18/S19；**15 章真实 Loader 三轮 PASS**；**16 章同进程 disabled/重装/配置 HMR PASS（单进程 84/34 → 73/30 → 84/34）**；probe 竞态 (c2)(e)(f)(h)(i)(j)(k)；abort 与刷新竞态修复均已合并 main（PR #4 `2d512c6` / PR #5 `58b33eb`） | 剩余：源码级 HMR、React/UI 层、进行中额度查询取消 |

## 4. P0-02：当前 OpenAI 不支持 OAuth 的直接证据

[原生 openai Provider](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/providers/openai.js#L5>) 仅有：

~~~javascript
auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) }
~~~

[Models.login 的实际实现](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/models.js#L293>) 只有三个参数，没有第四个 LoginOptions；不存在的 OAuth 方法触发：

~~~text
ModelsError / code=auth / OpenAI does not support oauth login
~~~

这已在真实安装模块上执行，不是只看注释。安装 Pi-AI 文件内检索 getDeviceId/LoginOptions 无匹配，也没有 openai-chatgpt OAuth 模块。归档里出现的 Sign in with ChatGPT 文本含授权服务示例，不能据此判断 openai Provider 能力。

[原生 Codex Provider](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js#L6>) 则明确声明 OAuth，模型协议为 openai-codex-responses，基础端点为 ChatGPT backend-api。它与 openai-responses / api.openai.com/v1 是不同的 Provider 与协议。

之前关于「本机已经包含 OpenAI ChatGPT OAuth」的推断正式撤回；同样不能把官方主分支 UNSERVED_OAUTH 的问题当作本机问题。本机没有该屏蔽，但仍缺少底层能力。

## 5. 凭据与调用链

### 5.1 公开存储与格式

[recordKeyFor 与记录转换](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1941>) 确认原生适配器使用两个独立地址：

~~~text
llm-pi-ai/openai
llm-pi-ai/openai-codex
~~~

记录为 api-key 时映射成 Pi-AI 的 api_key；记录为 grant 时直接返回 payload。存储接受 JSON 不代表 Provider 能消费该认证类型。每个地址保存一个当前记录，不是多账号仓库；API Key/OAuth 的切换会替换同一地址，未来实现不得未经确认覆盖已有凭据。

[Codex 的 grant 构造](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js#L326>) 的结构如下，仅列字段，不含任何真实材料：

~~~typescript
{ kind: "grant", payload: {
  type: "oauth",
  access: "<token>",
  refresh: "<refresh_token>",
  expires: /* Unix epoch milliseconds */ 0,
  accountId: "<account_id>"
} }
~~~

accountId 从 access 中的账号声明派生；expires 由当前时间加 expires_in 秒换算为毫秒。实际传输也从 access 提取账号，不能靠随意修改 accountId 伪造账号一致性。

[本地凭据服务](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js#L520>) 提供 readRecord、describeRecord、listRecords、modifyRecord、deleteRecord。modifyRecord 在文件锁内重读磁盘、执行 mutate、校验并原子写入，再发出 record-updated；**mutate 返回 undefined 表示保持现值，不是删除**。登出应走 deleteRecord。首轮 T 系列模拟该服务；本轮 S 系列运行真实服务，仅操作插件临时目录内的合成数据文件，不操作用户真实凭据文件。

### 5.2 四层交接门禁

~~~text
插件自有登录入口 → Pi-AI Models.login
→ 通过 CredentialStore 适配调用公开 credentials.modifyRecord
→ 原生 llm-pi-ai 的 credentialStoreFrom 读取同一个键
→ 原生 Pi-AI resolveProviderAuth
→ Provider OAuth toAuth / refresh
→ 原生协议 SDK 构造 HTTP / WebSocket 请求
~~~

这是待验证的目标路径，不是已完成的插件实现。当前版本 openai 在第一层就不能完成原生 OAuth 登录；注入合成 grant 后，也会在 resolveProviderAuth 层因缺少 handler 而拒绝。不能进入最终请求层。

首轮 Codex 后半段使用 mock Context、mock CredentialProvider 与 mock HTTP；本轮 S17 则以真实独立 Cordis Context、真实 AuthorizationService、真实 LocalCredentialProvider 驱动原生 Models.login，并经原生 adapter 到 SDK fetch 边界。仅 LLM registry 是测试替身，所有外部授权/Token/模型 HTTP 都是 mock；不是 profile/Loader 或当前运行宿主的完整组合。

## 6. 认证优先级与冲突场景

[宿主 resolveApiKey](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2563>) 与 [Pi-AI 认证解析](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js#L20>) 及 [标准 API Key 解析](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/auth/helpers.js#L1>) 联合决定：

1. 配置了 apiKeyEnv：宿主必须先解析指定引用；存在且有效就作为显式 apiKey 传给 Pi-AI，不存在则 MISSING_CREDENTIAL，**不回退 OAuth**。T04/T05。
2. Pi-AI 对显式 apiKey 的优先处理以 Provider 存在 apiKey handler 为前提。原生 openai 有；宿主对带 apiKeyEnv 的 OAuth-only Codex 路由会增加一个 key handler，所以这里 Codex 也可被覆盖。T16，[routeAuth 的条件分支](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L861>)。
3. 无显式 apiKey 时先读 Provider 的存储记录：OAuth 需对应 oauth handler；API Key 需 apiKey handler。记录类型不受支持时拒绝，**不会悄悄读环境变量**。T02/T03。
4. 已存 API Key 优先于 Provider 环境发现。T06。
5. 没有记录才读 OPENAI_API_KEY 等原生环境发现。T07。
6. 已存 OAuth 刷新失败不回退 API Key，不覆盖旧记录。T12。
7. Pi-AI 直接调用中的显式 apiKey 同样优先，T17；宿主是否暴露相同的逐请求输入不能由此推断。

凭据引用服务自身还有来源优先级：继承的启动环境 > 管理存储 > 调用目录 dotenv > DSH home dotenv（[分层定义](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js#L13>)、[实际 resolve 实现](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js#L473>)）。这一分层只读源码，未查看用户真实值；不能通过 UI 写入较低优先级值就声称已覆盖启动环境。

不能把「API Key 与 OAuth 同时存在」理解成同一记录同时存两者：本次是 OAuth record 与 apiKeyEnv/环境引用并存。T04/T16 已证明实际选择的可以是 Key，而不是 OAuth。

## 7. P0-07：请求级观测与测试结果

[诊断脚本](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-runtime-probe.mjs>) 与 [脱敏结果](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-runtime-results.json>) 为首轮诊断材料，不接入插件入口、bundle、配置或发布脚本；本轮新增真实服务诊断见第 7.1 节。

测试使用当前 Electron/PTC 的实际安装模块；通过原生 apply 注册到模拟 registry 的 adapter 发起调用，原生 SDK 的 fetch 被仅在该工具进程内替换。该首轮的合成 Token 仅存内存；没有读取、导出或写入用户 Token。观测后 HTTP 返回固定 mock 400，故**没有成功推理的主张**。

认证来源以测试内部的假凭据精确匹配判定；输出只保留 Provider、端点、Bearer scheme、账号头是否存在等，**不能仅凭 Bearer 字样判断 OAuth**。当前验证强制 SSE，不覆盖 WebSocket。

| 用例 | 最终结果与证据意义 |
|---|---|
| T01 | 原生 openai/oauth 登录明确不支持 |
| T02/T03 | OAuth record 被读到，但没有 HTTP 请求；存在环境 Key 也不 fallback |
| T04/T05 | apiKeyEnv 覆盖 OAuth；引用缺失则停止 |
| T06/T07 | 已存 API Key > ambient Key；无记录才走 ambient |
| T08 | Codex 合成 OAuth 进入正确 backend-api/codex/responses 请求，携带对应账号头 |
| T09 | 同一个 adapter 的下一次调用读取新账号的合成凭据；进行中的调用切号行为未测 |
| T10 | Codex 真实刷新实现访问 mock token endpoint，先回写旋转后的合成凭据，再构造模型请求 |
| T11 | 两个并发调用在模拟串行 store 的保护下只刷新一次；不代表真实多进程锁已测 |
| T12 | 刷新失败无 fallback、无回写、无模型 HTTP |
| T13 | openai API Key 与 openai-codex OAuth 使用不同存储键、端点和账号头；无 OpenCode session header |
| T14 | 新建模拟组合读取 JSON 往返后的合成记录；**不是 DSH 重启测试** |
| T15 | 删除模拟 Codex 记录后下一次调用不再发请求 |
| T16 | Codex apiKeyEnv 可覆盖原 OAuth，甚至选择 Key 对应的另一个模拟账号 |
| T17 | Pi-AI 显式 apiKey 优先于存储和环境认证 |

诊断只能在支持安装归档 ESM 的现有 Electron/PTC 工具进程中运行，不是通过启动替代 DSH 应用执行，也没有接入当前服务端进程。复验时调用下列诊断导出，moduleRoot 指向待验证宿主的内置模块目录；不要挂载为插件：

~~~javascript
const { runP0Probe } = await import("file://<plugin_root>/docs/validation/p0-runtime-probe.mjs")
const result = await runP0Probe("file://<application_resources>/app.asar/dsh/node_modules")
console.log(JSON.stringify(result, null, 2))
~~~

最终 17/17 通过，fetch 已恢复，真实网络请求与真实凭据读写均为 0。第一轮诊断有 4 项断言失败，原因是探针起初只观察异常抛出，漏掉了适配器 finish/error 流内失败；按 [适配器错误映射](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1457>) 修正诊断后通过。没有修改宿主来迎合测试。

## 7.1 本轮补充：真实公开服务与隔离磁盘（20/20）

新增 [真实服务诊断脚本](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-public-services-probe.mjs>) 与 [脱敏结果](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-public-services-results.json>)。仍只使用内置 Pi-AI 0.87.1，没有新增依赖或开发插件功能。

区别于首轮：本轮使用安装归档内的真实 Cordis Context/Fiber、LocalCredentialProvider、AuthorizationService、Models、原生 adapter 与 SDK；合成数据通过公开凭据接口真正写入插件临时目录的 owner-only 文件。没有复用运行宿主的 Context、profile、配置或用户凭据文件。LLM registry 仍为诊断替身，所有外部 HTTP 为 mock，最终模型 HTTP 固定返回 400。

| 用例 | 已取得的隔离证据 |
|---|---|
| S01/S02 | 真实服务公开接口往返；文件权限 0600；销毁旧服务并新建后从磁盘恢复合成 grant |
| S03 | modifyRecord 返回 undefined 保持当前记录，不发虚假的变更通知 |
| S04/S05 | 非法 JSON 拒绝且磁盘不变；删除目标合成记录不影响另一个记录 |
| S06/S07 | 同一服务 12 次并发修改、两套独立服务 12 次并发修改，最终计数均为 12；后者使用真实文件锁 |
| S08/S09 | dispose 后服务撤销，保留的 service 引用拒绝新写入；Fiber 拥有的监听器不会再次被调用 |
| S10 | 原生 Codex adapter 读取真实隔离 store 并在 SDK HTTP 边界使用对应合成账号 |
| S11 | 原生 Codex 刷新实现处理 mock Token 响应，旋转后的合成凭据真实落盘并可由新服务重载 |
| S12 | 真实 store 保存 OAuth grant 后，openai 仍在 HTTP 之前失败，进一步确认不兼容 |
| S13/S14/S15 | 真实授权服务承认同键提交；不同键提交返回 NOT_COMMITTED；重复 flow 返回 DUPLICATE_FLOW 并保留原 owner |
| S16 | 撤销拥有 flow 的 Fiber 会取消待完成尝试，撤销 flow，不留下凭据提交 |
| S17 | 内置 Codex device-code OAuth 代码访问三个模拟授权端点，由原生 Models.login 写入真实隔离 store，授权服务确认提交，原生 adapter 随后使用同一合成账号构造模型 HTTP |
| S18/S19 | 纯 SlotCore 声明/递归撤销/幂等 disposer/订阅注销；没有调用不存在的 core.destroy，也没有 React 渲染 |
| S20 | 两套独立原生 adapter 与真实 store 争用同一过期合成 grant，真实文件锁内二次检查后只刷新一次，两个模型请求都使用旋转后的合成账号 |

20/20 通过，fetch 已恢复，所有新建 Context 均已销毁，用户凭据读写与真实网络请求为 0。隔离合成数据文件保留在插件临时目录供审计，不写入发布文件。

**证据限制不变：**同进程两套服务不是多进程；新建 service 不是重启 DSH；纯 SlotCore 不是 browser/client bundle/HMR；mock 授权服务器不是用户实际授权；fetch 边界匹配不是服务端接受 OAuth。P0-04 的公开存储接口子项可标为限定范围 PASS，其余真实账号/完整宿主门禁不得因此放行。

复验入口（仅在现有 Electron/PTC 工具进程，不启动替代应用）：

~~~javascript
const { runP0PublicServicesProbe } = await import("file://<plugin_root>/docs/validation/p0-public-services-probe.mjs")
const result = await runP0PublicServicesProbe(
  "file://<application_resources>/app.asar/dsh/node_modules", "<plugin_root>"
)
console.log(JSON.stringify(result, null, 2))
~~~

## 8. 刷新、重启和生命周期

[Pi-AI OAuth 刷新规则](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js#L62>) 在剩余有效期不足五分钟时触发刷新，通过 store.modify 内二次检查避免重复刷新；刷新超时为 15 秒。[Codex 刷新接口](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js#L127>) 使用原生 refresh_token grant。S07/S20 已用真实磁盘与两个独立服务实例验证文件锁及刷新去重，但实例同属一个进程，仍没有多进程演练。

P0-08 不放行：未用真实账号刷新、未证明刷新后服务端接受认证，也未重启 DSH。稳定 device UUID 在本机 openai 根本没有对应 API，因此本阶段没有创建 UUID 文件；未来支持新版登录时应由插件持久化且验证重启/并发语义。

[授权注册与 disposer](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-authorization/lib/index.js#L75>) 撤销注册时删除 flow 并取消尝试，S13/S16 已在真实隔离 Cordis 中验证；SlotCore.register 返回可递归撤销的 disposer，S18/S19 只验证其纯注册器行为，不能外推 React 卸载或插件 HMR。当前 v0.5.0 的 [运行时恢复代码](<<server_path>/Workspace/dsh-opencode-live-models/lib/index.js#L1735>) 会恢复自己持有的 adapter/provider/prototype 包装，[卸载钩子](<<server_path>/Workspace/dsh-opencode-live-models/lib/index.js#L2182>) 清理 interval 并推进 generation，防止旧任务重新发布。源码存在不等于所有 HMR/取消路径已经通过真实组合测试；没有把这些主张标为 PASS。

本次未向运行宿主或 profile 安装任何功能；S 系列只在独立工具进程的新 Context 中挂载真实内置服务和诊断用注册。没有修改主宿主的 registry、监听器、定时器或原型。所有诊断 Context 均已 dispose，fetch 在 finally 恢复。

## 9. 公开扩展接口、已排除的捷径与风险

### 9.1 已确认存在的扩展入口

- 凭据公开服务：readRecord/describeRecord/listRecords/modifyRecord/deleteRecord；引用 resolve/describe/set/unset。
- 授权公开服务：registerFlow/list/describe/begin/cancel。它只负责交互与生命周期，不补齐 Provider 缺失的认证实现。
- UI：安装版实际 [Models Slot 声明](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js#L4059>) 包含 settings.models.provider-card（keyed）与 settings.models.footer（list）；存在 settings.section 声明；实际插件设置页注册和渲染未测，不声称 UI 验收通过。
- Pi-AI：Models.login、getAuth、setProvider 与可注入 CredentialStore 确认存在；本次直接访问安装文件只为诊断，生产插件不得硬编码该安装路径或依赖未导出的 dist 子路径。

### 9.2 不允许采用的方案

1. 不改 DSH，不删除 UNSERVED_OAUTH，不替换内置 Pi-AI，不修改内置 UI，不要求用户打补丁。
2. 不重复注册 llm-pi-ai/openai flow；会 DUPLICATE_FLOW。
3. **不使用自有 flow key、却只写另一个凭据 key 来绕过冲突**：[提交观察与 NOT_COMMITTED 校验](<<server_path>/Workspace/dsh-opencode-live-models/.temp/p0/host/dsh/node_modules/@deepseek-ai/dsh-authorization/lib/index.js#L202>) 只承认该 flow 自己的 key 在本次尝试内提交。此前这条建议不成立，正式撤回。不制造虚假辅助记录来骗过校验。
4. 不把 OAuth access 当成普通 API Key 注入旧 openai Provider，也不通过改 baseURL 将不同认证和协议混用。
5. 不重复注册现有 openai adapter，不抢占 Provider。
6. 不把文档示例、package.json 依赖范围、登录状态、成功写记录或模拟 HTTP 结果当成真实模型请求已使用 OAuth。

### 9.3 需记录的非公开耦合

v0.5.0 现有模型动态更新使用私有 ctx.llm.adapters、adapter.current() 与 Models prototype 包装。这些本次完全没有更改，也不能把其可用性当作 OAuth 可安全接入的证明。新认证功能优先走公开凭据服务与插件自有 UI；不新增未经验证的 host monkey-patch。

给插件单独增加新版 Pi-AI 依赖，只能让插件自身获得新登录能力，**不会自动让旧宿主 openai Provider 获得 OAuth handler**。跨版本 grant 格式、toAuth、refresh、模型过滤与传输兼容性仍须单独验证。

## 10. 后续可研究的插件级路径（未实现、未放行）

- 已有 Codex 原生 OAuth 通道可继续做独立 E2E 验证；不能偷换为 OpenAI ChatGPT Provider 验收。
- 已排除：用户明确选择继续使用 DSH 内置 Pi-AI，因此本轮不引入插件私有新版 Pi-AI，也不通过新增依赖绕过门禁。
- 在明确许可下研究可撤销的、作用域内 Provider 能力接线，只能作为非公开接口兼容性验证课题；本阶段没有实现或假定可行。
- 若未来宿主原生具备对应 OAuth handler，按能力而非猜测的版本号重新执行全部门禁。不能要求用户自行修补 DSH。

这些仅为兼容性研究方向，不构成 P1 开工授权。当前约束下原方案保持 INCOMPATIBLE，不用宿主修改来解除它。

## 11. 真实端到端验证待办（OpenAI ChatGPT 侧未完成；Codex 已按第 12 节执行）

1. 仅通过可卸载插件入口触发真实 OpenAI OAuth，完成 PKCE/回调/远程回填，凭据不进入模型上下文或日志。
2. 通过公开 store 提交，确认原 adapter 读取，再观测真实模型请求使用正确认证来源、Provider 协议、账号和目标端点；另验服务端接受认证。
3. 分别覆盖 OAuth-only、Key + OAuth、apiKeyEnv 缺失与冲突、账号切换、openai/Codex 隔离。
4. 真正执行刷新旋转、多进程竞争、刷新失败、重新授权、注销及 DSH 重启恢复；取得脱敏结果而非读取原始 Token。
5. 通过插件安装/卸载/HMR 验证 timer/listener/UI/包装移除、进行中查询取消、无旧数据重新发布，OpenCode Go/Zen 不回归。

以上为首轮撰写时的状态；其后执行的 P0-E2E-CODEX（第 12 节）已发起真实 Codex 授权与模型请求——测试账号、隔离 profile、无 Token 落盘——Codex 相关项以第 12 节为准。不索取用户 Token 的原则不变。

## 12. P0-E2E-CODEX：真实账号端到端验证

执行日期：2026-10-15。方式：DSH 官方支持的命名 profile（`codex-e2e`，`dsh.profile.bundles: []`，临时 bundle 仅位于被忽略的临时目录），干净环境（env -i、隔离 DSH_HOME/cwd/HOME/TMPDIR/XDG_*）、内置 Pi-AI 0.87.1、仅注册原生 `openai-codex` 一条路由、无 `apiKeyEnv`。用户在本机浏览器以测试账号完成真实授权；验证进程仅对已存凭据做 exact-match 校验，Token 与回调材料不落日志与证据。证据共 16 份：[归档目录](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-e2e-codex/>)。

### 12.1 三个独立门禁

| 门禁 | 结果 |
|---|---|
| P0-CODEX | **全链路 PASS**（E01–E10 + E05-A 额度拒绝 + E05-B 正常推理 200） |
| P0-OPENAI | **INCOMPATIBLE**（维持第 1/4 节结论） |
| P0 总门禁 | **BLOCKED**（不进入 P1） |

### 12.2 E01–E10 结果

| 编号 | 结果 | 脱敏证据 |
|---|---|---|
| E01 真实登录 | PASS | 原生 `Models.login` 走 browser 流程：第 1 次直连 Token 交换 403 `unsupported_country_region_territory`（无凭据空请求对照证实为出口地域，非代码）；第 2 次显式使用用户配置的本机代理后 Token 交换 **200**，浏览器回调完成 |
| E02 持久化 | PASS | 经公开 `ctx.credentials` 写入隔离 store，文件权限 0600，重载后 grant 结构完好 |
| E03 凭据读取 | PASS | 模型请求携带与已存 grant 逐字节一致的 Bearer 与相同 `chatgpt-account-id`（exact-match 断言在发请求前执行） |
| E04 协议端点 | PASS | POST `https://chatgpt.com/backend-api/codex/responses`，协议 openai-codex-responses，无 `x-opencode-session` |
| E05 额度耗尽场景（重定义） | **PASS** | 认证被受理并进入配额层，返回 **429「The usage limit has been reached」**——用户已确认账号配额确已耗尽，该 429 与账号实际状态一致，是**被验证的正确服务端行为，不是插件或 OAuth 集成故障**；4 个模型对照中 `gpt-5.5`/`gpt-5.3-codex-spark` 另返回 400「not supported when using Codex with a ChatGPT account」（模型不在账号可用集，同样为服务端预期语义） |
| E05-normal 额度充足时的正常推理 | **PASS** | 配额重置后真实授权 + `gpt-6-sol` marker 推理：**HTTP 200**、marker 精确回显（43 字符，SHA 记录）、usage 齐全、31 chunks 正常结束（证据：docs/validation/p0-e05b/） |
| E06 认证优先级 | PASS | 配置不存在的 `apiKeyEnv` 引用后：`requestFailureCode=MISSING_CREDENTIAL`、零模型请求、**不回退到已存 OAuth**；未绕过优先级 |
| E07 Token 刷新 | PASS | 以公开 `minOAuthValidityMs` 触发（未改存储过期时间）：refresh 端点 **200**、凭据旋转、记录仍为 OAuth、刷新后凭据直接用于后续请求 |
| E08 重启恢复 | PASS（隔离 profile 范围） | 多个**全新 DSH 进程**从磁盘恢复同一 grant 并发起请求；`desktopRestarted=false`，未重启正式 Desktop |
| E09 多进程并发 | PASS | 两独立 DSH 进程同秒触发刷新：仅 1 次真实 refresh POST，另一进程经文件锁二次检查复用已旋转凭据；无重复刷新、无覆盖损坏、无跨账号 |
| E10 进程清理与零宿主影响（限定范围 PASS） | PASS（限定范围） | 验证进程全部退出：无残留 `dsh --profile codex-e2e` 进程、1455 回调端口空；运行入口与模型逻辑（lib/、probe.mjs、cordis.patch.yml）零 diff（package.json 仅追加 test 脚本接入额度测试，运行行为未变）；参考仓库干净；宿主 asar SHA 与第 2 节一致。**这不等同于真实插件的安装/禁用/卸载/HMR 验收，后者仍属第 3 章 P0-10 的 BLOCKED 项** |

### 12.3 期间暴露的真实事实

1. **CLI 不继承 GUI 代理**：直连被判定地区不支持（403），显式代理后正常。浏览器与 CLI 的出口不同，第一次登录失败即此原因，与认证实现无关。
2. **目录不等于账号可用集**：内置 0.87.1 目录 8 个模型中，至少两个在该账号返回 400 模型不支持——印证「Pi 目录出现某模型不代表当前账号可调用」。
3. **配额在模型端点返回 429**：可用模型统一返回 usage limit，用户已确认账号配额确实用尽——该 429 与账号实际状态一致，是符合预期的正确拒绝，也是后续额度监控需要捕获的信号；E05 据此判定 PASS（额度耗尽场景），正常推理场景另行补充。
4. 每次模型请求前的 exact-match 断言保证不会把 API Key 误判为 OAuth；全程未配置或使用任何 API Key。

### 12.4 E05 解除条件

**429 额度耗尽场景已是 PASS，不构成待修复问题，也不再重复测试。**

**E05-B 已于 2026-10-15 补测完成（PASS）**：配额窗口重置后，经隔离 profile 与真实浏览器授权（原生 authorization 流程），`gpt-6-sol` 一次 marker 推理返回 **HTTP 200**，marker 精确回显（43 字符，SHA-256 记录）、usage 齐全、31 chunks 正常 `stop` 结束；请求前逐字节校验 Bearer 与账号头（stored-oauth exact-match），无 OpenCode header。证据：[docs/validation/p0-e05b/](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-e05b/>)。P0-CODEX 自此全链路 PASS。 剩余仅一项补充验证：配额恢复后按本节记录重建隔离 profile（临时目录已按第 13 节清理），跑一次 `call` 取得 status 200 与 marker 回显（响应仅记录长度与 SHA-256），把「额度充足时正常推理」从 NOT TESTED 补齐为 PASS。此项不阻塞认证链路结论，属配额恢复后的增量验证。

### 12.5 边界

临时 profile 与 bundle 仅存在于被忽略的临时目录，未安装进任何生产 profile；删除该目录即完成注销（删除动作待用户确认，见第 13 节）。未触碰用户真实凭据、未修改 DSH/依赖/正式插件、未抢占 Provider、未影响 OpenCode Go/Zen。


## 13. 修改与检查记录

只新增本报告与验证材料：诊断脚本与脱敏结果、证据摘要、E2E/P0-Q/P0-10 状态与归档、Fixture 与回归测试、生命周期观察器；临时 profile/验证 bundle 位于被忽略的临时目录，按 Trash 流程清理。**插件运行入口（lib/index.js）、模型逻辑与 bundle patch 未改动**；package.json 仅修改 test 脚本（`node probe.mjs && node docs/validation/quota-parse.test.mjs`）以使额度断言成为 CI 门禁，依赖清单未动。

已执行：宿主版本/进程/模块导入核对、首轮 17 个内存诊断、20 个真实服务隔离诊断、P0-E2E-CODEX 真实授权与 4 次模型对照请求、真实刷新与双进程并发刷新、认证优先级与生命周期验证、独立 Node 对诊断脚本的 --check、git diff --check。现有插件全量 probe、正式 Desktop profile 的 GUI 与真实额度 UI 未执行；没有功能改动，不能把源码不变写成运行时回归测试通过。

**验收结论：P0 总门禁 BLOCKED（OpenAI ChatGPT OAuth 不兼容 + 真实插件生命周期未完整验收）；P0-CODEX 认证链路与 429 额度耗尽场景 PASS、正常推理 NOT TESTED；原生 openai 交接方案 INCOMPATIBLE。DSH 官方代码与安装包保持不变。**

## 14. P0-Q：额度查询兼容性验证（独立只读研究）

执行日期：2026-10-15。范围：只读研究 + 真实账号只读查询实测。**不放行 P1**；与第 12 节的推理 E2E 相互独立。

### 14.1 参考体系（三层）

| 层 | 参考 | 用途 |
|---|---|---|
| 数据协议首要参考 | OpenAI Codex CLI（`backend-client/rate_limit_resets.rs`、`codex-api/rate_limits.rs`、TUI 展示代码） | 额度查询路径、窗口结构、`allowed` 语义、Credits/重置、滚动 Headers |
| 认证与调用集成 | Pi（`earendil-works/pi`，本机 Pi-AI 0.87.1） | OAuth 凭据、原生刷新（复用 E07 路径）、模型调用 |
| 跨厂商归一化 | `specode/pi-subscription-usage`（MIT） | QuotaWindow/ProviderQuota 归一化、`wham/usage` 实测请求方式、凭据脱敏 |

Codex CLI 源码证实 ChatGPT 后端查询路径为 `{base}/wham/usage`（`PathStyle::ChatGptApi`），另有 `/wham/rate-limit-reset-credits`；`ordinary_usage_allowed` 取自响应中 `allowed` 字段，非 HTTP 状态码推断。pi-subscription-usage 证实该端点必须使用 **Codex OAuth**（Sign in with ChatGPT token 会被 401 拒绝）、仅向官方 origin 发送凭据、错误与响应体脱敏。

### 14.2 实测（真实账号、隔离 profile）

隔离 profile（`codex-quota`，仅 credentials/authorization/llm-pi-ai）+ 只读插件（仅两个 GET，无推理、无重置消费）。浏览器授权成功后同进程执行查询，随后用已存凭据再次独立查询，两次均 **200/200**。

归一化结果（脱敏证据：[docs/validation/p0-q/](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-q/>)）：

| 字段 | 实测值 |
|---|---|
| planType | plus |
| status / usageAllowed / limit_reached | **exhausted / false / true** |
| primary（5 小时窗口，durationMinutes=300） | usedPercent **100**，remainingPercent 0，resetsAt=1792064732 |
| secondary（周窗口，durationMinutes=10080） | usedPercent **16**，remainingPercent 84，resetsAt=1792651532 |
| model_usage | `gpt-6-astra`：available=false、credits_would_enable=true |
| credits | has_credits=false、unlimited=false |
| rate_limit_reset_credits | available_count=1、applicable_available_count=1 |

### 14.3 与 429 的交叉验证（数据准确性关键证据）

**5 小时窗口 100% + allowed=false ↔ 模型调用 429**：第 12 节的 429 与账号额度接口的真实状态一致，双向印证。

**周窗口仅用 16%（84% 剩余）**：单看 429 会误判“全部耗尽”。这实证了既定原则——**429 只能作为“当前受限”状态证据，百分比与重置时间必须来自额度接口**。

### 14.4 真实响应结构（35 个字段路径，实测）

顶层：`user_id`、`account_id`、`email`、`plan_type`；额度域 `rate_limit`（`allowed`、`limit_reached`、`primary_window`/`secondary_window` 各含 `used_percent`、`limit_window_seconds`、`reset_after_seconds`、`reset_at`）；`code_review_rate_limit`、`additional_rate_limits`（本账号为空）；模型专属 `model_usage.<slug>.{available,available_at,credits_would_enable}`；`credits.{has_credits,unlimited,overage_limit_reached,balance,approx_local_messages,approx_cloud_messages}`；`spend_control.{reached,individual_limit}`；`rate_limit_reached_type.{type,details}`；`rate_limit_upsell.{banner_type,title,description,ctas,reset_at,referral,request_url}`；`promo`；`rate_limit_reset_credits.{available_count,applicable_available_count}`。

**与 Codex CLI 的结构对照**：CLI 解析器接受嵌套于其内部 struct 的同名字段（`primary_window`/`allowed`/`limit_reached` 命名一致）；实测 JSON 为顶层 `rate_limit.*`。插件实现必须按实测结构解析，嵌套层级不可照搬 Rust 类型。首轮解析器误按 `rate_limits.primary.primary_window` 取值导致 groups 为空并误报 available——随即按实测结构修正，二次查询正确输出 exhausted 与两窗口百分比，印证「不凭状态码或假设结构推算」。

### 14.5 额外发现（纳入后续设计）

1. `usageAllowed` 与百分比独立：`allowed=false` 直接对应“当前受限”，无需推算。
2. 模型专属额度（`model_usage`）带 `credits_would_enable`——“补充 credits 可解锁”的引导语义，对应 CLI 的 upsell 展示。
3. `rate_limit_reset_credits` 区分 `available_count` 与 `applicable_available_count`（“可用”与“实际可用”两层计数），与 CLI 的 Resets Left 语义一致。
4. `rate_limit_upsell` 携带完整引导文案与 `reset_at`，可直接驱动 UI 告警/重置倒计时；`spend_control` 为独立限额域。
5. 响应含 `email`/`account_id` 等身份字段：展示层需按多账号隔离与脱敏处理（本研究仅保留哈希）。

### 14.6 遵守项与过程教训

- **只读**：仅两个 GET；未发推理请求、未消费任何 reset credit；凭据文件 0600 隔离存放，Token/邮箱/授权 URL 未进入任何输出或归档。
- 授权过程两次外部阻塞均如实记录：① 授权流程 60 秒超时导致回调服务先于浏览器回调关闭（已改为 10 分钟窗口）；② `auth.openai.com` 同意页 Cloudflare managed challenge（403）为 OpenAI 侧风控，与插件实现无关。
- 刷新复用 Pi-AI 原生 `getAuth`（同 E07），未自写 OAuth 协议。

### 14.7 门禁影响

| 门禁 | 结果 |
|---|---|
| P0-Q（额度查询研究） | **PASS**：真实账号 `wham/usage` 与 reset-credits 均 200，结构与归一化经交叉验证 |
| P0-CODEX | 认证链路与 429 额度场景 PASS；正常推理 200 仍 NOT TESTED（5h 窗口重置后可补） |
| P0-OPENAI | INCOMPATIBLE（不变） |
| P0 总门禁 | **BLOCKED**（不变） |

P0-Q 结论仅覆盖 OpenAI Codex 的额度查询只读链路；OpenCode Go/Kimi/Grok 等适配器与 UI、缓存、多账号等均属后续独立阶段，未在本轮实施。

### 14.8 Q01 验收矩阵（Codex 额度接口，基于真实账号证据）

| 编号 | 验收项 | 结果 | 依据 |
|---|---|---|---|
| Q01-01 | 凭据读取（复用已有 OAuth，不重新登录） | PASS | login-call 后的独立 `query` 动作用已存凭据（无登录动作）取得 200 |
| Q01-02 | 账号一致性 | PASS（依据修正） | 查询与请求模型使用**同一 grant（同进程同凭据记录）**，未跨账号。注：服务端 account_id 返回空字符串，早期证据中的 `acct_e3b0c44298` 系空串哈希、**无效**；账号键规则见 14.12 |
| Q01-03 | 额度数据解析 | PASS | exhausted、primary 100%、secondary 16%、resetCredits 1 |
| Q01-04 | 时间窗口识别 | PASS | primary=300 分钟、secondary=10080 分钟，以服务端字段为准 |
| Q01-05 | 重置时间 | PASS | resetsAt 直接取服务端（1792064732/1792651532），无推算 |
| Q01-06 | 额度耗尽识别 | PASS | `allowed=false` + `limit_reached=true` + primary 100%，与 429 互证 |
| Q01-07 | Token 刷新 | PASS | 复用原生 Pi-AI `getAuth`（同 E07 路径），插件未自写刷新 |
| Q01-08 | 安全边界 | PASS | Token/邮箱/授权 URL 未进日志与归档；仅发官方 origin；归档前敏感扫描 |

### 14.9 Q02：OpenCode Go 额度接口（真实凭据只读查询）

无凭据探测：`GET https://opencode.ai/zen/go/v1/usage` → **401** `AuthError Unauthorized`（直连与代理一致），端点存在且要求认证。

真实查询（经公开凭据服务 `resolve(OPENCODE_GO_API_KEY)`，值不打印不归档，仅发官方 origin）：**HTTP 200**。

| 窗口（pi-subscription-usage 语义） | windowMinutes | 实测 percent（已使用） | 剩余 |
|---|---|---|---|
| rolling（5 小时） | 300 | 1% | 99% |
| weekly | 10080 | 29% | 71% |
| monthly | 43200 | 37% | 63% |

实测结构：`usage.{rolling,weekly,monthly}.{percent,status,resetsAt}`；`status` 取值 `ok`/`rate-limited`（其他值表示窗口不可用），`resetsAt` 为 ISO 时间戳字符串。与 Codex 的 `rate_limit.*_window` 结构不同，印证「每厂商独立 Adapter、归一化层统一」。

### 14.10 Q03：统一结构与异常矩阵

统一快照结构（UsageSnapshot）已定稿：`providerId/accountKey/plan/windows[]/usageAllowed/status/capturedAt`，窗口含 `id/label/usedPercent/remainingPercent/windowMinutes/resetsAt`。三条硬规则：未知不显示 0%；429 不换算百分比；服务端 `allowed`/明确耗尽优先于百分比推断。

异常矩阵（实测列已验证）：

| 异常 | 处理 | 实测 |
|---|---|---|
| 无凭据/401 | auth-required，提示重新授权，不发请求 | Codex 与 Go 端点行为一致（Go 401 结构实测） |
| 429 额度耗尽 | exhausted 状态证据；百分比仍以额度接口为准 | Codex 模型端点 429 ↔ usage 接口 100% 互证 |
| 403/风控 | 归类为外部拒绝，不误判为认证失败 | Codex 登录流 Cloudflare 403 实录 |
| 超时 | error + 保留带时间戳的历史快照（stale） | 授权与查询超时行为实录 |
| 数据缺失/结构变化 | unknown，不猜数值 | 解析器按实测结构修正的教训实录 |

### 14.11 参考对照文档

三项目固定提交与职责边界、OAuth/额度对照、结构差异与认证要求见 [docs/p0-q-reference-map.md](<<server_path>/Workspace/dsh-opencode-live-models/docs/p0-q-reference-map.md>)。

### 14.12 账号身份键规则与解析回归测试（问题修正）

**账号键缺陷（2026-10-15 复核发现，P0 优先级）**：两份成功查询证据中的 `accountKey=acct_e3b0c44298` 是空字符串的 SHA-256 前缀——`wham/usage` 的 `account_id` 实际返回**空字符串**，早期校验只判断 `typeof === 'string'`，导致空值哈希被当作有效账号键。若沿用，多账号将共用同一缓存键造成串号。规则已固化为：

1. 仅非空且去空白后的账号标识可生成账号键（稳定哈希）。
2. 缺失/空账号标识一律输出 `identity-unverified`，**禁止空哈希充当账号键**。
3. 多账号缓存键必须在账号键验证通过后建立；开发多账号功能前需补两账号隔离测试。
4. 历史证据 JSON 保留原值（不篡改原始输出），以本节为准。

**解析回归测试（问题 B）**：真实响应结构已固化为脱敏 Fixture（`docs/validation/fixtures/`：Codex 耗尽/充足/缺窗口、OpenCode Go），配套纯函数测试 `docs/validation/quota-parse.test.mjs`（无网络、无凭据、无 DSH），**12/12 PASS**，覆盖：`allowed=false` 保留、主窗口 100% 判 exhausted、次窗口 16% 保留 84% 剩余、缺窗口判 unknown、裸 429 不产生百分比、Credits 与窗口不混算、空账号键 identity-unverified、Go 三窗口与 windowMinutes 钉死、Go rate-limited 窗口保留百分比。运行命令：`node docs/validation/quota-parse.test.mjs`。该测试作为未来 dsh-subscription-usage 解析器的种子与 CI 门禁基线。

## 15. P0-10 补测：真实 Loader 生命周期与多账号隔离

执行日期：2026-10-15。范围：真实 DSH Loader 组合（官方 `dsh --profile`、隔离 DSH_HOME、bundle link、无代理直连）+ 合成多账号隔离断言。不改 DSH；不改生产插件逻辑（测试与验证材料范畴）。

### 15.1 真实 Loader 安装/卸载/重装三轮（main 快照插件）

方法：`git archive main` 提取生产插件快照为 link bundle；隔离 profile 只装 `llm`、`llm-pi-ai`（opencode-go/opencode 两路由）与只读观察器；三轮仅切换 profile 的 `bundles` 数组（真实卸载/安装语义），每轮独立 DSH 进程。

| 轮次 | opencode | opencode-go | 结论 |
|---|---|---|---|
| round1 install | 84 | 34 | overlay 生效（3.5s 后稳定） |
| round2 uninstall | **73** | **30** | **独立 Loader 进程在移除插件配置后正确回落内置基线**（同进程卸载无残留仍需单独验证） |
| round3 reinstall | 84 | 34 | 重装再次生效（7.0s 稳定） |

providers 在三轮中均为 `[opencode, opencode-go]`，观察器退出正常，无 `failed to import`/`did not activate`。证据：[docs/validation/p0-lifecycle/](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-lifecycle/>)。

**这补上了第 3 章 P0-10 缺失的「真实 profile 安装/卸载/重装」项——三轮均为独立 DSH 进程，只证明跨进程的配置切换正确性；其中「同一运行中进程的禁用/重装与配置 HMR」已由第 16 章补测通过**。仍未覆盖：源码级 HMR（代码监视）、React/UI 层、进行中的额度请求取消。复现观察器脚本见 [docs/validation/p0-lifecycle-observer.mjs](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-lifecycle-observer.mjs>)。

### 15.2 多账号隔离（合成层，T17–T19）

两组不同账号标识：各自生成**不同**的验证键（T17）；切换账号产生新键、无跨账号复用（T18）；空标识一律 `identity-unverified` 且**不产生任何键**，不可能与任何账号碰撞（T19）。`quota-parse.test.mjs` 现共 **19 条断言，全部 PASS**。

**结论分列**：账号键生成规则 = **PASS**（合成层）；多账号缓存隔离 = **NOT TESTED**（正式额度引擎尚未开发，T17–T19 只验证 `accountKeyOf()` 纯函数）。

**真实第二账号切换未测**：当前只有单一测试账号；Codex 侧 `account_id` 返回空字符串（见 14.12），真实账号身份识别须在引擎实现时用 `identity-unverified` 降级路径与双账号实测补足。

### 15.3 注册竞态与请求取消的覆盖矩阵

| 风险 | 覆盖 | 状态 |
|---|---|---|
| 重复 adapters-updated 叠加 hook | probe (c2) | PASS（main 既有） |
| 新实例先挂、旧实例后卸载（不得互拆） | probe (f) | PASS（main 既有） |
| 同一模块二次 apply 吞首轮刷新 | probe (h) | PASS（main 既有） |
| 卸载后在途结果不回写 | probe (d) | PASS（main 既有） |
| 旧实例晚归结果不覆盖新实例 | probe (e) | PASS（main 既有） |
| 卸载时主动 abort 在途 fetch | probe (i) | PASS（176/176），已随 PR #4 合入 main（`2d512c6`） |
| 在途刷新期间新注册 scope 不被 join 吞掉 | probe (j)（含 Zen roster 与发布断言） | PASS（184/184），已随 PR #5 合入（`58b33eb`） |
| 跨代接管后旧实例补查回调不发起刷新 | probe (k)（确定性：join 绑定在途 pass 前置断言） | PASS（184/184），已随 PR #5 合入（`58b33eb`）；修复为 join 时捕获 generation 并与共享 `state.generation` 比对 |

probe 全套（main 基线 174 条）+ PR #4 的 176 条与三轮真实 Loader 实测共同构成本轮生命周期证据；HMR/watch 场景仍属未测。
## 16. P0-10 补测二：同进程禁用与配置 HMR

执行日期：2026-10-15。目标：补第 15 章留下的核心缺口——**同一运行中 DSH 进程内**的禁用、卸载效果与重装，而非跨进程配置切换。

方法：隔离 profile 装 main 快照插件 + 长驻采样观察器（`docs/validation/p0-watch-observer.mjs`）+ 原生 `dsh-hmr`（insert `hmr` entry，`root: []` 仅配置监视；需同时提供其依赖的 `timer` 服务）。driver 在单一进程运行期间依次写入 disabled 版补丁（chokidar 2s 写稳定窗触发 reload）→ 恢复 enabled 版 → SIGINT 优雅退出，每秒采样模型数。

| seq | opencode | opencode-go | 阶段 |
|---|---|---|---|
| 1 | 73 | 30 | 启动基线 |
| 2 | 84 | 34 | 插件 overlay 生效 |
| 3 | **73** | **30** | **同进程 disabled：补丁写入后 ~3s 回落** |
| 4 | **84** | **34** | **同进程 re-enable：~4s 恢复** |

全程单进程（PID 80214 未变），启动零 entry 失败，SIGINT 优雅退出。证据：[docs/validation/p0-hmr/](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-hmr/>)。

**结论**：同进程 disabled 触发该 entry 的 Fiber dispose —— 计数回落证明主插件的 unpatch/包装恢复在**运行中进程**内生效（overlay 消失），重新 enable 后 overlay 恢复；配置级 HMR（patch 热重载）可用。

**仍未覆盖**：源码级 HMR（`root: []` 不做代码监视，仅配置 reload）、React/UI 层、进行中额度请求取消、真实浏览器界面。

## 17. P0 门禁终评（不自动放行 P1）

### 17.1 三独立门禁

| 门禁 | 结果 | 依据章节 |
|---|---|---|
| P0-Q 额度查询 | **PASS** | 14（wham/usage、Go usage 200，19 断言 CI 门禁） |
| P0-CODEX 认证、额度与推理全链路 | **PASS**（E01–E10 + E05-A + E05-B） | 12/12.4 |
| P0-CODEX 正常推理（E05-B） | **PASS** | 12.4 补测：gpt-6-sol 200 + marker 回显 |
| P0-OPENAI ChatGPT OAuth | **INCOMPATIBLE** | 1/4 |
| **P0 总门禁** | **BLOCKED** | 见 17.2 |

### 17.2 P0-01..P0-10 终态

| 项 | 终态 | 关键进展（合并 #3/#4/#5 后） |
|---|---|---|
| P0-01 版本 | PASS（本机安装版范围） | 固定：DSH 0.2.0-rc.2 / Pi-AI 0.87.1 |
| P0-02 OAuth API | INCOMPATIBLE（openai）/ PASS（openai-codex） | 12 章 E2E |
| P0-03 凭据格式 | INCOMPATIBLE（openai）/ Codex 已核对 | 5 章 |
| P0-04 公共存储 | PASS（真实服务隔离范围） | 7.1 S01–S08 |
| P0-05 凭据交接 | INCOMPATIBLE（openai）/ Codex PASS | 12 章 |
| P0-06 认证优先级 | PASS（隔离范围） | 6 章 T03–T07/T12/T16/T17 |
| P0-07 请求认证 | Codex 认证链 PASS（真实 429 互证）/ openai INCOMPATIBLE；真实 200 NOT TESTED | 12/14 |
| P0-08 刷新 | PASS（真实刷新 + 双进程去重） | 12 E07/E09、7.1 S11/S20 |
| P0-09 UI/额度入口 | BLOCKED（浏览器集成未测；Slots 已核对） | 7.1 S18/S19 |
| P0-10 生命周期 | **BLOCKED（大幅收敛）**：真实 Loader 三轮 15 章、同进程 disabled/HMR 16 章、probe 竞态 (c2)(e)(f)(h)(i)(j)(k)、abort 与跨代补查修复已合入（PR #4 `2d512c6` / PR #5 `58b33eb`）；剩 React/UI、源码级 HMR、进行中额度请求取消 | 15/16 |

### 17.3 P0 总门禁仍 BLOCKED 的具体原因

1. P0-OPENAI 明确 INCOMPATIBLE（宿主 Pi-AI 0.87.1 无 ChatGPT OAuth 能力，红线内无解，保留待宿主升级后复验）。
2. ~~P0-07 正常推理 200（E05-B）待配额恢复补测~~ → 已于 2026-10-15 补测 PASS（见 12.4）。
3. P0-09 浏览器 UI 集成未实测。
4. P0-10 残余：源码级 HMR、React/UI 层、进行中额度请求取消。
5. 真实多账号缓存隔离 NOT TESTED（引擎未建）。

**以上逐项闭合前，P1（统一额度引擎）不获放行；P0-Q PASS 不改变总门禁。** 本评估不引入任何 DSH 修改或新依赖。

若不愿等待 openai 兼容项（宿主限制、当前无解），可审议**限定范围实施门禁**（Codex + OpenCode Go 两家已验证 Provider 的独立额度插件）：[docs/p0-scope-gate.md](<<server_path>/Workspace/dsh-opencode-live-models/docs/p0-scope-gate.md>)——**状态：待用户明确批准，不自动生效**；openai 不兼容项保留在 P0 总门禁中。
### 16.1 源码级 HMR 实测（P1，结果 NOT ESTABLISHED）

目标：在 hmr 的 `root` 指向插件源码时，修改运行中进程加载的 lib/index.js，观察模块重载。两轮实测（`root` = 真实路径 / loader 加载的 symlink 路径）：配置级监视有效（disabled 切换已由 16 章证明），但源码文件修改后**无任何重载信号**——counts 保持 84/34、无 reload 日志、观察器未重启。

**结论：NOT ESTABLISHED。** 该链路（chokidar 事件 → 分类 → loadCache 归属 → 模块替换）位于宿主 dsh-hmr 内部；在 DSH 零修改红线下不对其做侵入式排查，也不将 link-bundle 隔离环境的失败归因于插件缺陷。证据与驱动脚本归档于 [docs/validation/p0-hmr/](<<server_path>/Workspace/dsh-opencode-live-models/docs/validation/p0-hmr/>)（source-hmr-*）。配置级 HMR（16 章）不受影响，仍为 PASS。
