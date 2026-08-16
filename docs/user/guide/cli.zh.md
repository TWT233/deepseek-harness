# 使用终端 CLI

[English](cli.md) | 中文

本指南将在当前目录中启动交互式 coding Agent（编码智能体），通过多个轮次继续工作，并在之后恢复该 Session（会话）。请使用具备 TTY 输入与输出的终端、Node.js 22.19 或更高版本，并配置模型凭据。

## 在工作区中启动

进入允许 Agent 检查和修改的项目，然后运行：

```sh
npx @deepseek-ai/dsh
```

CLI 会把该目录作为 Session workspace（工作区），并在打开编辑器前显示警告。随附的 `cli` profile 采用 `danger-full-access` 和 `never` 审批策略：命令和工具可以修改 `dsh` 进程能够访问的任何路径，CLI 不提供审批提示。请仅在能够接受这种访问权限的环境中启动。

模型请求的问题仍可交互回答。没有审批 UI 不会屏蔽 Agent 为完成任务而提出的问题。

## 提交任务

输入请求并按 Enter：

> Summarize this repository and identify the next useful change.

终端把完成的输出保留在普通 scrollback（回滚缓冲区）中，只重绘实时 assistant 响应、运行中的工具、问题、状态和编辑器。推理与回答文本会在到达时流式显示。工具行按照各工具的呈现意图显示终端输出、diff、读取、搜索、Web 结果，或者通用回退内容。

提交前按 Alt+Enter 可在多行请求中插入换行。也可以直接粘贴多行文本。

## 引导进行中的工作

Agent 运行期间编辑器保持可用。此时再提交一条消息会引导当前轮次；Agent 空闲时提交则开始后续轮次。

当 Agent 提出结构化问题时，输入选项编号或自定义文本。多选问题使用逗号分隔选项编号，还可在 `;` 后附加自定义文本。

## 使用终端命令

- `/help` 列出当前 Agent 可用的终端命令。
- `/clear` 清除当前终端显示，但不修改 Session，也不擦除已有终端 scrollback。
- `/exit` 在需要时取消进行中的工作、flush Session、恢复终端，并以状态码 0 退出。

Ctrl+C 会取消进行中的 Agent 工作并保持 CLI 打开。在 Agent 空闲时按 Ctrl+C 会以状态码 130 退出。Ctrl+D 或文件结束会正常退出，状态码为 0。

## 恢复 Session

从 CLI Session 数据或周边产品流程中保留 Session ID，回到同一个工作区，然后运行：

```sh
dsh --resume <session-id>
```

恢复必须显式请求：裸 `dsh` 始终创建新 Session。CLI 会在获取终端前拒绝非 CLI Session、不受支持或不一致的 marker（标记），以及不同的当前工作区。恢复后的 Session 使用最新请求 header（头部）中的模型；空白 Session 使用部署当前的默认模型。

## 选择其他界面

如需浏览器工作流，请使用 Web UI：

```sh
dsh web
```

如需自动化运行一次全新任务、打印最终回答并退出，请使用 Headless 模式：

```sh
dsh --profile headless "summarize this repository"
```

确切的参数边界、配置 dump、profile 组合、恢复校验和关闭语义见 [`dsh` 行为参考](../../../apps/cli/reference/README.md)。
