# `@deepseek-ai/dsh-cli-app`

[English](README.md) | 中文

交互式终端应用的共享契约与持久 Session（会话）身份。该包导出 rolling terminal（滚动终端）端口、transcript（对话记录）projector（投影器）声明、transcript 限制、CLI Session marker（标记）、marker 写入器与严格 resume（恢复）fold（折叠）。独立的 [`startup`](src/startup.ts) 入口通过 launcher（启动器）持有的 [`dsh-cmdline`](../../boot/cmdline/README.md) 服务解析 `dsh --profile cli [--resume <session-id>]` 并发布 `cliStartup`；help（帮助）与用法错误只请求退出，不发布该服务。

`appendCliSessionMarker()` 依次写入 `sandbox/mode`、`approval/policy` 和必需的 `cli/session` marker。`readCliSessionMarker()` 要求恰好一个受支持 marker，并校验其 sandbox mode（沙箱模式）和 approval policy（审批策略）与之前的策略事件一致。包 invariant（不变量）仅在 marker 已存在后，对已加载日志与新的 `session/event` candidate（候选事件）应用同一关系，因此 Web 和 Headless Session，以及新 CLI 写入 marker 前的策略事件仍然有效。

## 模型体验

间接影响，通过 sandbox 与 approval 插件消费的 Session 策略事件；本包不注册 prompt（提示词）或 tool schema（工具模式）。

#### KV Cache 影响

无直接影响；记录的 mode 与 approval policy 引起的 request context（请求上下文）变化由策略 consumer（消费者）负责。

## 已知限制与暂缓事项

- **当前 checkpoint（检查点）仅提供契约**：rolling terminal、transcript projector、command/question（命令/问题）adapter（适配器）与 runner（运行器）已声明供并行实现，但尚未作为根插件导出。
