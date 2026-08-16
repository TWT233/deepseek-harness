# Rolling Terminal CLI Implementation Plan

English | [中文](2026-08-16-rolling-terminal-cli.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare `dsh` launch a durable, plugin-composed rolling terminal coding Agent with multiline input, live transcript and tool rendering, structured user questions, explicit Session resume, and full access without approval prompts.

**Architecture:** Add `@deepseek-ai/dsh-cli-app` as a bundle package over `dsh-base`; `apps/cli` remains a thin profile launcher and maps bare invocations to the new `cli` profile. The package owns a bounded rolling terminal implementation, a Session-log projector, and one runner plugin that composes existing Agent, command, user-question, tool-presentation, policy, and persistence interfaces without modifying `agent-loop`.

**Tech Stack:** TypeScript 6, Cordis plugins/effects, Commander 15, `@mariozechner/pi-tui` terminal input/key/width primitives, Vitest 4, JSONL Session persistence, Python PTY on POSIX, `node-pty` on Windows.

## Global Constraints

- Keep `/data00/home/wangqiyilang/playground/.worktree/interactive-cli/deepseek-harness` on integration branch `feat/interactive-cli` as the sole aggregation, integration-verification, and delivery source. Implement each task on its own branch in a sibling task worktree under `/data00/home/wangqiyilang/playground/.worktree/interactive-cli/`; the root checkout stays a clean `master` mirror.
- Every task below is one independently reviewed commit; run its focused checks, commit with `Co-authored-by: TRAE CLI <noreply@bytedance.com>` exactly once, and push to `fork/feat/interactive-cli` before starting the next task.
- The application is a Cordis plugin bundle. `apps/cli` may select `cli` before plugins load, but it must not own Agent, Session, rendering, commands, questions, or terminal behavior.
- Do not modify `packages/core/agent-loop`; consume `ctx.agents`, `Agent.followup`, `Agent.steer`, `Agent.cancel`, and `Agent.whenIdle`.
- The shipped CLI bundle sets `danger-full-access` and `approval: never`, mounts no approval answerer, and prints a stable warning before the first prompt.
- `ctx.userQuestions` remains interactive because model clarification is not permission approval.
- stdin and stdout must both be TTYs. Pipes and automation continue to use `dsh --profile headless`.
- Completed transcript lines enter ordinary terminal scrollback once. Only bounded live items, status/question rows, and the editor may be redrawn.
- Every untrusted string renders C0/C1 controls other than line feeds as visible hexadecimal escapes before ANSI-aware wrapping.
- The first version includes multiline input, streaming text/reasoning, tool summaries, command output, diffs, questions, `/help`, `/clear`, `/exit`, steering, two-stage Ctrl+C, and explicit `--resume`; it excludes file completion, model selection, Session selection, themes, images, and full-screen overlays.
- Fresh Sessions append `sandbox/mode`, `approval/policy`, then required non-ignorable `cli/session { version: 1, sandboxMode, approvalPolicy }`; resume refuses missing, duplicate, unsupported, inconsistent, or wrong-workspace markers.
- `maxToolOutputLines`, `maxToolOutputBytes`, and `showReasoning` are validated `Config` fields, not hardcoded tunables. Defaults are 12 lines, 32,768 UTF-8 bytes, and `true`.
- Use `TextRetainer({ kind: 'headTail', ... })` for byte retention and package-owned line retention for the line window; do not implement another UTF-8 cutting algorithm.
- New or changed public behavior updates English and Chinese documentation together and re-records pairing sidecars.
- Do not edit `vendor/` or `.agents/notes/archived/`.

## Units, Dependencies, and Write Scopes

| Unit | Write scope | Depends on | Dependency kind |
|---|---|---|---|
| 1. Package and shared contracts | `packages/bundle/cli-app/{src/types.ts,src/session.ts,src/startup.ts,src/invariant.ts,tests/*,package.json,tsconfig.json,README*}`, root TS/config generators | approved spec | — |
| 2. Rolling terminal engine | `packages/bundle/cli-app/src/{display.ts,editor.ts,terminal.ts}`, matching package tests | Unit 1 terminal interfaces and declared terminal dependency | shared interface only |
| 3. Session transcript projector | `packages/bundle/cli-app/src/{content.ts,tool-view.ts,transcript.ts}`, matching package tests | Unit 1 terminal interfaces and declared retention dependency | shared interface only |
| 4. Interactive runner | `packages/bundle/cli-app/src/{commands.ts,questions.ts,runner.ts,index.ts}`, matching package tests | Units 2 and 3 runtime behavior | true blocker |
| 5. Bundle/profile product assembly | `packages/bundle/cli-app/cordis.patch.yml`, `apps/cli/**`, profile loader/tests, package manifests/config | Unit 4 runnable plugin | true blocker |
| 6. Product snapshots and PTY acceptance | `apps/cli/tests/{cli.snapshot.ts,cli-keyless-smoke.e2e.ts,pty-harness.ts,fixtures/cli-*}`, snapshot fixtures | Unit 5 product entry | true blocker |
| 7. Product documentation and decision finalization | root/CLI/bundle/user docs, website manifest, Agent Note lifecycle triplet, generated docs | Unit 6 observed shipped behavior | true blocker |

Units 2 and 3 may run in parallel after Unit 1 commits because they write disjoint files and communicate only through the frozen `RollingTerminalPort` and `RollingTerminalItem` interfaces. Unit 4 cannot start before both: it must instantiate the real terminal and feed it projector updates. Units 5–7 are serial because each validates the preceding product behavior.

## Frozen Interfaces

Unit 1 defines these names exactly; later units consume them without renaming:

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

`RollingTerminalItem.order` is the first Session event sequence that created the visible item. A later update keeps that order. `RollingTerminalPort.upsert()` commits the lowest-order settled prefix only; a settled parallel tool waits behind every lower-order active item.

---

### Task 1: Create the CLI Package and Freeze Shared Contracts

**Files:**
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

**Interfaces:**
- Consumes: `parseCmdline(ctx, Command)`, `Session.append`, `setSandboxMode`, `setApprovalPolicy`, `InvariantRegistry`.
- Produces: every interface in **Frozen Interfaces**, `CLI_STARTUP_SERVICE`, `CLI_SESSION_VERSION`, `appendCliSessionMarker()`, `readCliSessionMarker()`, and the `cli/session` declaration merge.

- [ ] **Step 1: Write startup parser tests**

Add cases that boot the plugin through a real Loader row and assert:

```text
expect(await parseStartup([])).toEqual({})
expect(await parseStartup(['--resume', 'session-1'])).toEqual({
  resumeSessionId: SessionId('session-1'),
})
expect(await parseStartup(['--help'])).toMatchObject({ exitCode: 0 })
expect(await parseStartup(['--resume', ''])).toMatchObject({ exitCode: 1 })
expect(await parseStartup(['unexpected'])).toMatchObject({ exitCode: 1 })
```

- [ ] **Step 2: Run the startup test and confirm the missing module failure**

Run:

```bash
corepack pnpm exec vitest run packages/bundle/cli-app/tests/startup.spec.ts
```

Expected: FAIL because `src/startup.ts` and `CLI_STARTUP_SERVICE` do not exist.

- [ ] **Step 3: Implement the app-owned Commander parser**

Implement `src/startup.ts` with:

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

- [ ] **Step 4: Write Session marker and invariant tests**

Test these exact cases:

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

The invariant test must dispatch the same invalid relations through `ctx.emit('session/event', session, event)` and assert an `InvariantError`. It must also prove that a Session with no marker, plus the fresh CLI's first `sandbox/mode` and `approval/policy` events before its marker, is ignored: Web/Headless Sessions and in-progress CLI initialization are valid.

- [ ] **Step 5: Implement `cli/session` declaration, writer, fold, and invariant**

`src/session.ts` must:

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

`src/invariant.ts` registers package ownership and validates loaded plus newly dispatched logs only after a `cli/session` marker exists. Absence is not a global invariant failure; strict presence belongs to resume preflight through `readCliSessionMarker()`. The marker remains non-ignorable; run `gen-persistence-catalog` so it enters `KNOWN_SESSION_EVENT_TYPES`.

- [ ] **Step 6: Add the frozen terminal and transcript types**

Put the exact **Frozen Interfaces** declarations in `src/types.ts`. `src/index.ts` re-exports `src/types.ts` and `src/session.ts`; it does not yet expose an `apply` plugin.

- [ ] **Step 7: Create the package manifest, TS project, and package docs**

Use root version `0.1.0-rc.5`, MIT, ESM, `lib/index.js`, `lib/invariant.js`, `lib/startup.js`, and declarations. Add `commander`, `@mariozechner/pi-tui@0.73.1`, `@deepseek-ai/dsh-cmdline`, `@deepseek-ai/dsh-output-retention`, and `@deepseek-ai/schemastery` as runtime dependencies; mirror Cordis and every DSH interface import in peer/dev dependencies. Add project references for every dependency Unit 2 or Unit 3 will import now, so those parallel units never touch `package.json`, `tsconfig.json`, or `pnpm-lock.yaml`. Add the Host aggregate reference and startup source path. Register the package in `knip.json` and the model-experience sentence map, then run `corepack pnpm install --lockfile-only`.

- [ ] **Step 8: Generate persistence files and record bilingual docs**

Run the English generator, update the matching `cli/session` row in the reviewed Chinese catalog, then record the pair:

```bash
corepack pnpm run gen-persistence-catalog
corepack pnpm run verify-translation-pairing --write packages/bundle/cli-app/README.md
corepack pnpm run verify-translation-pairing --write docs/persistence-catalog.md
```

Expected: `cli/session` appears in the generated known-event list and persistence catalog.

- [ ] **Step 9: Run focused tests and package checks**

Run:

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

Expected: all pass.

- [ ] **Step 10: Commit and push the interface checkpoint**

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

### Task 2: Implement the Bounded Rolling Terminal Engine

**Files:**
- Create: `packages/bundle/cli-app/src/display.ts`
- Create: `packages/bundle/cli-app/src/editor.ts`
- Create: `packages/bundle/cli-app/src/terminal.ts`
- Create: `packages/bundle/cli-app/tests/display.spec.ts`
- Create: `packages/bundle/cli-app/tests/editor.spec.ts`
- Create: `packages/bundle/cli-app/tests/terminal.spec.ts`

**Interfaces:**
- Consumes: `RollingTerminalInput`, `RollingTerminalItem`, `RollingTerminalPort` from Task 1.
- Produces: `createRollingTerminal(device, options): RollingTerminalPort`, `ProcessTerminalDevice`, `displayText()`, `wrapDisplayLines()`.

- [ ] **Step 1: Write display escaping and width tests**

Cover control bytes, CJK width, ANSI owned by the renderer, and resize:

```text
expect(displayText('safe\u001b[31mred\u009b')).toBe('safe\\x1B[31mred\\x9B')
expect(wrapDisplayLines('你好 world', 6)).toEqual(['你好', 'world'])
expect(wrapDisplayLines('a\nb', 80)).toEqual(['a', 'b'])
```

- [ ] **Step 2: Write editor behavior tests**

Use a fake input stream and assert:

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

Also pin Backspace, arrows across wrapped lines, Ctrl+A/Ctrl+E, Ctrl+U/Ctrl+K, Ctrl+W, paste markers, history Up/Down, disabled submit during questions, and terminal resize.

- [ ] **Step 3: Write rolling commitment tests**

Use a fake `TerminalDevice` and assert settled ordering:

```text
terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
terminal.upsert({ id: 'b', order: 2, settled: true, lines: ['B done'] })
expect(device.scrollback).toEqual([])
terminal.upsert({ id: 'a', order: 1, settled: true, lines: ['A done'] })
expect(device.scrollback).toEqual(['A done', 'B done'])
expect(device.activeLines).toContain('> ')
```

Add cases for an update retaining its original order, item removal, question/status rows, `clear()`, resize, a 100,000-line committed history not participating in later redraw, and `stop()` restoring raw mode, bracketed paste, keyboard protocol, cursor, and input pause.

- [ ] **Step 4: Implement display and multiline editor modules**

Use public `@mariozechner/pi-tui` exports `matchesKey`, `visibleWidth`, `sliceByColumn`, and wrapping utilities. Do not instantiate `TUI` or access its private `previousLines`; `editor.ts` owns only the confirmed key set and emits the Task 1 input union.

- [ ] **Step 5: Implement the process terminal adapter and active-region algorithm**

`ProcessTerminalDevice` wraps public `ProcessTerminal.start`, `drainInput`, `stop`, `write`, `columns`, and `rows`. `createRollingTerminal` tracks:

```text
const active = new Map<string, RollingTerminalItem>()
let activeHeight = 0
let committedCount = 0
```

Before each redraw, move to the active region's first row and clear exactly `activeHeight` rows. Commit only the contiguous lowest-order settled prefix, write each final line once with `\r\n`, then draw active items, question, status, and editor. Keep no committed line content after writing it.

- [ ] **Step 6: Run focused coverage**

Run:

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

Expected: PASS with per-file 100% thresholds.

- [ ] **Step 7: Commit and push**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): add rolling terminal engine" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 3: Project Session Events into Terminal Items

**Files:**
- Create: `packages/bundle/cli-app/src/content.ts`
- Create: `packages/bundle/cli-app/src/tool-view.ts`
- Create: `packages/bundle/cli-app/src/transcript.ts`
- Create: `packages/bundle/cli-app/tests/content.spec.ts`
- Create: `packages/bundle/cli-app/tests/tool-view.spec.ts`
- Create: `packages/bundle/cli-app/tests/transcript.spec.ts`

**Interfaces:**
- Consumes: `RollingTerminalPort`, `RollingTerminalItem`, `CliTranscriptConfig`, `ctx.tools.get(name, agent)`, append-origin Session events.
- Produces: `CliTranscriptProjector` with the exact constructor and methods frozen in Task 1.

- [ ] **Step 1: Write content rendering tests**

Pin text, dim reasoning, images as unsupported notices, nested tool-result content, control escaping, and byte/line bounds:

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

Add a multibyte case whose UTF-8 result stays valid after `TextRetainer` head/tail cutting.

- [ ] **Step 2: Write tool-intent renderer tests**

Construct definitions for `generic`, `terminal`, `diff`, `read`, `search`, and `web` intents. Assert the renderer uses the intent tag, never the tool name. Add generic fallback cases for unknown tools, malformed JSON arguments, missing cross-page calls, and throwing `presentCall`/`presentResult`.

- [ ] **Step 3: Write projector replay and live tests**

Use a fake terminal port. Required cases:

```text
projector.accept(chunk(1, 1, { type: 'text-delta', index: 0, text: 'hel' }))
projector.accept(chunk(1, 1, { type: 'text-delta', index: 0, text: 'lo' }))
expect(active('assistant:1:1').lines).toEqual(['hello'])
projector.accept(assistantMessage(1, 1, 'hello'))
expect(active('assistant:1:1').settled).toBe(true)
```

Replay must ignore raw chunks when the assembled `assistant/message` exists, render only append-origin surface events, exclude plugin context from human prose, preserve direct human messages, pair tool call/result by `callId`, hold later parallel results behind earlier active calls, and render `turn/end` error/aborted/max-token notices.

- [ ] **Step 4: Implement `content.ts` and bounded tool rendering**

Use `TextRetainer` for bytes. Implement the line cap in the CLI package: if over the configured line count, retain `floor((maxLines - 1) / 2)` head lines and the remaining tail lines around one omission notice.

- [ ] **Step 5: Implement `tool-view.ts`**

Parse call arguments once and retain `{ name, args, order }` by `callId`. Call presenters under `try/catch` with the exact current Agent scope. Map every current `ToolCallView` and `ToolResultView` discriminant; the merge-extensible default returns a generic escaped block.

- [ ] **Step 6: Implement `CliTranscriptProjector`**

`replay(events)` first indexes assembled assistant coordinates, then folds event order. `accept(event)` updates only the exact live stream. Item IDs are deterministic: `user:<seq>`, `assistant:<turn>:<step>`, `tool:<callId>`, and `notice:<seq>`.

- [ ] **Step 7: Run focused coverage**

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

Expected: PASS with per-file 100% thresholds.

- [ ] **Step 8: Commit and push**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): render session transcript" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 4: Compose Agent Lifecycle, Commands, Questions, and Teardown

**Files:**
- Create: `packages/bundle/cli-app/src/commands.ts`
- Create: `packages/bundle/cli-app/src/questions.ts`
- Create: `packages/bundle/cli-app/src/runner.ts`
- Modify: `packages/bundle/cli-app/src/index.ts`
- Create: `packages/bundle/cli-app/tests/commands.spec.ts`
- Create: `packages/bundle/cli-app/tests/questions.spec.ts`
- Create: `packages/bundle/cli-app/tests/runner.spec.ts`

**Interfaces:**
- Consumes: Units 2 and 3 runtime implementations, `ctx.agents.create/resume`, model selection, persistence inspect, canonical policy writers, `ctx.commands`, and `ctx.userQuestions`.
- Produces: root plugin `name = 'cli-runner'`, validated `Config`, `runCli()`, and process-backed terminal factory in `internals`.

- [ ] **Step 1: Write command tests**

Assert `/help` includes `help`, `clear`, `exit`, and dynamically registered scoped commands; `/clear` calls only `terminal.clear()`; `/exit` requests graceful shutdown; unknown slash input returns a terminal error and never calls `agent.followup`.

- [ ] **Step 2: Write structured question tests**

Pin exact parsing:

```text
expect(parseSingleAnswer('2', question)).toEqual({ selected: ['B'] })
expect(parseSingleAnswer('custom answer', question)).toEqual({ selected: [], custom: 'custom answer' })
expect(parseMultiAnswer('1,3; extra', question)).toEqual({
  selected: ['A', 'C'],
  custom: 'extra',
})
expect(parseMultiAnswer('', question)).toEqual({ selected: [] })
```

Add invalid index, duplicate index, cancellation, batch progression, input disabling, and provider disposal cases.

- [ ] **Step 3: Write runner lifecycle tests with a fake terminal**

Cover:

- fresh Agent uses `agentDefaultModel.currentSelection()`;
- fresh Session appends `sandbox/mode`, `approval/policy`, then `cli/session`;
- resume preflights with `sessionPersistence.inspect()` before terminal start;
- resume uses the latest `request/header` model or deployment default for a blank Session;
- missing/duplicate/version/policy marker and cwd mismatch fail before raw mode;
- cwd mismatch names the exact quoted `cd ... && dsh --resume ...` recovery command;
- idle submit calls `followup`, running submit calls `steer`;
- running Ctrl+C calls `agent.cancel({ kind: 'user' })`, idle Ctrl+C requests 130, idle EOF and `/exit` request 0;
- disposer aborts questions/commands, cancels Agent, awaits `whenIdle`, flushes, disposes the owned handle, then stops the terminal;
- failure after terminal start still calls `stop()`.

- [ ] **Step 4: Implement commands and questions**

Register commands under `agent.ctx.inject(['commands'], ...)` so scoped shadowing and disposal work. Register one root `ctx.userQuestions` provider and reject a request whose `request.agent` is not the runner's exact Agent.

- [ ] **Step 5: Implement resume preflight and model selection**

Use:

```text
const inspected = await ctx.sessionPersistence.inspect(id)
const marker = readCliSessionMarker(inspected.events)
assertSameWorkspace(inspected.meta.cwd, process.cwd())
const logged = inspected.events.findLast(event => event.type === 'request/header')
const selection = logged?.data.header.config ?? ctx.agentDefaultModel.currentSelection()
```

Pass the resulting provider/model/reasoning effort as `agentOptions` and install one `ModelSelectionRef` in Agent setup for both create and resume.

- [ ] **Step 6: Implement runner orchestration**

`runCli(ctx, config, startup, terminalFactory)` must:

1. await Loader settlement;
2. reject non-TTY process streams through the production factory;
3. preflight resume or mint a new Session ID;
4. register Session filtering and user questions;
5. create/resume the owned Agent;
6. append fresh policy and CLI marker;
7. replay existing events into `CliTranscriptProjector`;
8. print the effective full-access warning;
9. start terminal input;
10. await the application-exit request.

`apply` reads launcher-owned `ctx.appExit`; absence fails loud. The runner owns the returned `AgentHandle`.

- [ ] **Step 7: Run focused coverage**

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

Expected: PASS with per-file 100% thresholds.

- [ ] **Step 8: Commit and push**

```bash
git add packages/bundle/cli-app
git commit -m "feat(cli): run interactive agent sessions" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 5: Ship the CLI Bundle and Make It the Bare Command

**Files:**
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

**Interfaces:**
- Consumes: runnable `@deepseek-ai/dsh-cli-app` plugin from Task 4.
- Produces: in-box `cli` profile, bare `dsh` routing, bundle patch, installed package closure.

- [ ] **Step 1: Write launcher parser failures and defaults**

Update `args.spec.ts` so:

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

Keep all existing `web`, `plugin`, explicit-profile, late-launcher-flag, and contradictory-dump assertions.

- [ ] **Step 2: Add the `cli` profile template and migration tests**

`PROFILE_TEMPLATES.cli` is exactly:

```text
['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-cli-app']
```

Extend profile tests to auto-initialize `cli`. Do not add an installation-owned legacy tuple because no released CLI tuple exists.

- [ ] **Step 3: Write the bundle patch**

The patch must:

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

- [ ] **Step 4: Write composition acceptance**

Boot `dsh-base` plus `dsh-cli-app` through the real Loader with a test startup service and fake terminal factory. Assert zero unsettled rows, `ctx.sandboxPolicy.defaultMode === 'danger-full-access'`, `ctx.approval.config.policy === 'never'`, `ctx.get('permissionPresets') === undefined`, and one CLI Session marker.

- [ ] **Step 5: Wire package publication and source resolution**

Add `dsh.bundle.patch` and `cordis.patch.yml` to the package manifest; terminal and retention dependencies were frozen in Task 1. Add `@deepseek-ai/dsh-cli-app` to `apps/cli` dependencies so in-box resolution and profile fallback healing include it. Add the bundle file exception to workspace constraints and update the lockfile with:

```bash
corepack pnpm install --lockfile-only
```

- [ ] **Step 6: Update bare launcher grammar**

Change only the root command action: absent `--profile` resolves `cli`, except bare help/version remain launcher-owned. Replace stale TUI examples with bare CLI, explicit resume, Web, Headless, and plugin examples.

- [ ] **Step 7: Extend built-bin acceptance**

Add:

- `dsh --profile cli --help` exits 0 without acquiring terminal state;
- bare `dsh` under piped test stdio exits 1 with the TTY diagnostic;
- bare `--dump-default-config` includes `dsh-cli-app`, `danger-full-access`, `policy: never`, and no Web Host rows;
- existing Web and Headless built tests remain byte-compatible.

- [ ] **Step 8: Run assembly checks**

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

Expected: all pass.

- [ ] **Step 9: Commit and push**

```bash
git add packages/bundle/cli-app packages/bundle/README* \
  packages/boot/app-boot/src/profile.ts packages/boot/app-boot/tests/profile.spec.ts \
  apps/cli pnpm-lock.yaml scripts/check-workspace-constraints.ts
git commit -m "feat(cli): ship default terminal profile" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 6: Add Keyless Product Snapshots and PTY Lifecycle Acceptance

**Files:**
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

**Interfaces:**
- Consumes: shipped product profile from Task 5.
- Produces: keyless terminal/output golden and real PTY lifecycle regression suite.

- [ ] **Step 1: Restore a product-neutral PTY harness**

Adapt the historical Python `pty.fork()` driver and Windows `node-pty` driver into `runCliPtySmoke()`. Keep marker-gated actions, exact expected exit code, configurable columns/rows, isolated `$DSH_HOME`, prepare/inspect callbacks, and a timeout that reports complete captured bytes. Add `node-pty: ^1.1.0` to `apps/cli` devDependencies and refresh the lockfile with `corepack pnpm install --lockfile-only`.

- [ ] **Step 2: Build a deterministic scripted model fixture**

The fixture must produce this sequence without network:

1. reasoning delta and visible text;
2. a terminal-intent `bash` call;
3. a diff-intent file edit;
4. `ask_user_question` with two options and custom text support;
5. a final answer containing the selected response;
6. a second turn held long enough for a steering submission.

The patch disables the real DeepSeek row and inserts the scripted adapter while leaving the real Agent loop, tools, Session persistence, and CLI runner assembled.

- [ ] **Step 3: Write the keyless CLI snapshot**

Drive the product source bin in a PTY, normalize cwd, Session ID, ANSI styling, timestamps, and terminal dimensions, then compare:

```text
expect(normalizedTerminal).toBe(await readFile(terminalExpected, 'utf8'))
expect(normalizedSession).toBe(await readFile(sessionExpected, 'utf8'))
```

The terminal golden must show the full-access warning, multiline user input, streamed reasoning/text, bash summary/output, diff, question/options/answer, steering, and final `/exit`. The Session golden must include the policy pair and one `cli/session` marker.

- [ ] **Step 4: Write focused PTY lifecycle cases**

Add cases for:

- Alt+Enter multiline submission;
- running submit becomes steering;
- first Ctrl+C aborts active turn and leaves the editor; second idle Ctrl+C exits 130;
- `/clear` clears the visible active area but the persisted Session retains prior turns;
- `/exit` exits 0 after flush;
- first process creates a Session and second `dsh --resume <id>` replays it in the same cwd;
- wrong cwd rejects before raw mode and prints the recovery command;
- invalid provider after terminal acquisition exits 1 and output contains bracketed-paste disable plus cursor restoration;
- SIGTERM exits 0 through bounded tree disposal.

- [ ] **Step 5: Run snapshot and PTY suites**

```bash
corepack pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/cli.snapshot.ts
corepack pnpm exec vitest run apps/cli/tests/cli-keyless-smoke.e2e.ts
```

Expected: PASS in replay mode with no API key.

- [ ] **Step 6: Update testing documentation and pair it**

State that completed rolling-terminal journeys live under `apps/cli/tests/snapshots/`, while raw input, Loader selection, and terminal restoration use the PTY suite. Do not restate fixture internals.

```bash
corepack pnpm run verify-translation-pairing --write docs/testing.md
```

- [ ] **Step 7: Commit and push**

```bash
git add apps/cli/tests apps/cli/package.json pnpm-lock.yaml docs/testing*
git commit -m "test(cli): cover rolling terminal journeys" \
  -m "Co-authored-by: TRAE CLI <noreply@bytedance.com>"
git push fork feat/interactive-cli
```

---

### Task 7: Publish User Documentation and Finalize the Decision

**Files:**
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
- Regenerate: generated catalogs/graphs touched by package and event additions

**Interfaces:**
- Consumes: observed behavior and passing acceptance from Tasks 1–6.
- Produces: current-state user docs, website route, implemented decision record, clean release-facing package metadata.

- [ ] **Step 1: Rewrite the Agent Note into implemented form**

Move the triplet to `implemented/feature`, change `Status: proposed` to `Status: implemented`, rename `## Proposal` to `## Decision`, replace future-tense delivery units with present-tense package/behavior facts, fold acceptance criteria and risks into `## Verification` and `## Consequences`, and keep all genuine alternatives. Do not archive the TUI removal note: update its false “no terminal UI package” consequence to state that `@deepseek-ai/dsh-tui` remains removed and `dsh-cli-app` is a distinct rolling application.

- [ ] **Step 2: Make the root quick start CLI-first**

Document:

```bash
npx @deepseek-ai/dsh
```

as the default terminal path and:

```bash
npx @deepseek-ai/dsh web
```

as the browser alternative. The full-access warning must be adjacent to the first command.

- [ ] **Step 3: Write the CLI user tutorial**

`docs/user/guide/cli.md` must cover prerequisites, start, multiline input, steering, tools/reasoning, questions, `/help`, `/clear`, `/exit`, Ctrl+C, Session ID/resume, same-workspace requirement, full-access/no-approval risk, and the Headless command for automation. Keep exact reference semantics in `apps/cli/reference/README.md`.

- [ ] **Step 4: Update CLI/package/architecture references**

The CLI README lists `dsh`, `dsh --resume`, Web, Headless, plugin management, config dumps, and flag boundary examples. Architecture adds `cli-app` beside Web and Headless in profile/bundle composition. Bundle README adds the package row. Package README reflects exact Config defaults, lifecycle, model effects, and limitations.

- [ ] **Step 5: Publish the tutorial in the website manifest**

Add a paired page:

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

Move the existing Web guide to order 2 and providers to order 3.

- [ ] **Step 6: Regenerate and pair**

Run:

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

- [ ] **Step 7: Run final relevant evidence**

Use a temporary Corepack shim if nested scripts cannot find `pnpm`:

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

Expected: every command passes. Do not run repository-wide coverage; focused package coverage already owns new source files and CI owns exhaustive coverage/platforms.

- [ ] **Step 8: Commit, push, and verify the integration branch**

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

Expected: local and remote SHAs match, and the worktree is clean.

## Plan Self-Review

- Spec coverage: package/plugin boundary, bare routing, full access, no approval UI, user questions, marker/resume, rolling scrollback, multiline input, streaming/reasoning, tool intents, commands, interruption, teardown, snapshots, PTY, built-bin behavior, bilingual docs, website publication, and Agent Note lifecycle each map to a task.
- Placeholder scan: the plan contains no unfinished values or generic “add tests/error handling” steps; every code-producing task names files, interfaces, assertions, commands, and expected outcomes.
- Type consistency: `CliStartupValues`, `CliSessionMarker`, `RollingTerminalInput`, `RollingTerminalItem`, `RollingTerminalPort`, `CliTranscriptConfig`, and `CliTranscriptProjector` use the same names and fields across all tasks.
