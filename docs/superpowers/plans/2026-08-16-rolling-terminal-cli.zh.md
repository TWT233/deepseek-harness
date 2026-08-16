# 滚动式终端 CLI 实现计划

[English](2026-08-16-rolling-terminal-cli.md) | 中文

> **供 agent worker 使用：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐项执行本计划。步骤使用 checkbox（`- [ ]`）语法追踪。

**目标：** 让裸 `dsh` 启动一个持久化、由插件组合的滚动式终端 coding Agent，支持多行输入、实时 transcript 与工具渲染、结构化用户问题、显式 Session resume，以及无审批提示的完整访问权限。

**架构：** 新增 `@deepseek-ai/dsh-cli-app`，作为位于 `dsh-base` 之上的 bundle 包；`apps/cli` 继续作为薄 profile launcher，并把裸调用映射到新的 `cli` profile。该包拥有有界滚动终端实现、Session-log projector 和一个 runner 插件；runner 组合现有 Agent、command、user-question、tool-presentation、policy 与 persistence 接口，不修改 `agent-loop`。

**技术栈：** TypeScript 6、Cordis plugins/effects、Commander 15、`@mariozechner/pi-tui` 终端输入/按键/宽度原语、Vitest 4、JSONL Session persistence、POSIX 上的 Python PTY、Windows 上的 `node-pty`。

## 全局约束

- 只在 `/data00/home/wangqiyilang/playground/.worktree/interactive-cli/deepseek-harness` 的 integration branch `feat/interactive-cli` 中工作；根 checkout 保持干净的 `master` 镜像。
- 下方每个任务都是一个可独立 review 的 commit；运行其 focused check，使用且仅使用一次 `Co-authored-by: TRAE CLI <noreply@bytedance.com>`，提交并推送到 `fork/feat/interactive-cli` 后，才能开始下一任务。
- 应用必须是 Cordis plugin bundle。`apps/cli` 可以在插件加载前选择 `cli`，但不得拥有 Agent、Session、rendering、command、question 或 terminal behavior。
- 不修改 `packages/core/agent-loop`；使用 `ctx.agents`、`Agent.followup`、`Agent.steer`、`Agent.cancel` 和 `Agent.whenIdle`。
- 交付的 CLI bundle 设置 `danger-full-access` 与 `approval: never`，不挂载 approval answerer，并在第一个 prompt 前打印稳定 warning。
- `ctx.userQuestions` 保持交互能力，因为模型澄清不属于权限审批。
- stdin 与 stdout 必须同时是 TTY。pipe 与 automation 继续使用 `dsh --profile headless`。
- 已完成的 transcript 行只进入普通 terminal scrollback 一次。只有有界 live item、status/question row 与 editor 可以重绘。
- 每个不可信字符串都要在 ANSI-aware wrapping 前，把除换行外的 C0/C1 control 渲染为可见十六进制转义。
- 首版包括 multiline input、streaming text/reasoning、tool summary、command output、diff、question、`/help`、`/clear`、`/exit`、steering、两阶段 Ctrl+C 与显式 `--resume`；不包括 file completion、model selection、Session selection、theme、image 与 full-screen overlay。
- 新 Session 依次追加 `sandbox/mode`、`approval/policy`，然后追加必需且 non-ignorable 的 `cli/session { version: 1, sandboxMode, approvalPolicy }`；resume 拒绝 marker 缺失、重复、版本不支持、值不一致或 workspace 错误。
- `maxToolOutputLines`、`maxToolOutputBytes` 与 `showReasoning` 是经过校验的 `Config` 字段，不是 hardcoded tunable。默认值分别为 12 行、32,768 UTF-8 byte 和 `true`。
- byte retention 使用 `TextRetainer({ kind: 'headTail', ... })`，line window 使用 package-owned line retention；不要另写 UTF-8 截断算法。
- 新增或改变的 public behavior 要同时更新英文和中文文档，并重新记录 pairing sidecar。
- 不编辑 `vendor/` 或 `.agents/notes/archived/`。

## 单元、依赖与 Write Scope

| 单元 | Write scope | 依赖 | 依赖类型 |
|---|---|---|---|
| 1. Package 与共享 contract | `packages/bundle/cli-app/{src/types.ts,src/session.ts,src/startup.ts,src/invariant.ts,tests/*,package.json,tsconfig.json,README*}`，以及根 TS/config generator | 已批准 spec | — |
| 2. 滚动终端 engine | `packages/bundle/cli-app/src/{display.ts,editor.ts,terminal.ts}`，以及对应 package test | 单元 1 的 terminal interface 与已声明 terminal dependency | 仅共享接口 |
| 3. Session transcript projector | `packages/bundle/cli-app/src/{content.ts,tool-view.ts,transcript.ts}`，以及对应 package test | 单元 1 的 terminal interface 与已声明 retention dependency | 仅共享接口 |
| 4. Interactive runner | `packages/bundle/cli-app/src/{commands.ts,questions.ts,runner.ts,index.ts}`，以及对应 package test | 单元 2 和 3 的 runtime behavior | 真阻塞 |
| 5. Bundle/profile 产品组装 | `packages/bundle/cli-app/cordis.patch.yml`、`apps/cli/**`、profile loader/test、package manifest/config | 单元 4 的可运行插件 | 真阻塞 |
| 6. 产品 snapshot 与 PTY 验收 | `apps/cli/tests/{cli.snapshot.ts,cli-keyless-smoke.e2e.ts,pty-harness.ts,fixtures/cli-*}`、snapshot fixture | 单元 5 的产品入口 | 真阻塞 |
| 7. 产品文档与决策定稿 | root/CLI/bundle/user docs、website manifest、Agent Note lifecycle triplet、generated docs | 单元 6 中观测到的已交付行为 | 真阻塞 |

单元 1 提交后，单元 2 和 3 可以并行，因为它们写入不重叠文件，并且只通过冻结的 `RollingTerminalPort` 与 `RollingTerminalItem` 接口通信。单元 4 必须等待两者：它要实例化真实 terminal，并把 projector update 送入 terminal。单元 5–7 必须串行，因为每项都验证前一个单元交付的产品行为。

## 冻结接口

单元 1 必须精确定义以下名称；后续单元消费它们，不得重命名：

```text
export interface CliStartupValues {
  readonly resumeSessionId?: SessionId
}

export interface CliSessionMarker {
  readonly version: 1
  readonly sandboxMode: SandboxMode
  readonly approvalPolicy: ApprovalPolicy
}

export type RollingTerminalInput =
  | { readonly kind: 'submit'; readonly text: string }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'eof' }

export interface RollingTerminalItem {
  readonly id: string
  readonly order: number
  readonly settled: boolean
  readonly lines: readonly string[]
}

export interface RollingTerminalPort {
  start(onInput: (input: RollingTerminalInput) => void): void
  upsert(item: RollingTerminalItem): void
  remove(id: string): void
  setQuestion(lines: readonly string[] | undefined): void
  setStatus(line: string | undefined): void
  setInputEnabled(enabled: boolean): void
  clear(): void
  stop(): Promise<void>
}

export interface CliTranscriptConfig {
  readonly showReasoning: boolean
  readonly maxToolOutputLines: number
  readonly maxToolOutputBytes: number
}

export class CliTranscriptProjector {
  constructor(ctx: Context, agent: Agent, terminal: RollingTerminalPort, config: CliTranscriptConfig)
  replay(events: readonly SessionEvent[]): void
  accept(event: SessionEvent): void
}
```

`RollingTerminalItem.order` 是创建可见 item 的第一个 Session event seq。后续 update 保留该 order。`RollingTerminalPort.upsert()` 只 commit order 最低且连续 settled 的 prefix；settled 的并行 tool 必须等待所有 order 更低的 active item。

---

### Task 1：创建 CLI Package 并冻结共享 Contract

**文件：**
- Create: `packages/bundle/cli-app/package.json`
- Create: `packages/bundle/cli-app/tsconfig.json`
- Create: `packages/bundle/cli-app/src/index.ts`
- Create: `packages/bundle/cli-app/src/types.ts`
- Create: `packages/bundle/cli-app/src/session.ts`
- Create: `packages/bundle/cli-app/src/startup.ts`
- Create: `packages/bundle/cli-app/src/invariant.ts`
- Create: `packages/bundle/cli-app/README.md`
- Create: `packages/bundle/cli-app/README.zh.md`
- Create: `packages/bundle/cli-app/README.i18n.yaml`
- Create: `packages/bundle/cli-app/tests/startup.spec.ts`
- Create: `packages/bundle/cli-app/tests/session.spec.ts`
- Create: `packages/bundle/cli-app/tests/invariant.spec.ts`
- Modify: `tsconfig.host.json`
- Modify: `tsconfig.base.json`
- Modify: `knip.json`
- Modify: `scripts/verify-package-readme-model-experience.ts`
- Modify: `pnpm-lock.yaml`
- Regenerate: `packages/core/session/src/known-event-types.ts`
- Regenerate: `docs/persistence-catalog.md`
- Regenerate: `docs/persistence-catalog.zh.md`

**接口：**
- Consumes: `parseCmdline(ctx, Command)`、`Session.append`、`setSandboxMode`、`setApprovalPolicy`、`InvariantRegistry`。
- Produces: **冻结接口**中的全部 interface、`CLI_STARTUP_SERVICE`、`CLI_SESSION_VERSION`、`appendCliSessionMarker()`、`readCliSessionMarker()`，以及 `cli/session` declaration merge。

- [ ] **Step 1：编写 startup parser test**

新增通过真实 Loader row 启动插件的 case，并断言：

```text
expect(await parseStartup([])).toEqual({})
expect(await parseStartup(['--resume', 'session-1'])).toEqual({
  resumeSessionId: SessionId('session-1'),
})
expect(await parseStartup(['--help'])).toMatchObject({ exitCode: 0 })
expect(await parseStartup(['--resume', ''])).toMatchObject({ exitCode: 1 })
expect(await parseStartup(['unexpected'])).toMatchObject({ exitCode: 1 })
```

- [ ] **Step 2：运行 startup test，确认缺失 module failure**

运行：

```bash
corepack pnpm exec vitest run packages/bundle/cli-app/tests/startup.spec.ts
```

预期：FAIL，因为 `src/startup.ts` 与 `CLI_STARTUP_SERVICE` 不存在。

- [ ] **Step 3：实现 app-owned Commander parser**

用以下内容实现 `src/startup.ts`：

```text
export const name = 'cli-startup'
export const inject = ['cmdlineArgs']
export const CLI_STARTUP_SERVICE = 'cliStartup'

export interface CliStartupValues {
  readonly resumeSessionId?: SessionId
}

export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile cli')
    .description('Run the interactive DeepSeek Harness terminal agent.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'resume one CLI session in its recorded workspace')
  program.action((options: { resume?: string }) => {
    if (options.resume === '') program.error('error: --resume needs a session id')
    ctx.provide(CLI_STARTUP_SERVICE, {
      ...(options.resume === undefined ? {} : { resumeSessionId: SessionId(options.resume) }),
    } satisfies CliStartupValues)
  })
  parseCmdline(ctx, program)
}
```

- [ ] **Step 4：编写 Session marker 与 invariant test**

测试以下精确 case：

```text
const marker = { version: 1, sandboxMode: 'danger-full-access', approvalPolicy: 'never' } as const
expect(readCliSessionMarker([
  sandboxEvent('danger-full-access'),
  approvalEvent('never'),
  cliEvent(marker),
])).toEqual(marker)
expect(() => readCliSessionMarker([])).toThrow(/not a CLI session/)
expect(() => readCliSessionMarker([cliEvent(marker), cliEvent(marker)])).toThrow(/multiple cli\/session/)
expect(() => readCliSessionMarker([cliEvent({ ...marker, version: 2 })])).toThrow(/unsupported CLI session version/)
expect(() => readCliSessionMarker([
  sandboxEvent('workspace-write'),
  approvalEvent('never'),
  cliEvent(marker),
])).toThrow(/sandbox mode/)
```

invariant test 必须通过 `ctx.emit('session/event', session, event)` 分发相同的无效关系，并断言 `InvariantError`。还必须证明无 marker 的 Session，以及 fresh CLI 在 marker 前写入的第一条 `sandbox/mode` 和 `approval/policy` event 会被忽略：Web/Headless Session 与进行中的 CLI 初始化都合法。

- [ ] **Step 5：实现 `cli/session` declaration、writer、fold 与 invariant**

`src/session.ts` 必须包含：

```text
export const CLI_SESSION_VERSION = 1 as const

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cli/session': CliSessionMarker
  }
}

export function appendCliSessionMarker(session: Session, marker: CliSessionMarker): SessionEvent<'cli/session'> {
  setSandboxMode(session, marker.sandboxMode)
  setApprovalPolicy(session, marker.approvalPolicy)
  return session.append('cli/session', marker)
}

export function readCliSessionMarker(events: readonly SessionEvent[]): CliSessionMarker {
  const markers = events.filter(event => event.type === 'cli/session')
  if (markers.length === 0) throw new Error('session is not a CLI session: missing cli/session marker')
  if (markers.length !== 1) throw new Error(`session carries multiple cli/session markers: ${String(markers.length)}`)
  const markerEvent = markers[0]!
  const raw = markerEvent.data as { version?: unknown; sandboxMode?: unknown; approvalPolicy?: unknown }
  if (raw.version !== CLI_SESSION_VERSION) {
    throw new Error(`unsupported CLI session version: ${String(raw.version)}`)
  }
  let sandboxMode: SandboxMode | undefined
  let approvalPolicy: ApprovalPolicy | undefined
  for (const event of events) {
    if (event.seq >= markerEvent.seq) break
    if (event.type === 'sandbox/mode') sandboxMode = event.data.mode
    if (event.type === 'approval/policy') approvalPolicy = event.data.policy
  }
  if (sandboxMode !== raw.sandboxMode) {
    throw new Error(`cli/session sandbox mode ${String(raw.sandboxMode)} does not match preceding sandbox/mode ${String(sandboxMode)}`)
  }
  if (approvalPolicy !== raw.approvalPolicy) {
    throw new Error(`cli/session approval policy ${String(raw.approvalPolicy)} does not match preceding approval/policy ${String(approvalPolicy)}`)
  }
  return {
    version: CLI_SESSION_VERSION,
    sandboxMode,
    approvalPolicy,
  }
}
```

`src/invariant.ts` 注册 package ownership，并且只在 `cli/session` marker 已存在时校验 loaded 与 newly dispatched log。缺失 marker 不是全局 invariant failure；resume preflight 通过 `readCliSessionMarker()` 严格要求它存在。marker 保持 non-ignorable；运行 `gen-persistence-catalog`，让它进入 `KNOWN_SESSION_EVENT_TYPES`。

- [ ] **Step 6：添加冻结的 terminal 与 transcript type**

把**冻结接口**中的精确 declaration 放入 `src/types.ts`。`src/index.ts` 重新导出 `src/types.ts` 与 `src/session.ts`；此时不暴露 `apply` 插件。

- [ ] **Step 7：创建 package manifest、TS project 与 package docs**

使用根版本 `0.1.0-rc.5`、MIT、ESM、`lib/index.js`、`lib/invariant.js`、`lib/startup.js` 与 declaration。把 `commander`、`@mariozechner/pi-tui@0.73.1`、`@deepseek-ai/dsh-cmdline`、`@deepseek-ai/dsh-output-retention` 与 `@deepseek-ai/schemastery` 加入 runtime dependencies；在 peer/dev dependencies 中镜像 Cordis 与每个 DSH interface import。立即加入单元 2 或单元 3 会 import 的每个 dependency project reference，使这些并行单元永远不修改 `package.json`、`tsconfig.json` 或 `pnpm-lock.yaml`。加入 Host aggregate reference 与 startup source path。在 `knip.json` 与 model-experience sentence map 中注册 package，然后运行 `corepack pnpm install --lockfile-only`。

- [ ] **Step 8：生成 persistence 文件并记录双语 docs**

运行英文 generator，更新 reviewed Chinese catalog 中对应的 `cli/session` row，然后记录 pair：

```bash
corepack pnpm run gen-persistence-catalog
corepack pnpm run verify-translation-pairing --write packages/bundle/cli-app/README.md
corepack pnpm run verify-translation-pairing --write docs/persistence-catalog.md
```

预期：`cli/session` 出现在 generated known-event list 与 persistence catalog 中。

- [ ] **Step 9：运行 focused test 与 package check**

运行：

```bash
corepack pnpm exec vitest run \
  packages/bundle/cli-app/tests/startup.spec.ts \
  packages/bundle/cli-app/tests/session.spec.ts \
  packages/bundle/cli-app/tests/invariant.spec.ts \
  --coverage \
  --coverage.include='packages/bundle/cli-app/src/startup.ts' \
  --coverage.include='packages/bundle/cli-app/src/session.ts' \
  --coverage.include='packages/bundle/cli-app/src/invariant.ts'
corepack pnpm run verify-package-invariants
corepack pnpm run verify-persistence-catalog
git diff --check
```

预期：全部通过。

- [ ] **Step 10：提交并推送 interface checkpoint**

```bash
git add packages/bundle/cli-app tsconfig.host.json tsconfig.base.json knip.json \
  scripts/verify-package-readme-model-experience.ts \
  packages/core/session/src/known-event-types.ts \
  docs/persistence-catalog.md docs/persistence-catalog.zh.md docs/persistence-catalog.i18n.yaml \
  pnpm-lock.yaml
git commit -m "feat(cli): define terminal app contracts" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 2：实现有界滚动终端 Engine

**文件：**
- Create: `packages/bundle/cli-app/src/display.ts`
- Create: `packages/bundle/cli-app/src/editor.ts`
- Create: `packages/bundle/cli-app/src/terminal.ts`
- Create: `packages/bundle/cli-app/tests/display.spec.ts`
- Create: `packages/bundle/cli-app/tests/editor.spec.ts`
- Create: `packages/bundle/cli-app/tests/terminal.spec.ts`

**接口：**
- Consumes: Task 1 中的 `RollingTerminalInput`、`RollingTerminalItem`、`RollingTerminalPort`。
- Produces: `createRollingTerminal(device, options): RollingTerminalPort`、`ProcessTerminalDevice`、`displayText()`、`wrapDisplayLines()`。

- [ ] **Step 1：编写 display escaping 与 width test**

覆盖 control byte、CJK width、renderer 自己拥有的 ANSI 与 resize：

```text
expect(displayText('safe\u001b[31mred\u009b')).toBe('safe\\x1B[31mred\\x9B')
expect(wrapDisplayLines('你好 world', 6)).toEqual(['你好', 'world'])
expect(wrapDisplayLines('a\nb', 80)).toEqual(['a', 'b'])
```

- [ ] **Step 2：编写 editor behavior test**

使用 fake input stream 并断言：

```text
editor.handleInput('hello')
editor.handleInput('\x1b\r') // Alt+Enter
editor.handleInput('world')
editor.handleInput('\r')
expect(inputs).toEqual([{ kind: 'submit', text: 'hello\nworld' }])
editor.handleInput('\x03')
expect(inputs.at(-1)).toEqual({ kind: 'interrupt' })
editor.handleInput('\x04')
expect(inputs.at(-1)).toEqual({ kind: 'eof' })
```

同时固定 Backspace、跨 wrapped line 的 arrow、Ctrl+A/Ctrl+E、Ctrl+U/Ctrl+K、Ctrl+W、paste marker、history Up/Down、question 期间禁用 submit，以及 terminal resize。

- [ ] **Step 3：编写 rolling commitment test**

使用 fake `TerminalDevice` 并断言 settled order：

```text
terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
terminal.upsert({ id: 'b', order: 2, settled: true, lines: ['B done'] })
expect(device.scrollback).toEqual([])
terminal.upsert({ id: 'a', order: 1, settled: true, lines: ['A done'] })
expect(device.scrollback).toEqual(['A done', 'B done'])
expect(device.activeLines).toContain('> ')
```

添加 update 保留原 order、item removal、question/status row、`clear()`、resize、100,000 行 committed history 不参与后续 redraw，以及 `stop()` 恢复 raw mode、bracketed paste、keyboard protocol、cursor 与 input pause 的 case。

- [ ] **Step 4：实现 display 与 multiline editor module**

使用 `@mariozechner/pi-tui` 的 public export `matchesKey`、`visibleWidth`、`sliceByColumn` 与 wrapping utility。不要实例化 `TUI`，也不要访问其 private `previousLines`；`editor.ts` 只拥有已确认的 key set，并发出 Task 1 的 input union。

- [ ] **Step 5：实现 process terminal adapter 与 active-region algorithm**

`ProcessTerminalDevice` 包装 public `ProcessTerminal.start`、`drainInput`、`stop`、`write`、`columns` 和 `rows`。`createRollingTerminal` 跟踪：

```text
const active = new Map<string, RollingTerminalItem>()
let activeHeight = 0
let committedCount = 0
```

每次 redraw 前，移动到 active region 第一行，并精确清除 `activeHeight` 行。只 commit order 最低且连续 settled 的 prefix，用 `\r\n` 把每条 final line 写入一次，然后绘制 active item、question、status 与 editor。写入后不保留任何 committed line content。

- [ ] **Step 6：运行 focused coverage**

运行：

```bash
corepack pnpm exec vitest run \
  packages/bundle/cli-app/tests/display.spec.ts \
  packages/bundle/cli-app/tests/editor.spec.ts \
  packages/bundle/cli-app/tests/terminal.spec.ts \
  --coverage \
  --coverage.include='packages/bundle/cli-app/src/display.ts' \
  --coverage.include='packages/bundle/cli-app/src/editor.ts' \
  --coverage.include='packages/bundle/cli-app/src/terminal.ts'
```

预期：PASS，满足 per-file 100% threshold。

- [ ] **Step 7：提交并推送**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): add rolling terminal engine" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 3：把 Session Event Project 到 Terminal Item

**文件：**
- Create: `packages/bundle/cli-app/src/content.ts`
- Create: `packages/bundle/cli-app/src/tool-view.ts`
- Create: `packages/bundle/cli-app/src/transcript.ts`
- Create: `packages/bundle/cli-app/tests/content.spec.ts`
- Create: `packages/bundle/cli-app/tests/tool-view.spec.ts`
- Create: `packages/bundle/cli-app/tests/transcript.spec.ts`

**接口：**
- Consumes: `RollingTerminalPort`、`RollingTerminalItem`、`CliTranscriptConfig`、`ctx.tools.get(name, agent)`、append-origin Session event。
- Produces: 具有 Task 1 中冻结的精确 constructor 与 method 的 `CliTranscriptProjector`。

- [ ] **Step 1：编写 content rendering test**

固定 text、dim reasoning、不支持 image 的 notice、nested tool-result content、control escaping，以及 byte/line bound：

```text
expect(renderContent([
  { type: 'text', text: 'answer' },
  { type: 'reasoning', text: 'thought' },
], { showReasoning: true })).toEqual([
  'answer',
  dim('thought'),
])
expect(boundToolLines(['1', '2', '3', '4'], { maxLines: 3, maxBytes: 32768 }))
  .toEqual(['1', '… 1 line omitted …', '4'])
```

添加一个 multibyte case，确保 `TextRetainer` head/tail cut 后 UTF-8 result 仍有效。

- [ ] **Step 2：编写 tool-intent renderer test**

为 `generic`、`terminal`、`diff`、`read`、`search` 与 `web` intent 构造 definition。断言 renderer 使用 intent tag，绝不使用 tool name。添加 unknown tool、malformed JSON argument、缺失 cross-page call，以及 `presentCall`/`presentResult` 抛错的 generic fallback case。

- [ ] **Step 3：编写 projector replay 与 live test**

使用 fake terminal port。必需 case：

```text
projector.accept(chunk(1, 1, { type: 'text-delta', index: 0, text: 'hel' }))
projector.accept(chunk(1, 1, { type: 'text-delta', index: 0, text: 'lo' }))
expect(active('assistant:1:1').lines).toEqual(['hello'])
projector.accept(assistantMessage(1, 1, 'hello'))
expect(active('assistant:1:1').settled).toBe(true)
```

replay 必须在 assembled `assistant/message` 已存在时忽略 raw chunk，只渲染 append-origin surface event，从 human prose 中排除 plugin context，保留 direct human message，按 `callId` 配对 tool call/result，让更晚的并行 result 等待更早的 active call，并渲染 `turn/end` error/aborted/max-token notice。

- [ ] **Step 4：实现 `content.ts` 与 bounded tool rendering**

byte 使用 `TextRetainer`。line cap 在 CLI package 中实现：如果超过配置行数，保留 `floor((maxLines - 1) / 2)` 条 head line，并在一个 omission notice 后保留剩余 tail line。

- [ ] **Step 5：实现 `tool-view.ts`**

只解析 call argument 一次，并按 `callId` 保留 `{ name, args, order }`。使用精确的当前 Agent scope，在 `try/catch` 下调用 presenter。映射每个现有 `ToolCallView` 与 `ToolResultView` discriminant；merge-extensible default 返回 generic escaped block。

- [ ] **Step 6：实现 `CliTranscriptProjector`**

`replay(events)` 先索引 assembled assistant coordinate，再按 event order fold。`accept(event)` 只更新精确 live stream。item ID 固定为：`user:<seq>`、`assistant:<turn>:<step>`、`tool:<callId>` 与 `notice:<seq>`。

- [ ] **Step 7：运行 focused coverage**

```bash
corepack pnpm exec vitest run \
  packages/bundle/cli-app/tests/content.spec.ts \
  packages/bundle/cli-app/tests/tool-view.spec.ts \
  packages/bundle/cli-app/tests/transcript.spec.ts \
  --coverage \
  --coverage.include='packages/bundle/cli-app/src/content.ts' \
  --coverage.include='packages/bundle/cli-app/src/tool-view.ts' \
  --coverage.include='packages/bundle/cli-app/src/transcript.ts'
```

预期：PASS，满足 per-file 100% threshold。

- [ ] **Step 8：提交并推送**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): render session transcript" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 4：组合 Agent Lifecycle、Command、Question 与 Teardown

**文件：**
- Create: `packages/bundle/cli-app/src/commands.ts`
- Create: `packages/bundle/cli-app/src/questions.ts`
- Create: `packages/bundle/cli-app/src/runner.ts`
- Modify: `packages/bundle/cli-app/src/index.ts`
- Create: `packages/bundle/cli-app/tests/commands.spec.ts`
- Create: `packages/bundle/cli-app/tests/questions.spec.ts`
- Create: `packages/bundle/cli-app/tests/runner.spec.ts`

**接口：**
- Consumes: 单元 2 与 3 的 runtime implementation、`ctx.agents.create/resume`、model selection、persistence inspect、canonical policy writer、`ctx.commands` 与 `ctx.userQuestions`。
- Produces: root plugin `name = 'cli-runner'`、validated `Config`、`runCli()`，以及 `internals` 中 process-backed terminal factory。

- [ ] **Step 1：编写 command test**

断言 `/help` 包含 `help`、`clear`、`exit` 与动态注册的 scoped command；`/clear` 只调用 `terminal.clear()`；`/exit` 请求 graceful shutdown；unknown slash input 返回 terminal error，绝不调用 `agent.followup`。

- [ ] **Step 2：编写 structured question test**

固定精确 parsing：

```text
expect(parseSingleAnswer('2', question)).toEqual({ selected: ['B'] })
expect(parseSingleAnswer('custom answer', question)).toEqual({ selected: [], custom: 'custom answer' })
expect(parseMultiAnswer('1,3; extra', question)).toEqual({
  selected: ['A', 'C'],
  custom: 'extra',
})
expect(parseMultiAnswer('', question)).toEqual({ selected: [] })
```

添加 invalid index、duplicate index、cancellation、batch progression、input disabling 与 provider disposal case。

- [ ] **Step 3：使用 fake terminal 编写 runner lifecycle test**

覆盖：

- fresh Agent 使用 `agentDefaultModel.currentSelection()`；
- fresh Session 依次追加 `sandbox/mode`、`approval/policy` 与 `cli/session`；
- resume 在 terminal start 前通过 `sessionPersistence.inspect()` preflight；
- resume 使用最新 `request/header` model，blank Session 使用 deployment default；
- marker 缺失/重复/版本错误/policy 不一致以及 cwd mismatch 都在 raw mode 前失败；
- cwd mismatch 给出精确且带引用的 `cd ... && dsh --resume ...` recovery command；
- idle submit 调用 `followup`，running submit 调用 `steer`；
- running Ctrl+C 调用 `agent.cancel({ kind: 'user' })`，idle Ctrl+C 请求 130，idle EOF 与 `/exit` 请求 0；
- disposer abort question/command、cancel Agent、await `whenIdle`、flush、dispose owned handle，最后停止 terminal；
- terminal start 后的 failure 仍调用 `stop()`。

- [ ] **Step 4：实现 command 与 question**

在 `agent.ctx.inject(['commands'], ...)` 下注册 command，使 scoped shadowing 与 disposal 生效。注册一个 root `ctx.userQuestions` provider；当 `request.agent` 不是 runner 的精确 Agent 时拒绝 request。

- [ ] **Step 5：实现 resume preflight 与 model selection**

使用：

```text
const inspected = await ctx.sessionPersistence.inspect(id)
const marker = readCliSessionMarker(inspected.events)
assertSameWorkspace(inspected.meta.cwd, process.cwd())
const logged = inspected.events.findLast(event => event.type === 'request/header')
const selection = logged?.data.header.config ?? ctx.agentDefaultModel.currentSelection()
```

把得到的 provider/model/reasoning effort 作为 `agentOptions`，并为 create 与 resume 在 Agent setup 中安装一个 `ModelSelectionRef`。

- [ ] **Step 6：实现 runner orchestration**

`runCli(ctx, config, startup, terminalFactory)` 必须：

1. await Loader settlement；
2. 通过 production factory 拒绝 non-TTY process stream；
3. preflight resume 或生成新 Session ID；
4. 注册 Session filtering 与 user question；
5. create/resume 所拥有的 Agent；
6. 追加 fresh policy 与 CLI marker；
7. 把既有 event replay 到 `CliTranscriptProjector`；
8. 打印 effective full-access warning；
9. 启动 terminal input；
10. await application-exit request。

`apply` 读取 launcher-owned `ctx.appExit`；缺失时 fail loud。runner 拥有返回的 `AgentHandle`。

- [ ] **Step 7：运行 focused coverage**

```bash
corepack pnpm exec vitest run \
  packages/bundle/cli-app/tests/commands.spec.ts \
  packages/bundle/cli-app/tests/questions.spec.ts \
  packages/bundle/cli-app/tests/runner.spec.ts \
  --coverage \
  --coverage.include='packages/bundle/cli-app/src/commands.ts' \
  --coverage.include='packages/bundle/cli-app/src/questions.ts' \
  --coverage.include='packages/bundle/cli-app/src/runner.ts' \
  --coverage.include='packages/bundle/cli-app/src/index.ts'
```

预期：PASS，满足 per-file 100% threshold。

- [ ] **Step 8：提交并推送**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): run interactive agent sessions" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 5：交付 CLI Bundle 并使其成为裸命令

**文件：**
- Create: `packages/bundle/cli-app/cordis.patch.yml`
- Create: `packages/bundle/cli-app/tests/composition.e2e.ts`
- Modify: `packages/bundle/cli-app/package.json`
- Modify: `packages/bundle/README.md`
- Modify: `packages/bundle/README.zh.md`
- Modify: `packages/bundle/README.i18n.yaml`
- Modify: `packages/boot/app-boot/src/profile.ts`
- Modify: `packages/boot/app-boot/tests/profile.spec.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/tests/args.spec.ts`
- Modify: `apps/cli/tests/built-bin.e2e.ts`
- Modify: `scripts/check-workspace-constraints.ts`
- Modify: `pnpm-lock.yaml`

**接口：**
- Consumes: Task 4 中可运行的 `@deepseek-ai/dsh-cli-app` 插件。
- Produces: in-box `cli` profile、裸 `dsh` routing、bundle patch 与 installed package closure。

- [ ] **Step 1：编写 launcher parser failure 与 default**

更新 `args.spec.ts`，使其包含：

```text
expect(parse([])).toEqual({ mode: 'profile', profile: 'cli', patches: [], args: [] })
expect(parse(['--resume', 's1'])).toEqual({
  mode: 'profile', profile: 'cli', patches: [], args: ['--resume', 's1'],
})
expect(parse(['--dump-config'])).toEqual({
  mode: 'dump-config', profile: 'cli', defaultOnly: false, patches: [],
})
expect(parse(['--help'])).toExit(0)
expect(parse(['--version'])).toExit(0)
```

保留现有的 `web`、`plugin`、显式 profile、late-launcher-flag 与 contradictory-dump assertion。

- [ ] **Step 2：添加 `cli` profile template 与 migration test**

`PROFILE_TEMPLATES.cli` 必须精确为：

```text
['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-cli-app']
```

扩展 profile test，使 `cli` 自动初始化。不要添加 installation-owned legacy tuple，因为不存在已发布 CLI tuple。

- [ ] **Step 3：编写 bundle patch**

patch 必须为：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
- id: hmr
  disabled: true
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
- id: permission
  disabled: true
- id: tools
  config:
    mode: native
- insert:
    - id: cli-startup
      name: '@deepseek-ai/dsh-cli-app/startup'
    - id: cli-runner
      name: '@deepseek-ai/dsh-cli-app'
      inject: [cliStartup]
      config:
        showReasoning: true
        maxToolOutputLines: 12
        maxToolOutputBytes: 32768
```

- [ ] **Step 4：编写 composition acceptance**

通过真实 Loader 启动 `dsh-base` 加 `dsh-cli-app`，使用 test startup service 与 fake terminal factory。断言 zero unsettled row、`ctx.sandboxPolicy.defaultMode === 'danger-full-access'`、`ctx.approval.config.policy === 'never'`、`ctx.get('permissionPresets') === undefined`，以及一个 CLI Session marker。

- [ ] **Step 5：连接 package publication 与 source resolution**

把 `dsh.bundle.patch` 与 `cordis.patch.yml` 加入 package manifest；terminal 与 retention dependency 已在 Task 1 中冻结。把 `@deepseek-ai/dsh-cli-app` 加入 `apps/cli` dependencies，使 in-box resolution 与 profile fallback healing 包含它。把 bundle file exception 加入 workspace constraint，并通过以下命令更新 lockfile：

```bash
corepack pnpm install --lockfile-only
```

- [ ] **Step 6：更新裸 launcher grammar**

只修改 root command action：没有 `--profile` 时解析为 `cli`，但裸 help/version 仍由 launcher 拥有。用 bare CLI、显式 resume、Web、Headless 与 plugin example 替换 stale TUI example。

- [ ] **Step 7：扩展 built-bin acceptance**

添加：

- `dsh --profile cli --help` 以 0 退出，且不获取 terminal state；
- 裸 `dsh` 在 piped test stdio 下以 1 退出，并包含 TTY diagnostic；
- 裸 `--dump-default-config` 包含 `dsh-cli-app`、`danger-full-access`、`policy: never`，且不包含 Web Host row；
- 现有 Web 与 Headless built test 保持 byte-compatible。

- [ ] **Step 8：运行 assembly check**

```bash
corepack pnpm exec vitest run \
  packages/boot/app-boot/tests/profile.spec.ts \
  packages/bundle/cli-app/tests/composition.e2e.ts \
  apps/cli/tests/args.spec.ts \
  apps/cli/tests/built-bin.e2e.ts
corepack pnpm run verify-cordis-config
corepack pnpm run constraints
corepack pnpm run build:lib
git diff --check
```

预期：全部通过。

- [ ] **Step 9：提交并推送**

```bash
git add packages/bundle/cli-app packages/bundle/README* \
  packages/boot/app-boot/src/profile.ts packages/boot/app-boot/tests/profile.spec.ts \
  apps/cli pnpm-lock.yaml scripts/check-workspace-constraints.ts
git commit -m "feat(cli): ship default terminal profile" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 6：添加 Keyless 产品 Snapshot 与 PTY Lifecycle 验收

**文件：**
- Create: `apps/cli/tests/pty-harness.ts`
- Create: `apps/cli/tests/cli.snapshot.ts`
- Create: `apps/cli/tests/cli-keyless-smoke.e2e.ts`
- Create: `apps/cli/tests/fixtures/cli-scripted-llm.ts`
- Create: `apps/cli/tests/fixtures/cli-snapshot.cordis.yml`
- Create: `apps/cli/tests/fixtures/cli-invalid-provider.cordis.yml`
- Create: `apps/cli/tests/snapshots/rolling-cli/terminal.expected.txt`
- Create: `apps/cli/tests/snapshots/rolling-cli/session.expected.jsonl`
- Modify: `apps/cli/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/testing.md`
- Modify: `docs/testing.zh.md`
- Modify: `docs/testing.i18n.yaml`

**接口：**
- Consumes: Task 5 的已交付产品 profile。
- Produces: keyless terminal/output golden 与真实 PTY lifecycle regression suite。

- [ ] **Step 1：恢复 product-neutral PTY harness**

把历史 Python `pty.fork()` driver 与 Windows `node-pty` driver 改造为 `runCliPtySmoke()`。保留 marker-gated action、精确 expected exit code、可配置 columns/rows、隔离 `$DSH_HOME`、prepare/inspect callback，以及输出完整 captured byte 的 timeout。把 `node-pty: ^1.1.0` 加入 `apps/cli` devDependencies，并用 `corepack pnpm install --lockfile-only` 刷新 lockfile。

- [ ] **Step 2：构建 deterministic scripted model fixture**

fixture 必须在无网络情况下产生以下序列：

1. reasoning delta 与 visible text；
2. terminal-intent `bash` call；
3. diff-intent file edit；
4. 带两个 option 与 custom text support 的 `ask_user_question`；
5. 包含 selected response 的 final answer；
6. 保持足够长、可提交 steering 的第二个 turn。

patch 禁用真实 DeepSeek row，并插入 scripted adapter，同时保持真实 Agent loop、tool、Session persistence 与 CLI runner 的完整组装。

- [ ] **Step 3：编写 keyless CLI snapshot**

在 PTY 中驱动产品 source bin，normalize cwd、Session ID、ANSI style、timestamp 与 terminal dimension，然后比较：

```text
expect(normalizedTerminal).toBe(await readFile(terminalExpected, 'utf8'))
expect(normalizedSession).toBe(await readFile(sessionExpected, 'utf8'))
```

terminal golden 必须展示 full-access warning、multiline user input、streamed reasoning/text、bash summary/output、diff、question/option/answer、steering 与最终 `/exit`。Session golden 必须包含 policy pair 与一个 `cli/session` marker。

- [ ] **Step 4：编写 focused PTY lifecycle case**

添加：

- Alt+Enter multiline submission；
- running submit 变成 steering；
- 第一次 Ctrl+C abort active turn 并保留 editor；第二次 idle Ctrl+C 以 130 退出；
- `/clear` 清除 visible active area，但 persisted Session 保留之前的 turn；
- `/exit` 在 flush 后以 0 退出；
- 第一个 process 创建 Session，第二个 `dsh --resume <id>` 在同一 cwd 中 replay；
- wrong cwd 在 raw mode 前拒绝，并打印 recovery command；
- terminal acquisition 后 invalid provider 以 1 退出，output 包含 bracketed-paste disable 与 cursor restoration；
- SIGTERM 通过 bounded tree disposal 以 0 退出。

- [ ] **Step 5：运行 snapshot 与 PTY suite**

```bash
corepack pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/cli.snapshot.ts
corepack pnpm exec vitest run apps/cli/tests/cli-keyless-smoke.e2e.ts
```

预期：在没有 API key 的 replay mode 下 PASS。

- [ ] **Step 6：更新 testing documentation 并记录 pair**

说明 completed rolling-terminal journey 位于 `apps/cli/tests/snapshots/`，而 raw input、Loader selection 与 terminal restoration 使用 PTY suite。不要重述 fixture internals。

```bash
corepack pnpm run verify-translation-pairing --write docs/testing.md
```

- [ ] **Step 7：提交并推送**

```bash
git add apps/cli/tests apps/cli/package.json pnpm-lock.yaml docs/testing*
git commit -m "test(cli): cover rolling terminal journeys" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 7：发布用户文档并定稿决策

**文件：**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `apps/cli/README.md`
- Modify: `apps/cli/README.zh.md`
- Modify: `apps/cli/README.i18n.yaml`
- Modify: `apps/cli/reference/README.md`
- Modify: `apps/cli/reference/README.zh.md`
- Modify: `apps/cli/reference/README.i18n.yaml`
- Create: `docs/user/guide/cli.md`
- Create: `docs/user/guide/cli.zh.md`
- Create: `docs/user/guide/cli.i18n.yaml`
- Modify: `docs/user/guide/index.md`
- Modify: `docs/user/guide/index.zh.md`
- Modify: `docs/user/guide/index.i18n.yaml`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Modify: `docs/architecture.i18n.yaml`
- Modify: `packages/bundle/README.md`
- Modify: `packages/bundle/README.zh.md`
- Modify: `packages/bundle/README.i18n.yaml`
- Modify: `packages/bundle/cli-app/README.md`
- Modify: `packages/bundle/cli-app/README.zh.md`
- Modify: `packages/bundle/cli-app/README.i18n.yaml`
- Modify: `website/docs.ts`
- Move/Rewrite: `.agents/notes/proposed/feature/2026-08-16-rolling-terminal-cli.{md,zh.md,i18n.yaml}` to `.agents/notes/implemented/feature/`
- Modify: `.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.{md,zh.md,i18n.yaml}`
- Regenerate: package 与 event addition 触及的 generated catalog/graph

**接口：**
- Consumes: Task 1–6 中观测到的行为与通过的 acceptance。
- Produces: current-state user docs、website route、implemented decision record 与干净的 release-facing package metadata。

- [ ] **Step 1：把 Agent Note 重写为 implemented form**

把 triplet 移到 `implemented/feature`，把 `Status: proposed` 改为 `Status: implemented`，把 `## Proposal` 改为 `## Decision`，用现在时 package/behavior fact 替换未来时 delivery unit，把 acceptance criteria 与 risk 折叠进 `## Verification` 与 `## Consequences`，保留所有真实 alternative。不要 archive TUI removal note：把其中错误的“没有 terminal UI package”后果改成 `@deepseek-ai/dsh-tui` 仍被移除，而 `dsh-cli-app` 是独立滚动应用。

- [ ] **Step 2：让 root quick start 以 CLI 为先**

把：

```bash
npx @deepseek-ai/dsh
```

记录为默认终端路径，把：

```bash
npx @deepseek-ai/dsh web
```

记录为 browser alternative。full-access warning 必须紧邻第一条 command。

- [ ] **Step 3：编写 CLI user tutorial**

`docs/user/guide/cli.md` 必须覆盖 prerequisite、start、multiline input、steering、tool/reasoning、question、`/help`、`/clear`、`/exit`、Ctrl+C、Session ID/resume、same-workspace requirement、full-access/no-approval risk，以及 automation 使用的 Headless command。精确 reference semantics 保留在 `apps/cli/reference/README.md`。

- [ ] **Step 4：更新 CLI/package/architecture reference**

CLI README 列出 `dsh`、`dsh --resume`、Web、Headless、plugin management、config dump 与 flag boundary example。Architecture 在 profile/bundle composition 中把 `cli-app` 放在 Web 与 Headless 旁。Bundle README 增加 package row。Package README 反映精确 Config default、lifecycle、model effect 与 limitation。

- [ ] **Step 5：在 website manifest 中发布 tutorial**

添加 paired page：

```text
{
  source: 'docs/user/guide/cli.md',
  route: 'guide/cli.md',
  label: { root: '使用终端 CLI', en: 'Use the terminal CLI' },
  sidebar: { root: 'zh-guide', en: 'en-guide' },
  section: { root: '入门', en: 'Guide' },
  order: 1,
}
```

把现有 Web guide 移到 order 2，providers 移到 order 3。

- [ ] **Step 6：regenerate 并记录 pair**

运行：

```bash
corepack pnpm run gen-persistence-catalog
corepack pnpm run gen-cordis-catalog
corepack pnpm run gen-config-catalog
corepack pnpm run gen-doc-graphs
corepack pnpm run verify-translation-pairing --write README.md
corepack pnpm run verify-translation-pairing --write apps/cli/README.md
corepack pnpm run verify-translation-pairing --write apps/cli/reference/README.md
corepack pnpm run verify-translation-pairing --write docs/user/guide/cli.md
corepack pnpm run verify-translation-pairing --write docs/user/guide/index.md
corepack pnpm run verify-translation-pairing --write docs/architecture.md
corepack pnpm run verify-translation-pairing --write packages/bundle/README.md
corepack pnpm run verify-translation-pairing --write packages/bundle/cli-app/README.md
corepack pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-16-rolling-terminal-cli.md
corepack pnpm run verify-translation-pairing --write .agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md
```

- [ ] **Step 7：运行最终 relevant evidence**

如果 nested script 找不到 `pnpm`，使用临时 Corepack shim：

```bash
shim=$(mktemp -d)
corepack enable --install-directory "$shim"
PATH="$shim:$PATH" pnpm run doc-sync
PATH="$shim:$PATH" pnpm run lint
PATH="$shim:$PATH" pnpm run build
PATH="$shim:$PATH" pnpm run hygiene
PATH="$shim:$PATH" pnpm exec vitest run \
  packages/bundle/cli-app/tests \
  packages/boot/app-boot/tests/profile.spec.ts \
  apps/cli/tests/args.spec.ts \
  apps/cli/tests/built-bin.e2e.ts \
  apps/cli/tests/cli-keyless-smoke.e2e.ts
PATH="$shim:$PATH" pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/cli.snapshot.ts
git diff --check
rm -rf "$shim"
```

预期：每条 command 都通过。不要运行 repository-wide coverage；focused package coverage 已拥有新 source file，CI 拥有 exhaustive coverage/platform。

- [ ] **Step 8：提交、推送并验证 integration branch**

```bash
git add README* apps/cli packages/bundle docs website/docs.ts .agents/notes \
  packages/core/session/src/known-event-types.ts
git commit -m "docs(cli): publish terminal workflow" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
git fetch fork feat/interactive-cli
git rev-parse HEAD refs/remotes/fork/feat/interactive-cli
git status --short --branch
```

预期：local 与 remote SHA 相同，worktree 干净。

## 计划自检

- Spec coverage：package/plugin boundary、bare routing、full access、无 approval UI、user question、marker/resume、rolling scrollback、multiline input、streaming/reasoning、tool intent、command、interruption、teardown、snapshot、PTY、built-bin behavior、双语 docs、website publication 与 Agent Note lifecycle 都映射到任务。
- Placeholder scan：计划没有未完成值或泛化的“add tests/error handling”步骤；每个产生代码的任务都给出 file、interface、assertion、command 与 expected outcome。
- Type consistency：`CliStartupValues`、`CliSessionMarker`、`RollingTerminalInput`、`RollingTerminalItem`、`RollingTerminalPort`、`CliTranscriptConfig` 与 `CliTranscriptProjector` 在所有任务中使用相同名称和字段。
