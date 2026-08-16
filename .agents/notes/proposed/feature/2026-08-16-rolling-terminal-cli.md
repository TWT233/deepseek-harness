# Agent Note: Rolling terminal CLI as the default `dsh` application

Status: proposed

English | [中文](2026-08-16-rolling-terminal-cli.zh.md)

## Problem

The published `dsh` command is a profile launcher, not an interactive terminal agent. A user must choose the Web profile or submit one Headless task; bare `dsh` fails because `--profile` is required. The repository already owns provider-neutral Agent, Session, command, user-question, tool-presentation, persistence, and shutdown interfaces, but no shipped terminal application consumes them.

The former full-screen TUI was removed because no product composition used it and its retained package still imposed a product-sized renderer, patched terminal dependency, extension interface, and snapshot corpus. The [removal decision](../../implemented/simplification/2026-08-04-remove-tui-package.md) requires any replacement to have a named deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle and transcript acceptance. Reintroducing that full-screen implementation would also restore its long-session cost: every input frame remained coupled to the complete rendered transcript.

The required product is narrower. Bare `dsh` should start a durable coding Agent in the invoking directory, keep completed output in normal terminal scrollback, and redraw only the bounded live area containing streaming output, running tools, questions, and the editor. The shipped terminal profile deliberately runs with full filesystem access and no approval prompts.

## Proposal

Ship one rolling terminal application as an ordinary Cordis plugin bundle and make its profile the launcher's default. `apps/cli` remains a thin pre-plugin bootstrap: it selects a profile, composes patch layers, provides command-line and process-exit facts, and boots the Loader. Every Agent, Session, terminal interaction, rendering, command, question, and policy behavior belongs to plugins.

### Package and profile

Add `packages/bundle/cli-app`, published as `@deepseek-ai/dsh-cli-app`. The package contains the application bundle and its only implementation rather than introducing a hypothetical terminal UI service with one adapter. It exports:

- `@deepseek-ai/dsh-cli-app/startup`, an ordinary plugin that injects `cmdlineArgs`, parses `--resume <session-id>` and `--help`, and provides `cliStartup`;
- `@deepseek-ai/dsh-cli-app`, the runner plugin that creates or resumes one Agent and owns the terminal interaction lifetime;
- `@deepseek-ai/dsh-cli-app/invariant`, the package-owned runtime invariant companion;
- `@deepseek-ai/dsh-cli-app/cordis.patch.yml`, the bundle layer over `@deepseek-ai/dsh-base`.

The package's external interface is its plugin exports, validated configuration, and bundle patch. Terminal rendering modules remain implementation-private. An internal `RollingTerminal` interface separates deterministic projection tests from the real process terminal; it is not a Cordis service or a package export.

Add a shipped `cli` profile template whose ordered bundles are `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-cli-app`. Bare `dsh` selects this profile. `dsh --resume <id>`, `dsh --patch <file> --resume <id>`, and bare config dumps therefore target `cli`; `dsh web`, `dsh plugin`, and explicit `dsh --profile <name>` retain their current meanings. Bare `--help` and `--version` remain launcher-owned, while `dsh --profile cli --help` reaches the application's help. Launcher flags still end at the first unrecognized app argument, so `--patch` must precede `--resume`.

The CLI bundle overrides `sandbox-policy` to `danger-full-access`, overrides `approval` to `never`, and disables the `permission` preset service. The approval service remains mounted because tool execution depends on it, but its deterministic `never` policy dispatches no answerer and the CLI registers no approval UI. The home and profile patch layers still outrank the bundle, so an operator can explicitly replace this deployment policy; the CLI records the effective values in every fresh Session so resume cannot silently reinterpret them.

Before the first editor prompt, the runner prints one stable warning naming the effective sandbox and approval policy. Under the shipped defaults it states that full access can modify every path available to the process and that approval prompts are disabled. The keyless CLI snapshot pins this wording.

### Startup and Session identity

`cli-startup` provides this immutable value:

```ts ignore-check
interface CliStartupValues {
  resumeSessionId?: SessionId
}
```

The runner injects `agentDefaultModel`, `agents`, `approval`, `cliStartup`, `commands`, `loader`, `sandboxPolicy`, `sessionPersistence`, `sessions`, `tools`, and `userQuestions`. It waits for Loader settlement before creating runtime state. It rejects non-TTY stdin or stdout, invalid arguments, missing Sessions, unsupported CLI Session versions, and workspace mismatches before enabling raw input.

A fresh invocation mints the opaque Session ID before Agent creation, installs the filtered Session listener and user-question provider, and creates the Agent through `ctx.agents`. Before accepting input it appends the effective sandbox and approval values through their canonical event writers, then appends one required log-only application marker:

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

The marker is not `ignorable`: a build that does not understand the terminal application's required resume semantics must refuse the Session rather than guess. The CLI invariant rejects multiple markers, an unknown version, and a marker whose values disagree with the latest preceding `sandbox/mode` and `approval/policy` facts.

`dsh --resume <id>` inspects persistence without publishing an Agent, requires exactly one valid `cli/session` marker, and requires the invoking directory to resolve to the same filesystem identity as `SessionHeader.cwd`. A mismatch fails with a quoted `cd <workspace> && dsh --resume <id>` command. The runner then resumes the exact Session ID through `ctx.agents`, preserving its logged policy instead of applying a later profile default. Version 1 does not acquire a cross-process Session lock; concurrent resume remains a documented risk.

### Rolling terminal ownership

Use maintained `@mariozechner/pi-tui` input, key-decoding, editor, and terminal-lifecycle primitives, but do not put the complete transcript in its differential component tree. A package-private rolling renderer owns two regions:

1. committed lines already written to ordinary terminal scrollback;
2. a bounded active region containing the current assistant stream, running tool rows, an optional question, status, and the multiline editor.

Each update clears and redraws only the active region. When an item becomes immutable, the renderer removes the active region, writes the item's final escaped lines once, and redraws the remaining active region below them. A terminal resize invalidates only active layout. Settled transcript size therefore does not affect keystroke rendering cost.

All untrusted strings pass through one display-text function before ANSI-aware wrapping. It renders C0 and C1 controls other than line feeds as visible hexadecimal escapes. Only the terminal implementation emits control sequences. Complete rendered tool blocks, including titles and truncation notices, are bounded by the runner's `maxToolOutputLines` and `maxToolOutputBytes` configuration; truncation keeps a head and tail plus the omitted count.

The editor remains available while the Agent runs. Enter submits; Shift+Enter, Ctrl+Enter, or Alt+Enter inserts a line break when the terminal reports the modified key. An idle submission calls `agent.followup()`, while a running submission calls `agent.steer()`. Empty submissions are ignored.

### Transcript and tool projection

The Session log is the sole transcript input. Live rendering filters `session/event` by the exact target Session. Resume renders existing events once before opening the editor. It reconstructs human history from append-origin events rather than the model's replacement surface, so compaction and result pruning never erase output the human already saw.

Live `assistant/chunk` text and reasoning deltas update one active assistant record. The matching `assistant/message` replaces that provisional record with the assembled durable content and commits it once; replay renders the assembled message directly and does not replay its chunks. Reasoning is shown dimmed by default and may be disabled through `showReasoning`.

Each `tool/call` creates an active row keyed by `callId`. The CLI parses its arguments and asks the visible tool definition for `presentCall`; the paired `tool/result` asks the same definition for `presentResult`, including durable presentation metadata. Invalid historical arguments, absent definitions, or throwing presenters fall back to a generic escaped tool name, arguments, result content, and failure state rather than failing resume. Terminal, diff, read, search, Web, and generic intents receive CLI renderers; no renderer branches on a tool name.

Parallel calls occupy rows in call order. A later call that settles first shows its settled state in the active region but waits for every earlier call in that ordered group before commitment, so immutable scrollback preserves Session order without rewriting prior terminal lines.

Direct human `user/message` events render as user entries. Plugin context remains logged and model-visible but does not become ordinary human transcript prose. Turn failures, retries, cancellation, max-token endings, and command results render concise stable notices from their authoritative events.

### Commands, questions, and interruption

Input beginning with a syntactically valid slash command is dispatched through `ctx.commands`. Unknown commands produce a terminal error and never reach the model. The CLI registers three Agent-scoped commands:

- `/help` lists terminal keys plus the current scoped command descriptors;
- `/clear` clears the current visible terminal area without mutating the Session or deleting terminal scrollback;
- `/exit` cancels active work, waits for Agent quiescence, flushes the Session, restores the terminal, and requests exit code 0.

The CLI registers one `ctx.userQuestions` provider for the root Agent. It presents a request's questions sequentially in the active region. A single-select answer accepts one option number or arbitrary non-empty custom text. A multi-select answer accepts comma-separated option numbers and an optional `; custom text` suffix; a blank answer skips that item. The provider returns the existing structured answer type and aborts when the owning request, Agent, or terminal lifetime ends. This provider handles model-requested clarification only; approval requests never reach it.

Raw Ctrl+C cancels a running Agent activity with the existing user cancellation cause and leaves the process alive. Ctrl+C while idle requests exit code 130. Ctrl+D while idle and `/exit` request a normal exit. External SIGINT and SIGTERM remain launcher-owned and dispose the same plugin tree. Input is disabled while a user question owns the editor.

### Teardown and failures

The rolling terminal controller is one Cordis effect. Its disposer stops input admission, aborts a pending question or command, cancels and drains the owned Agent, flushes its Session, drains terminal protocol replies, disables bracketed paste and enhanced keyboard protocols, restores the prior raw mode and cursor state, and only then resolves. Startup failure after terminal acquisition disposes this same effect through the launcher's fail-loud release hook.

Model, tool, command, and rendering failures are contained to a stable terminal notice whenever the Agent can continue. A process-level or Loader failure prints its diagnostic before bounded teardown. Disposal timeout and repeated signals retain the launcher's existing forced-exit behavior.

### Delivery units and dependencies

The implementation is split into independently reviewable commits:

1. **Plugin and profile interface** — package manifest, exports, startup parser, bundle patch, `cli` profile template, bare-launch routing, application marker type and invariant. This freezes every cross-unit path and type.
2. **Rolling terminal engine** — private terminal adapter, editor host, control escaping, active-region commit algorithm, bounds, and deterministic fake-terminal tests.
3. **Transcript projection** — Session event reducer plus assistant, tool-intent, failure, and replay renderers. It depends only on the frozen internal terminal update interface, not the process terminal.
4. **Interactive runner** — Agent create/resume, policy pinning, commands, question provider, steering, cancellation, and teardown. It consumes units 2 and 3.
5. **Assembled acceptance and documentation** — keyless terminal snapshots, PTY lifecycle cases, built-bin routing, package and user documentation, generated catalogs, and the implemented rewrite of this Note.

Unit 1 is a true blocker because units 2–4 compile against its package paths and types. Units 2 and 3 share only the frozen terminal-update interface and may proceed in parallel with disjoint files. Unit 4 is truly blocked by both implementations because it composes their runtime behavior. Unit 5 is blocked by the complete runnable application.

### Verification

Package tests pin active-region redraws, immutable commitment, resize behavior, multibyte byte bounds, control escaping, assistant chunk assembly, append-origin replay, presenter fallbacks, parallel call ordering, question parsing, commands, and cancellation. Coverage targets every new package source file.

A Loader composition test boots `dsh-base` plus `dsh-cli-app`, proves zero unsettled rows, and inspects the effective `danger-full-access` and `never` defaults with the permission selector absent.

A keyless runnable CLI snapshot replays a multi-turn model script through the product profile and compares terminal text plus the persisted Session, including reasoning, one terminal call, one diff, a user question, and steering. PTY acceptance owns modified-enter input, `/clear`, `/exit`, active-then-idle Ctrl+C, resume, startup failure after raw-mode acquisition, and terminal restoration. Built-bin acceptance proves bare `dsh` selects `cli` while Web, plugin management, explicit profiles, config dumps, and version output retain their meanings.

## Alternatives considered

**Restore the former full-screen TUI package.** Rejected because the requirement is a rolling terminal, not a full-screen application. Restoring the old package would revive transcript-wide redraw cost, selectors, overlays, extension interfaces, and compatibility work that this product does not need.

**Create Service Definition, Provider, and Consumer packages for terminal UI.** Rejected because only one terminal implementation exists. The private test interface provides isolation without publishing a hypothetical capability seam; a second real adapter can justify extraction later.

**Implement the terminal application directly in `apps/cli`.** Rejected because interaction behavior would become unpatchable launcher code. The launcher must choose a profile before plugins exist, but everything after that decision can and should remain in the Cordis tree.

**Use a line-oriented REPL or Node readline only.** Rejected because multiline editing, concurrent streaming, structured questions, enhanced-key decoding, and reliable raw-terminal restoration would either be absent or hand-rolled. The rolling renderer reuses maintained terminal primitives without adopting a full-screen transcript.

**Automatically resume the latest Session or open a selector.** Rejected for the first version because implicit selection can enter the wrong workspace or stale task. Fresh-by-default plus explicit `--resume` keeps identity and side effects visible.

**Remove the approval service entirely under full access.** Rejected because tool execution consumes the service interface. The `never` policy is the existing deterministic no-prompt path and keeps the capability graph complete.

## Acceptance criteria

- Bare `dsh` starts a fresh interactive CLI Agent in a TTY; `dsh --resume <id>` resumes only a valid CLI Session in the same workspace.
- The product profile records and enforces `danger-full-access` plus `never` by default, presents no approval interaction, and clearly documents the risk.
- Completed transcript output remains in ordinary terminal scrollback, while keystroke redraw cost is independent of settled Session length.
- Multiline input, live steering, reasoning, tool summaries, terminal output, diffs, structured user questions, `/help`, `/clear`, `/exit`, and two-stage Ctrl+C work through existing provider-neutral interfaces.
- Resume and live rendering derive from the Session log and tool presentation methods without a second transcript or tool-name-specific renderer.
- Every exit and failure path restores the terminal, flushes the owned Session when possible, and reaches bounded process shutdown.
- Focused package coverage, Loader composition, keyless snapshot, PTY acceptance, built-bin acceptance, build, hygiene, documentation gates, and the selected pre-push checks pass.

## Risks

Full access lets Bash and filesystem tools modify every path the `dsh` process can access. The CLI must state this at startup and in user documentation; it deliberately provides no runtime approval stop.

Terminal protocols differ across emulators, tmux, SSH, and Windows consoles. The implementation relies on maintained decoding primitives and PTY acceptance but cannot exhaust the platform matrix locally.

Committed scrollback cannot be rewritten. Incorrectly committing a provisional item would leave contradictory output, so the projector commits only durable assembled messages, paired results, and terminal notices whose source event has settled.

There is no cross-process Session lease. Two CLI processes can resume the same persisted ID and race writes; version 1 detects only Sessions live in its own process and documents the limitation.

The terminal dependency may change private behavior. The CLI uses only published input, editor, key, and terminal lifecycle interfaces; the package-private rolling renderer and semantic tests own all scrollback behavior.
