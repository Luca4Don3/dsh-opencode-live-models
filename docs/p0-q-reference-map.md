# P0-Q 参考实现对照表（固定版本）

用途：为 OAuth 与多厂商额度查询固定三个开源参考的提交版本与职责边界，作为 dsh-subscription-usage 后续开发的依据。仅研究文档，不改 DSH。

固定提交（获取于 2026-10-15）：

| 项目 | 仓库 | 提交 |
|---|---|---|
| Pi-AI | earendil-works/pi | `4a5d37291531` |
| OpenAI Codex CLI | openai/codex | `2a6ecbb93c42` |
| pi-subscription-usage | specode/pi-subscription-usage | `1015f9f419df` |

## 职责边界

| 参考 | 负责 | 不负责 |
|---|---|---|
| Pi-AI（本机内置 0.87.1） | OAuth 登录、凭据解析、Token 刷新、模型调用 | 额度查询协议 |
| Codex CLI | Codex 额度路径、窗口语义、allowed 判定、Credits/重置 | 跨厂商归一化 |
| pi-subscription-usage | 多厂商 Adapter、归一化、缓存与脱敏错误处理 | 认证协议实现 |

## OAuth 对照（认证来源）

| 项 | Pi-AI（内置 0.87.1） | Codex CLI | 本机 DSH 兼容性 |
|---|---|---|---|
| openai-codex 登录 | browser(device-code) PKCE，localhost:1455 回调 | oauth_session.rs / device_code_auth.rs | PASS（P0-E2E E01 实测） |
| openai (Sign in with ChatGPT) | 0.87.1 **无**该实现（无 getDeviceId/LoginOptions） | 不适用 | INCOMPATIBLE，暂缓 |
| Token 刷新 | resolveStoredOAuth 双检锁 + modifyRecord 文件锁 | 刷新/失效恢复 | PASS（P0-E2E E07、E09 实测） |
| PKCE / state | generatePKCE + state 校验 + manual 竞争 | PKCE + state 校验 | 已在真实登录中生效 |

结论：额度与登录均复用内置 Pi-AI 的 openai-codex 通道；不引入私有新版 Pi-AI；两个 Provider 的 Token 与协议不混用。

## 额度对照（语义来源）

| 项 | Codex CLI 依据 | 实测（P0-Q 第 14 章） | 结论 |
|---|---|---|---|
| 查询路径 | PathStyle::ChatGptApi → `{base}/wham/usage`；`/wham/rate-limit-reset-credits` | 两 GET 均 200 | 以 Codex CLI 为准 |
| allowed 判定 | `rate_limit.allowed`（payload 字段，非状态码） | `allowed=false` 与 429 互证 | allowed 优先于百分比推断 |
| 主/次窗口 | primary/secondary window：used_percent、window_minutes、reset_at | 300 分钟窗口 100%、10080 分钟窗口 16% | 窗口以服务端返回为准 |
| 模型专属额度 | additional_rate_limits + normal_model_slug | `model_usage.<slug>`（available/credits_would_enable） | 实测为顶层 model_usage |
| Credits/重置 | credits 快照、rate-limit-reset-credits | available_count=1、applicable=1 | 区分可用与实际可用 |
| 滚动更新 | x-codex-* Headers + rate limit events | 未启用（先做账号快照） | 后续可选增强，不覆盖完整快照 |

## 结构差异（重要）

Codex CLI 的 Rust 解析接受嵌套于其内部 struct 的 `rate_limit` 字段；实测 JSON 为顶层 `rate_limit.*`（含 allowed/limit_reached/primary_window/secondary_window）。插件按实测结构解析，嵌套层级不照搬 Rust 类型；`model_usage` 同理为顶层域。

## 认证要求（实测）

- `chatgpt.com/backend-api/wham/usage`：必须 Codex OAuth（Sign in with ChatGPT token 会被 401 拒绝，pi-subscription-usage 已注明）。
- `opencode.ai/zen/go/v1/usage`：无凭据返回 401 `AuthError Unauthorized`（直连与代理一致）；路由 `opencode-go` 使用 `apiKeyEnv: OPENCODE_GO_API_KEY`（内置 provider 为 `envApiKeyAuth(..., ["OPENCODE_API_KEY"])`，DSH 路由覆盖为专用 ref）。
- 只向官方 origin 发送凭据；错误与响应体脱敏（沿用 pi-subscription-usage 的 redactUsageError 原则）。

## 统一结构（Q03，UsageSnapshot）

按既定规则实现归一化：未知不显示 0%；429 不换算百分比；服务端 allowed/明确耗尽优先于百分比推断；401/403/429/超时/数据缺失分别分类；stale 数据带时间戳展示。
