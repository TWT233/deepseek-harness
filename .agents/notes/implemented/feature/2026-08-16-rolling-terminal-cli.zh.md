# Agent Note: 将滚动式终端 CLI 作为 `dsh` 默认应用

Status: implemented

[English](2026-08-16-rolling-terminal-cli.md) | 中文

## Problem

已发布的 `dsh` 启动器需要一个无需选择 profile 即可启动的交互式终端应用。Web 和 Headless 已经消费与 provider（提供方）无关的 Agent、Session（会话）、命令、用户问题、工具呈现、持久化和关闭接口，但两者都不提供本地终端工作流。

旧的全屏 TUI 因没有产品组合使用而被移除；其 renderer（渲染器）、带补丁的终端依赖、扩展接口和快照仍会带来产品规模的维护成本。其[移除决策](../simplification/2026-08-04-remove-tui-package.md)要求替代方案具备具名部署、显式包边界、具体交互 provider，以及组装后的生命周期与 transcript（文本记录）验证。

终端工作流还需要为长 Session 提供有界渲染。完成的输出应进入普通终端 scrollback（回滚缓冲区）；应用只应重绘当前流式输出、运行中的工具、问题、状态和编辑器。

## Decision

裸 `dsh` 选择随附的 `cli` profile，其有序组合包为 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-cli-app`。启动器仍是轻量的插件前 bootstrap（引导层），只负责选择 profile、组合 patch 层、提供命令行与进程退出事实，以及启动 Loader。Agent、Session、渲染、命令、问题和终端行为仍由普通插件负责。

裸 `dsh --resume <id>` 选择同一 profile，并把 `--resume` 转发给其 startup 插件。独立的裸帮助和版本仍由启动器处理；应用参数边界之后的帮助会转发给选中的应用。启动器 flag 必须位于应用参数前，因此 `--patch` 位于 `--resume` 前。

随附的 CLI profile 采用沙箱模式 `danger-full-access`、审批策略 `never`，且不提供权限选择器或审批 UI。工具执行仍消费审批服务，其确定性的 `never` 策略无需 answerer（应答方）。稳定启动块会显示精确 Session ID 以供之后显式恢复，并警告用户命令和工具可以修改该进程能够访问的任何路径。模型请求的用户问题仍通过 `ctx.userQuestions` 交互处理。

## Package and profile

`packages/bundle/cli-app` 以 `@deepseek-ai/dsh-cli-app` 发布三个插件入口：

- `@deepseek-ai/dsh-cli-app/startup` 通过 `dsh-cmdline` 解析 `--resume <session-id>` 和应用帮助，然后提供 `cliStartup`。
- `@deepseek-ai/dsh-cli-app` 创建或恢复一个 Agent，并负责终端交互生命周期。
- `@deepseek-ai/dsh-cli-app/invariant` 校验包所拥有的持久 Session 关系。

包配置默认值为 `showReasoning: true`、`maxToolOutputLines: 12` 和 `maxToolOutputBytes: 32768`。终端渲染模块保持实现私有。私有滚动终端接口把确定性 projection（投影）测试与进程终端分离，而不发布假想的终端 UI capability（能力）。

## Session identity and resume

新的 CLI Agent 依次记录 `sandbox/mode`、`approval/policy` 和一个必需的 `cli/session` 事件：

```ts ignore-check
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cli/session': {
      version: 1
      sandboxMode: SandboxMode
      approvalPolicy: ApprovalPolicy
    }
  }
}
```

该事件不可忽略，因为不理解应用恢复语义的构建必须拒绝 Session。包 invariant（不变量）会拒绝重复 marker（标记）、不受支持的版本，以及与之前策略事件不一致的 marker 值。

恢复必须显式请求，并会在获取终端前预检持久化数据。它只接受一个有效 CLI marker，并要求调用目录匹配 `SessionHeader.cwd`；不匹配时会报告带引用的 `cd <workspace> && dsh --resume <id>` 恢复命令。恢复后的 Agent 保留精确 Session ID，并从最新 `request/header` 选择模型；Session 没有请求 header 时使用部署默认模型。

版本 1 没有跨进程 Session lease（租约）。并发进程可以恢复同一个持久化 ID 并竞争写入。

## Rolling interaction and transcript

该包使用维护中的 `@mariozechner/pi-tui` 输入、按键解码、编辑器和终端生命周期原语，但不会把完整 transcript 放入全屏差分树。稳定条目只写入普通 scrollback 一次。renderer 只清除并重绘受 viewport（视口）限制的活动区，因此稳定 transcript 的长度不会增加按键渲染工作量。

Enter 提交，Alt+Enter 插入换行。Agent 运行期间编辑器保持可用：空闲提交调用 `followup()`，运行中提交调用 `steer()`。Ctrl+C 取消进行中的 Agent 工作并保持进程打开；空闲时 Ctrl+C 请求以 130 退出。EOF 和 `/exit` 请求正常退出。

Session 日志是唯一 transcript 输入。实时 assistant chunk 更新一个活动记录；持久 assistant message（消息）使其稳定。回放会渲染已组装消息，而不重放其 chunk。面向人的 transcript projection 读取 append-origin（追加来源）事件，因此 compaction（压缩）和结果 pruning（裁剪）不会擦除已经显示的输出；模型历史继续使用面向模型的 Session projection。

工具行向可见工具定义请求调用与结果呈现。terminal、diff、read、search、Web 和 generic intent（通用意图）具有 CLI renderer；定义缺失、历史参数格式错误或 presenter（呈现器）失败时，会显示已转义的通用输出，而不会中断恢复。并行调用提交到不可变 scrollback 时保留 Session 顺序。工具块同时应用配置的行数和 UTF-8 字节限制。

CLI 通过作用域命令注册表注册 `/help`、`/clear` 和 `/exit`。未知命令会产生终端错误，绝不会进入模型。其结构化问题 provider 处理单选、多选和自定义文本；它不处理审批。

## Security and lifecycle

所有不可信终端文本会在换行前将 C0 和 C1 control（控制字符）显示为可见十六进制转义，再执行换行。只有终端实现会发出控制序列。

运行器会先等待 Loader settle（稳定），再检查持久化数据、创建 Agent 或获取终端。因此，无效的 provider 或插件配置会在进入终端 raw mode（原始模式）前失败。获取终端后，插件 effect（副作用）负责有序关闭：停止输入、abort（中止）问题和命令、取消并排空 Agent、flush Session、dispose Agent handle（句柄）、排空终端协议回复，并恢复终端。

同一恢复路径覆盖 `/exit`、EOF、活动取消后空闲 Ctrl+C、SIGTERM、获取终端后的启动失败和插件 dispose。启动器关闭仍有时限；重复进程信号保留强制退出行为。

## Verification

聚焦包测试固定滚动提交、viewport 有界重绘、resize（调整大小）、control 转义、UTF-8 输出限制、transcript 回放、呈现回退、命令、问题、恢复校验、模型选择、取消和 teardown 顺序。Loader 组合验证完整访问且没有审批 UI 的 profile。

无密钥产品快照覆盖一条组装后的源码与构建产物终端流程及其持久 Session 输出。PTY 验收覆盖多行输入、引导、取消、清屏、退出、恢复、获取终端前的 provider 失败、SIGTERM 和终端恢复。构建后 bin 验收覆盖裸路由、帮助与版本归属、显式 profile、Web、Headless、插件管理和配置 dump。

本地 PTY 证据无法穷尽终端模拟器、tmux、SSH 或平台矩阵。跨进程恢复竞争仍是明确的覆盖与产品缺口。

## Alternatives considered

**恢复旧的全屏 TUI 包。** 不采用，因为产品需要滚动终端，而不需要 transcript 全量重绘、selector（选择器）、overlay（浮层）和扩展接口。

**为终端 UI 创建 Service Definition、Provider 和 Consumer 包。** 不采用，因为只有一个终端实现。私有测试接口能够提供隔离，而无需发布没有第二个 provider 的 capability。

**在 `apps/cli` 中直接实现终端应用。** 不采用，因为交互行为会成为无法 patch 的启动器代码。只有 profile 选择必须发生在插件存在前。

**使用面向行的 REPL 或 Node readline。** 不采用，因为多行编辑、并发 streaming（流式输出）、结构化问题、增强按键解码和可靠的 raw-terminal 恢复会缺失或需要手写。

**自动恢复最新 Session 或打开 selector。** 不采用，因为隐式选择可能进入错误 workspace（工作区）或陈旧任务。默认新建并显式恢复可让身份和副作用保持可见。

**在完整访问模式下移除审批服务。** 不采用，因为工具执行消费该服务接口。`never` 策略是已有的确定性无提示路径。

## Consequences

裸 `dsh` 成为持久化交互式编码工作流，具备普通终端 scrollback、流式输出、引导、结构化问题、作用域命令、显式恢复和有界活动区重绘。Web 和 Headless 仍是通过已有命令行选择的独立应用组合包。

完整访问允许 Bash 和文件系统工具修改该进程能够访问的每个路径，CLI 不提供运行时审批停止点。警告与文档属于产品行为。

已提交的 scrollback 无法改写，因此 projector 只提交稳定的消息、结果和通知。该包以私有组合方式使用维护中的终端原语；如果依赖发生变化，semantic test（语义测试）负责固定滚动行为。
