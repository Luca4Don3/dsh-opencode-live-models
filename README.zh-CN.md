# dsh-opencode-live-models

[English](README.md) | 中文

DeepSeek Harness（DSH）自带的 pi-ai 模型目录可能跟不上 OpenCode Go。这个插件在运行时更新目录。

## 安装

在 DSH 插件页面添加，或运行：

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

需要 DSH 0.1.5-rc.1 或更新版本，以及**本插件 0.1.2 或更新版本**。

> **0.1.1 仅作版本记录保留，请勿安装。** 其中两个缺陷已在 0.1.2 修复：adapter 注册前到达的名单可能绕过规模校验而隐藏已安装模型；卸载后叠加层不会被撤除，插件已不再维护，选择器却仍显示那些模型。原地升级即可，无需先移除现有安装。

## 工作方式

- 从 [Pi 模型目录](https://pi.dev/api/models/providers/opencode-go?types=chat) 读取模型描述符。获取失败时保留已安装的目录。
- Pi 模型目录不可用时，使用内置的 `deepseek-v4.1-flash` 和 `space-bunny-free` 描述符。
- 对照 [OpenCode Go 模型列表](https://opencode.ai/zen/go/v1/models) 检查已安装目录中下线的模型，并报告缺少描述符的模型 ID。

插件更新 pi-ai 中 `opencode-go` 的模型列表。请求仍由已安装的 pi-ai 处理，包括传输和鉴权。

两个数据源并行获取，且都不被允许"缩小"目录：空、格式错误或明显小于上一轮正常值的响应会被拒绝而不是采纳，因此一次坏响应无法悄悄清空选择器。

挂载过程不等它们。已安装目录加上内置兜底**本身**就是一份正确的目录，所以插件加载的瞬间就发布；网络刷新在其后进行，有变化才再次发布。

被采纳的目录还会落盘，下次启动时读回，因此一次故障不会让你失去那些只有 Pi 才有的模型。DSH 暴露了 profile 目录就写在那里，否则写 `~/.dsh`。缓存读入时会重新校验，超过一周的缓存直接忽略，读写失败也只是跳过。Pi 提供 ETag，所以目录没变时只发一个条件请求，而不是整个响应体。

**怎么看日志。** pi.dev 返回 304 时，插件保留目录和 ETag、不重写文件，所以缓存的 mtime 不变是**预期结果，不是失败**。`catalog updated` 只表示**可见目录发生了变化**，不代表别的：启动时从磁盘恢复缓存也可能触发这一行，而它没出现也说明不了刷新是否成功；首次 `catalog published` 的数量同样不是固定值。受控重启后要确认的是三件事——叠加层已安装、出现了 `catalog published`、且没有 `pi.dev catalog refresh failed`。

## 测试

```sh
npm test
```

用 `test/fixtures/` 中随仓库提交的固件运行 `probe.mjs`——固件抓取自真实端点，新克隆后无需联网或任何准备。

## 限制

- 没有描述符的模型不会出现在选择器中。
- 插件依赖 `llm-pi-ai` 的内部接口。如果 DSH 更新后接口发生变化，插件会记录警告并保留原有目录。

## 许可证

MIT
