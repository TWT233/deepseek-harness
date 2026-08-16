# `@deepseek-ai/dsh-cli-app`

[English](README.md) | 中文

交互式滚动终端应用与完整访问 CLI 组合包。该包导出根运行器插件、[`startup`](src/startup.ts) 命令行 provider（提供方）、[`invariant`](src/invariant.ts) companion（配套实现）、持久 CLI Session（会话）helper（辅助函数）和组合包 patch。

startup 入口通过启动器持有的 [`dsh-cmdline`](../../boot/cmdline/README.md) 服务解析 `dsh --profile cli [--resume <session-id>]` 并发布 `cliStartup`；帮助与用法错误只请求退出，不发布该服务。运行器会等待 Loader settle（稳定），创建或恢复一个 Agent，安装终端命令和用户问题 provider，投影其 Session 日志，并负责按序 teardown（资源清理）Agent、Session 和终端。

包配置默认值如下：

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `showReasoning` | `true` | 使用终端样式显示推理块。 |
| `maxToolOutputLines` | `12` | 每个工具块最多保留这些渲染行。 |
| `maxToolOutputBytes` | `32768` | 每个工具块最多保留这些 UTF-8 字节。 |

滚动 renderer（渲染器）把稳定的行提交到普通 scrollback（回滚缓冲区），只重绘有界活动区。transcript projector（文本记录投影器）消费持久 Session 事件、流式显示推理与文本，并向工具定义请求呈现意图，而不按工具名分支。命令适配器注册 `/help`、`/clear` 和 `/exit`；运行中提交用于引导，空闲提交用于后续轮次，结构化问题 provider 与审批相互独立。

`appendCliSessionMarker()` 依次写入 `sandbox/mode`、`approval/policy` 和必需的 `cli/session` marker（标记）。`readCliSessionMarker()` 要求恰好一个受支持 marker，并校验其 sandbox mode（沙箱模式）和 approval policy（审批策略）与之前的策略事件一致。包 invariant（不变量）仅在 marker 已存在后，对已加载日志与新的 `session/event` candidate（候选事件）应用同一关系，因此 Web 和 Headless Session，以及新 CLI 写入 marker 前的策略事件仍然有效。恢复还要求记录的 workspace（工作区），并选择最新记录的请求模型；只有空白 Session 才回退到部署默认模型。

随附 patch 设置 `danger-full-access` 和 `never` 审批策略，禁用权限选择器，并且不挂载审批 UI。启动块会显示精确 Session ID 以供之后显式恢复，并显示完整访问警告。Loader 或 provider 配置会在获取终端前失败；获取终端后，插件 dispose（资源释放）会先排空 Agent 和 Session，再恢复终端。

## 模型体验

间接影响，通过 CLI persona（角色设定）、native 工具呈现模式，以及承载用户消息、引导、结构化回答、策略事实、assistant 流和工具调用与结果的持久 Session 事件；终端 renderer 不维护第二份模型历史。

#### KV Cache 影响

本包不增加独立的 prompt section（提示词片段）或 tool schema（工具模式）。缓存变化来自组合包选中的 persona、native 工具目录，以及由各自所属插件组装的持久对话状态。

## 已知限制与暂缓事项

- 进程需要 TTY stdin 与 stdout。
- 恢复必须显式请求，只接受同一 workspace 中的 CLI Session，且没有跨进程 lease（租约）；并发进程可能竞争同一 Session。
- 随附 CLI 没有审批 UI 和运行时权限选择器。更高层的 profile 或 home patch 可以替换组合包策略，但 CLI 运行器目前会为新 Session 身份记录随附的 `danger-full-access` 和 `never` 值。
