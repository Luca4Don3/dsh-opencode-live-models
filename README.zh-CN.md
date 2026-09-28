# dsh-opencode-live-models

[English](README.md) | 中文

DeepSeek Harness（DSH）自带的 pi-ai 模型目录可能跟不上 OpenCode Go。这个插件在运行时更新目录。

## 安装

在 DSH 插件页面添加，或运行：

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

需要 DSH 0.1.5-rc.1 或更新版本。

## 工作方式

- 从 [Pi 模型目录](https://pi.dev/api/models/providers/opencode-go?types=chat) 读取模型描述符。获取失败时保留已安装的目录。
- Pi 模型目录不可用时，使用内置的 `deepseek-v4.1-flash` 和 `space-bunny-free` 描述符。
- 对照 [OpenCode Go 模型列表](https://opencode.ai/zen/go/v1/models) 检查已安装目录中下线的模型，并报告缺少描述符的模型 ID。

插件更新 pi-ai 中 `opencode-go` 的模型列表。请求仍由已安装的 pi-ai 处理，包括传输和鉴权。

## 限制

- 没有描述符的模型不会出现在选择器中。
- 插件依赖 `llm-pi-ai` 的内部接口。如果 DSH 更新后接口发生变化，插件会记录警告并保留原有目录。

## 许可证

MIT
