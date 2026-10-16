# 限定范围实施门禁：Codex + OpenCode Go 额度插件（已批准）

状态：**已批准**（2026-10-16，用户明确确认限定范围：仅 Codex + OpenCode Go 的独立额度插件）。批准范围依据本文十项验收；**P0 总门禁保持 BLOCKED**，openai 不兼容项不因此关闭；发布前所有 “NOT STARTED/部分” 项必须转 PASS。

## 背景

P0 总门禁包含原生 `openai` ChatGPT OAuth 项，其不兼容源于 DSH 内置 Pi-AI 0.87.1，在 DSH 零修改红线下当前无解。若坚持全部 Provider 全部兼容才能启动额度插件，Codex 与 OpenCode Go 已完成的真实验证将无法转化为功能。本门禁提议将**实施范围限定**在两家已验证 Provider，把 openai 不兼容项从该插件的前置条件移出（但保留在 P0 总门禁与兼容性研究中）。

## 范围

| 在范围内 | 不在范围内 |
|---|---|
| OpenAI Codex 额度（原生 OAuth，wham/usage 200 已验证） | OpenAI ChatGPT OAuth（INCOMPATIBLE，保持研究项） |
| OpenCode Go 额度（OPENCODE_GO_API_KEY，/zen/go/v1/usage 200 已验证） | Kimi / Grok / Zen / DeepSeek 等（后续批次独立验收） |
| 独立插件 `dsh-subscription-usage`（只读额度查询与展示） | 模型动态更新职责（留在 dsh-opencode-live-models） |
| 额度重置 / Credits 消费等写操作 | （全部排除：只读为默认，写操作不在本门禁） |

## 验收门禁（依据既定十项标准，当前状态）

| 验收类 | Codex | OpenCode Go | 备注 |
|---|---|---|---|
| OAuth/认证兼容性核对 | PASS | PASS | 报告 12/14；三层参考固定提交 |
| 不抢占 Provider、不覆盖凭据 | PASS（隔离 profile 实测） | PASS | 12/15 章；隔离 profile 未动生产 profile |
| 数据来自真实额度接口 | PASS | PASS | wham/usage 与 go/v1/usage 均 200 |
| 准确性（百分比/窗口/重置时间） | PASS（429 交叉验证） | PASS（语义按 psu 固定版） | 14 章；19 断言 CI 门禁 |
| 安全（不落 Token/不跨 origin） | PASS | PASS | 全程 key 不打印不归档；敏感扫描 CLEAN |
| 异常分类（401/403/429/超时/缺数据） | PASS（实测+Fixture） | 401 实测；其余同源逻辑 | 14.10 异常矩阵 |
| UI 展示未知/过期状态 | NOT STARTED | NOT STARTED | P1 开发期验收项 |
| 生命周期（安装/禁用/卸载/HMR） | 部分（配置级 HMR PASS；源码级 NOT ESTABLISHED） | 同左 | 15/16 章；P1 补齐 |
| 回归（不影响 Go/Zen） | PASS | PASS | probe 187/187 + CI |
| DSH 零修改 | PASS | PASS | 全程宿主 SHA 不变 |

## 放行条件

本门禁**由用户逐项确认后**方可作为 P1（统一额度引擎与 `dsh-subscription-usage`）启动依据：

1. 上表 “NOT STARTED/部分” 项在开发期列为同步验收，不作为启动前置，但**发布前必须全部转 PASS**。
2. 真实多账号缓存隔离、进行中额度请求取消列为开发期硬验收。
3. openai OAuth 不兼容项不因本门禁而关闭。
4. 任一新增 Provider 独立走本门禁十项，不继承两家已验证结论。
