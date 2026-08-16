# Agent Note: 将滚动式终端 CLI 作为 `dsh` 默认应用

Status: proposed

[English](2026-08-16-rolling-terminal-cli.md) | 中文

## Problem

已发布的 `dsh` 命令是 profile 启动器，而不是交互式终端 Agent。用户只能选择 Web profile 或提交一次 Headless 任务；裸 `dsh` 会因必须提供 `--profile` 而失败。仓库已经拥有与 provider 无关的 Agent、Session、命令、用户问题、工具呈现、持久化和关闭接口，但没有已交付的终端应用消费这些接口。

旧的全屏 TUI 因没有产品组合使用而被移除；保留该包仍会带来产品级 renderer、带补丁的终端依赖、扩展接口和快照语料库。其[移除决策](../../implemented/simplification/2026-08-04-remove-tui-package.md)要求后续替代品必须具名部署、明确包边界、具体交互 provider，以及组装后的生命周期和 transcript 验收。重新引入那套全屏实现也会恢复长会话成本：每次输入帧仍与完整渲染 transcript 耦合。

所需产品更窄。裸 `dsh` 应在调用目录中启动一个持久化 coding Agent，把完成后的输出保留在普通终端 scrollback 中，并且只重绘包含流式输出、运行中工具、问题和编辑器的有界活动区。交付的终端 profile 刻意采用完整文件系统访问权限，并且不显示审批提示。

## Proposal

把一个滚动式终端应用作为普通 Cordis plugin bundle 交付，并将其 profile 设为启动器默认值。`apps/cli` 保持为插件前的薄启动层：选择 profile、组合 patch 层、提供命令行和进程退出事实，并启动 Loader。所有 Agent、Session、终端交互、渲染、命令、问题和策略行为都归插件所有。

### 包与 profile

新增 `packages/bundle/cli-app`，发布名为 `@deepseek-ai/dsh-cli-app`。该包同时包含应用 bundle 及其唯一实现，不为只有一个 adapter 的终端 UI 引入假想 service。它导出：

- `@deepseek-ai/dsh-cli-app/startup`：普通插件，注入 `cmdlineArgs`，解析 `--resume <session-id>` 与 `--help`，并提供 `cliStartup`；
- `@deepseek-ai/dsh-cli-app`：创建或恢复一个 Agent、拥有终端交互生命周期的 runner 插件；
- `@deepseek-ai/dsh-cli-app/invariant`：该包拥有的运行时 invariant companion；
- `@deepseek-ai/dsh-cli-app/cordis.patch.yml`：位于 `@deepseek-ai/dsh-base` 之上的 bundle 层。

该包的外部接口由插件导出、经校验的配置和 bundle patch 构成。终端渲染模块保持实现私有。内部 `RollingTerminal` 接口将确定性的 projection 测试与真实进程终端隔开；它不是 Cordis service，也不由包导出。

新增内置 `cli` profile 模板，按顺序包含 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-cli-app`。裸 `dsh` 选择该 profile。`dsh --resume <id>`、`dsh --patch <file> --resume <id>` 和裸 config dump 因而以 `cli` 为目标；`dsh web`、`dsh plugin` 与显式 `dsh --profile <name>` 保持现有含义。裸 `--help` 和 `--version` 仍由启动器拥有，`dsh --profile cli --help` 则到达应用帮助。启动器 flag 仍在第一个无法识别的应用参数处结束，因此 `--patch` 必须位于 `--resume` 之前。

CLI bundle 将 `sandbox-policy` 覆盖为 `danger-full-access`，将 `approval` 覆盖为 `never`，并禁用 `permission` preset service。approval service 仍然挂载，因为工具执行依赖它；但确定性的 `never` policy 不会分发给 answerer，CLI 也不会注册审批 UI。home 和 profile patch 层仍高于 bundle，因此 operator 可以显式替换该部署策略；CLI 会把有效值记录到每个新 Session 中，避免 resume 静默重新解释它们。

runner 会在第一个 editor prompt 前打印一条稳定 warning，明确有效 sandbox 和 approval policy。使用交付默认值时，它会说明 full access 能修改进程可访问的每个路径，并且 approval prompt 已禁用。keyless CLI snapshot 固定该文案。

### 启动与 Session 身份

`cli-startup` 提供以下不可变值：

```ts ignore-check
interface CliStartupValues {
  resumeSessionId?: SessionId
}
```

runner 注入 `agentDefaultModel`、`agents`、`approval`、`cliStartup`、`commands`、`loader`、`sandboxPolicy`、`sessionPersistence`、`sessions`、`tools` 和 `userQuestions`。它在创建运行时状态前等待 Loader settle。它会在启用 raw input 前拒绝非 TTY stdin 或 stdout、无效参数、不存在的 Session、不受支持的 CLI Session 版本和 workspace 不匹配。

新调用会在 Agent 创建前生成 opaque Session ID、安装经过 Session 过滤的 listener 和 user-question provider，并通过 `ctx.agents` 创建 Agent。接受输入前，它先通过各自 canonical event writer 追加有效 sandbox 和 approval 值，再追加一个必需的、仅写日志的应用标记：

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

该标记不带 `ignorable`：不了解终端应用必需 resume 语义的 build 必须拒绝 Session，而不是猜测。CLI invariant 会拒绝多个标记、未知版本，以及取值与其前方最新 `sandbox/mode` 和 `approval/policy` 事实不一致的标记。

`dsh --resume <id>` 在发布 Agent 前通过 persistence inspect，要求恰好存在一个有效 `cli/session` 标记，并要求调用目录与 `SessionHeader.cwd` 解析为同一文件系统身份。不匹配时，命令会失败并给出带引用的 `cd <workspace> && dsh --resume <id>` 命令。runner 随后通过 `ctx.agents` 恢复精确的 Session ID，保留日志中的 policy，而不采用后来变化的 profile 默认值。版本 1 不获取跨进程 Session lock；并发 resume 仍是明确记录的风险。

### 滚动终端所有权

使用维护中的 `@mariozechner/pi-tui` 输入、按键解码、编辑器和终端生命周期原语，但不把完整 transcript 放进其差分 component tree。包私有的滚动 renderer 拥有两个区域：

1. 已写入普通终端 scrollback 的 committed 行；
2. 包含当前 assistant stream、运行中工具行、可选问题、状态和多行编辑器的有界 active 区。

每次更新只清除并重绘 active 区。当一个 item 变得不可变时，renderer 移除 active 区，把该 item 的最终转义行写入一次，然后在其下方重绘剩余 active 区。终端 resize 只使 active layout 失效。因此 settled transcript 大小不会影响按键渲染成本。

所有不可信字符串在进入 ANSI-aware wrapping 前都经过同一个 display-text 函数。除换行外的 C0 和 C1 control 会渲染为可见的十六进制转义。只有 terminal implementation 能发出 control sequence。完整渲染的工具块（包括标题和截断提示）受 runner 的 `maxToolOutputLines` 与 `maxToolOutputBytes` 配置约束；截断保留首尾及省略数量。

Agent 运行时编辑器仍可用。Enter 提交；当终端能报告修饰键时，Shift+Enter、Ctrl+Enter 或 Alt+Enter 插入换行。idle 提交调用 `agent.followup()`，running 提交调用 `agent.steer()`。空提交会被忽略。

### Transcript 与工具 projection

Session log 是唯一 transcript 输入。live rendering 按精确目标 Session 过滤 `session/event`。resume 在打开编辑器前一次性渲染既有 event。它从 append-origin event 重建 human history，而不是使用模型 replacement surface，因此 compaction 和结果 pruning 不会擦除用户已经看过的输出。

live `assistant/chunk` 的 text 和 reasoning delta 更新一个 active assistant record。匹配的 `assistant/message` 用组装后的 durable content 替换 provisional record，并只 commit 一次；replay 直接渲染组装后的 message，不重放 chunk。reasoning 默认以 dim 样式显示，并可通过 `showReasoning` 禁用。

每个 `tool/call` 按 `callId` 创建 active row。CLI 解析参数，并向可见 tool definition 请求 `presentCall`；配对的 `tool/result` 使用包括 durable presentation metadata 在内的同一定义请求 `presentResult`。历史参数无效、definition 不存在或 presenter 抛错时，回退为通用且已转义的工具名、参数、结果内容和失败状态，而不是让 resume 失败。terminal、diff、read、search、Web 和 generic intent 各有 CLI renderer；renderer 不按工具名分支。

并行调用按 call 顺序占据 row。后发调用先 settle 时会在 active 区展示 settled 状态，但在同一有序组中所有更早调用 commit 前保持等待，因此不可变 scrollback 能保留 Session 顺序而无需改写旧终端行。

直接 human `user/message` event 渲染为用户条目。plugin context 保持已记录且对模型可见，但不会作为普通 human transcript prose 出现。turn 失败、retry、cancel、max-token 结束和 command result 都从其权威 event 渲染简洁稳定的 notice。

### 命令、问题与中断

以语法有效 slash command 开头的输入通过 `ctx.commands` 分发。未知命令产生 terminal error，绝不会进入模型。CLI 注册三个 Agent-scoped 命令：

- `/help` 列出终端按键和当前 scoped command descriptor；
- `/clear` 清除当前可见终端区域，但不修改 Session，也不删除 terminal scrollback；
- `/exit` 取消 active work、等待 Agent quiescence、flush Session、恢复终端，并请求退出码 0。

CLI 为 root Agent 注册一个 `ctx.userQuestions` provider。它在 active 区中依次展示 request 的 question。single-select answer 接受一个 option number 或任意非空自定义文本。multi-select answer 接受逗号分隔的 option number，并可带 `; custom text` 后缀；空答案跳过该 item。provider 返回现有 structured answer type，并在 owning request、Agent 或 terminal lifetime 结束时 abort。该 provider 只处理模型请求的澄清；approval request 永远不会到达它。

raw Ctrl+C 在 Agent running 时用现有 user cancellation cause 取消当前 activity，并让进程继续。idle 时 Ctrl+C 请求退出码 130。idle 时 Ctrl+D 和 `/exit` 请求正常退出。外部 SIGINT 与 SIGTERM 仍由 launcher 拥有，并 dispose 同一 plugin tree。用户问题拥有 editor 时，普通输入提交被禁用。

### Teardown 与失败

滚动终端 controller 是一个 Cordis effect。其 disposer 停止 input admission、abort pending question 或 command、cancel 并 drain 所拥有的 Agent、flush Session、drain terminal protocol reply、关闭 bracketed paste 和增强键盘协议、恢复先前 raw mode 与 cursor state，最后才 resolve。获取终端后发生启动失败时，launcher 的 fail-loud release hook 会 dispose 同一个 effect。

只要 Agent 还能继续，model、tool、command 和 rendering failure 都被包含为稳定 terminal notice。进程级或 Loader failure 会先打印 diagnostic，再执行有界 teardown。disposal timeout 和重复 signal 保留 launcher 现有的强制退出行为。

### 交付单元与依赖

实现拆分为可独立 review 的 commit：

1. **插件与 profile 接口**——package manifest、export、startup parser、bundle patch、`cli` profile 模板、裸启动路由、应用 marker type 和 invariant。该单元冻结所有跨单元 path 和 type。
2. **滚动终端引擎**——私有 terminal adapter、editor host、control escaping、active-region commit algorithm、bound 和确定性 fake-terminal 测试。
3. **Transcript projection**——Session event reducer，以及 assistant、tool-intent、failure 和 replay renderer。它只依赖已冻结的内部 terminal update interface，不依赖 process terminal。
4. **交互 runner**——Agent create/resume、policy pinning、command、question provider、steering、cancellation 和 teardown。它消费单元 2 与 3。
5. **组装验收与文档**——keyless terminal snapshot、PTY lifecycle case、built-bin routing、package 与用户文档、generated catalog，以及将本 Note 重写为 implemented。

单元 1 是真阻塞，因为单元 2–4 需要针对其中的 package path 与 type 编译。单元 2 和 3 只共享已冻结的 terminal-update interface，可在不重叠文件上并行。单元 4 因组合二者的运行时行为而被两项实现真阻塞。单元 5 被完整可运行应用真阻塞。

### Verification

package test 固定 active-region redraw、immutable commitment、resize behavior、multibyte byte bound、control escaping、assistant chunk assembly、append-origin replay、presenter fallback、并行 call 顺序、question parsing、command 和 cancellation。coverage 覆盖每个新 package source file。

Loader composition test 启动 `dsh-base` 加 `dsh-cli-app`，证明没有 unsettled row，并检查有效默认值为 `danger-full-access` 与 `never`，同时 permission selector 不存在。

一个 keyless runnable CLI snapshot 通过产品 profile 回放多轮 model script，并比较 terminal text 与持久化 Session，其中包含 reasoning、一个 terminal call、一个 diff、一个 user question 和 steering。PTY acceptance 负责 modified-enter input、`/clear`、`/exit`、running 后 idle 的 Ctrl+C、resume、获取 raw mode 后的 startup failure 和 terminal restoration。built-bin acceptance 证明裸 `dsh` 选择 `cli`，而 Web、plugin management、显式 profile、config dump 与 version output 保持原含义。

## Alternatives considered

**恢复旧的全屏 TUI 包。** 不采用，因为需求是滚动式终端，而不是全屏应用。恢复旧包会重新带回 transcript 全量重绘成本、selector、overlay、extension interface 和本产品不需要的兼容工作。

**为终端 UI 创建 Service Definition、Provider 和 Consumer 包。** 不采用，因为目前只有一个终端实现。私有测试接口能够提供隔离，而不发布假想 capability seam；第二个真实 adapter 出现后再证明抽取合理。

**在 `apps/cli` 中直接实现终端应用。** 不采用，因为交互行为会成为无法 patch 的 launcher 代码。launcher 必须在插件存在前选择 profile，但该决定之后的所有行为都能够且应当留在 Cordis tree 中。

**只使用 line-oriented REPL 或 Node readline。** 不采用，因为多行编辑、并发 streaming、结构化 question、增强按键解码和可靠 raw-terminal restoration 要么缺失，要么需要手写。滚动 renderer 复用维护中的终端原语，而不采用全屏 transcript。

**自动 resume 最新 Session 或打开 selector。** 首版不采用，因为隐式选择可能进入错误 workspace 或陈旧任务。默认 fresh 加显式 `--resume` 让 identity 和 side effect 可见。

**在 full access 下完全移除 approval service。** 不采用，因为工具执行消费该 service interface。`never` policy 是现有确定性无提示路径，并保持 capability graph 完整。

## Acceptance criteria

- 裸 `dsh` 在 TTY 中启动 fresh interactive CLI Agent；`dsh --resume <id>` 只在同一 workspace 中恢复有效 CLI Session。
- 产品 profile 默认记录并执行 `danger-full-access` 加 `never`，不展示 approval interaction，并清晰记录风险。
- completed transcript output 留在普通 terminal scrollback 中，同时按键 redraw 成本与 settled Session 长度无关。
- multiline input、live steering、reasoning、tool summary、terminal output、diff、structured user question、`/help`、`/clear`、`/exit` 和两阶段 Ctrl+C 都通过现有 provider-neutral interface 工作。
- resume 与 live rendering 从 Session log 和 tool presentation method 派生，不建立第二套 transcript，也不建立按工具名特判的 renderer。
- 每个 exit 和 failure path 都会恢复终端，在可能时 flush 所拥有的 Session，并进入有界 process shutdown。
- focused package coverage、Loader composition、keyless snapshot、PTY acceptance、built-bin acceptance、build、hygiene、documentation gate 和选定的 pre-push check 全部通过。

## Risks

full access 允许 Bash 和 filesystem tool 修改 `dsh` 进程可访问的每个路径。CLI 必须在启动时和用户文档中说明这一点；它刻意不提供运行时审批停止点。

不同 terminal emulator、tmux、SSH 和 Windows console 的协议不同。实现依赖维护中的 decoding primitive 和 PTY acceptance，但无法在本地穷尽平台矩阵。

committed scrollback 无法改写。错误 commit provisional item 会留下矛盾输出，因此 projector 只 commit durable assembled message、已配对 result，以及 source event 已 settle 的 terminal notice。

不存在跨进程 Session lease。两个 CLI 进程可 resume 同一持久化 ID 并竞争写入；版本 1 只能检测同一进程内 live Session，并明确记录该限制。

终端依赖可能改变私有行为。CLI 只使用已发布的 input、editor、key 和 terminal lifecycle interface；包私有 rolling renderer 与 semantic test 拥有全部 scrollback 行为。
