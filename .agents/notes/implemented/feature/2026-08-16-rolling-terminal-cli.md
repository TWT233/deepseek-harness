# Agent Note: Rolling terminal CLI as the default `dsh` application

Status: implemented

English | [中文](2026-08-16-rolling-terminal-cli.zh.md)

## Problem

The published `dsh` launcher needs an interactive terminal application that starts without requiring a profile choice. Web and Headless already consume provider-neutral Agent, Session, command, user-question, tool-presentation, persistence, and shutdown interfaces, but neither provides a local terminal workflow.

The former full-screen TUI was removed because no product composition used it while its renderer, patched terminal dependency, extension interface, and snapshots still imposed product-scale maintenance. Its [removal decision](../simplification/2026-08-04-remove-tui-package.md) requires a replacement to have a named deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle and transcript verification.

The terminal workflow also needs bounded rendering for long Sessions. Completed output belongs in ordinary terminal scrollback; the application should redraw only current streaming output, running tools, questions, status, and the editor.

## Decision

Bare `dsh` selects the shipped `cli` profile, whose ordered bundles are `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-cli-app`. The launcher remains a thin pre-plugin bootstrap that selects the profile, composes patch layers, provides command-line and process-exit facts, and boots Loader. Agent, Session, rendering, commands, questions, and terminal behavior remain ordinary plugins.

Bare `dsh --resume <id>` selects the same profile and forwards `--resume` to its startup plugin. Standalone bare help and version remain launcher-owned; help after the application-argument boundary is forwarded to the selected application. Launcher flags must precede application arguments, so `--patch` precedes `--resume`.

The shipped CLI profile uses sandbox mode `danger-full-access`, approval policy `never`, and no permission-selector or approval UI. Tool execution still consumes the approval service, whose deterministic `never` policy requires no answerer. The settled startup block prints the exact Session ID for later explicit resume and warns that commands and tools can modify any path available to the process. Model-requested user questions remain interactive through `ctx.userQuestions`.

## Package and profile

`packages/bundle/cli-app` publishes `@deepseek-ai/dsh-cli-app` with three plugin entries:

- `@deepseek-ai/dsh-cli-app/startup` parses `--resume <session-id>` and application help through `dsh-cmdline`, then provides `cliStartup`.
- `@deepseek-ai/dsh-cli-app` creates or resumes one Agent and owns the terminal interaction lifetime.
- `@deepseek-ai/dsh-cli-app/invariant` validates the package-owned durable Session relation.

The package config defaults to `showReasoning: true`, `maxToolOutputLines: 12`, and `maxToolOutputBytes: 32768`. Terminal rendering modules remain implementation-private. A private rolling-terminal interface separates deterministic projection tests from the process terminal without publishing a hypothetical terminal UI capability.

## Session identity and resume

A fresh CLI Agent records `sandbox/mode`, `approval/policy`, then one required `cli/session` event:

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

The event is non-ignorable because a build that does not understand the application's resume semantics must refuse the Session. The package invariant rejects duplicate markers, unsupported versions, and marker values inconsistent with the preceding policy events.

Resume is explicit and preflights persistence before terminal acquisition. It accepts exactly one valid CLI marker and requires the invoking directory to match `SessionHeader.cwd`; a mismatch reports a quoted `cd <workspace> && dsh --resume <id>` recovery command. The resumed Agent keeps the exact Session ID and selects the model from the latest `request/header`, or the deployment default when the Session has no request header.

Version 1 has no cross-process Session lease. Concurrent processes can resume the same persisted ID and race writes.

## Rolling interaction and transcript

The package uses maintained `@mariozechner/pi-tui` input, key decoding, editor, and terminal lifecycle primitives without placing the complete transcript in a full-screen differential tree. Settled items are written once to ordinary scrollback. The renderer clears and redraws only a viewport-bounded active region, so settled transcript length does not increase keystroke rendering work.

Enter submits and Alt+Enter inserts a line break. The editor remains available while the Agent runs: idle submissions call `followup()`, while running submissions call `steer()`. Ctrl+C cancels active Agent work and keeps the process open; Ctrl+C while idle requests exit 130. EOF and `/exit` request normal exit.

The Session log is the sole transcript input. Live assistant chunks update one active record; the durable assistant message settles it. Replay renders assembled messages without replaying their chunks. Human transcript projection reads append-origin events so compaction and result pruning do not erase output already shown, while model history continues to use the model-visible Session projection.

Tool rows ask visible tool definitions for call and result presentation. Terminal, diff, read, search, Web, and generic intents have CLI renderers; missing definitions, malformed historical arguments, and failing presenters produce escaped generic output rather than breaking resume. Parallel calls retain Session order when committed to immutable scrollback. Tool blocks apply both configured line and UTF-8 byte limits.

The CLI registers `/help`, `/clear`, and `/exit` through the scoped command registry. Unknown commands produce a terminal error and never reach the model. Its structured-question provider handles single- and multi-select answers and custom text; it does not handle approvals.

## Security and lifecycle

All untrusted terminal text exposes C0 and C1 controls other than line feeds as visible hexadecimal escapes before wrapping. Only the terminal implementation emits control sequences.

The runner waits for Loader settlement before persistence inspection, Agent creation, or terminal acquisition. Invalid provider or plugin configuration therefore fails before raw terminal mode. After acquisition, the plugin effect owns ordered shutdown: stop input, abort questions and commands, cancel and drain the Agent, flush the Session, dispose the Agent handle, drain terminal protocol replies, and restore the terminal.

The same restoration path covers `/exit`, EOF, active cancellation followed by idle Ctrl+C, SIGTERM, startup failure after acquisition, and plugin disposal. Launcher shutdown remains bounded; repeated process signals retain the forced-exit behavior.

## Verification

Focused package tests pin rolling commitment, viewport-bounded redraws, resize, control escaping, UTF-8 output bounds, transcript replay, presentation fallbacks, commands, questions, resume validation, model selection, cancellation, and teardown ordering. Loader composition verifies the full-access, no-approval-UI profile.

The keyless product snapshot covers one assembled source and built terminal journey with durable Session output. PTY acceptance covers multiline input, steering, cancellation, clear, exit, resume, provider failure before acquisition, SIGTERM, and terminal restoration. Built-bin acceptance covers bare routing, help and version ownership, explicit profiles, Web, Headless, plugin management, and config dumps.

The local PTY evidence does not exhaust terminal emulators, tmux, SSH, or the platform matrix. Cross-process resume races remain an explicit coverage and product gap.

## Alternatives considered

**Restore the former full-screen TUI package.** Rejected because the product requires a rolling terminal, not transcript-wide redraws, selectors, overlays, and extension interfaces.

**Create Service Definition, Provider, and Consumer packages for terminal UI.** Rejected because only one terminal implementation exists. The private test interface provides isolation without publishing a capability with no second provider.

**Implement the terminal application directly in `apps/cli`.** Rejected because interaction behavior would become unpatchable launcher code. Only profile selection must happen before plugins exist.

**Use a line-oriented REPL or Node readline.** Rejected because multiline editing, concurrent streaming, structured questions, enhanced-key decoding, and reliable raw-terminal restoration would be absent or hand-written.

**Automatically resume the latest Session or open a selector.** Rejected because implicit selection can enter the wrong workspace or stale task. Fresh-by-default and explicit resume keep identity and side effects visible.

**Remove the approval service under full access.** Rejected because tool execution consumes the service interface. The `never` policy is the existing deterministic no-prompt path.

## Consequences

Bare `dsh` is a durable interactive coding workflow with normal terminal scrollback, streaming output, steering, structured questions, scoped commands, explicit resume, and bounded active redraws. Web and Headless remain distinct application bundles selected through their existing command lines.

Full access lets Bash and filesystem tools modify every path available to the process, and the CLI provides no runtime approval stop. The warning and documentation are part of the product behavior.

Committed scrollback cannot be rewritten, so the projector commits only settled messages, results, and notices. The package depends on private composition of maintained terminal primitives; semantic tests own the rolling behavior if that dependency changes.
