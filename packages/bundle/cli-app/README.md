# `@deepseek-ai/dsh-cli-app`

English | [中文](README.zh.md)

Interactive rolling-terminal application and full-access CLI bundle. The package exports its root runner plugin, the [`startup`](src/startup.ts) command-line provider, the [`invariant`](src/invariant.ts) companion, durable CLI Session helpers, and the bundle patch.

The startup entry parses `dsh --profile cli [--resume <session-id>]` through the launcher-owned [`dsh-cmdline`](../../boot/cmdline/README.md) service and publishes `cliStartup`; help and usage errors request exit without publishing that service. The runner waits for Loader settlement, creates or resumes one Agent, installs terminal commands and a user-question provider, projects its Session log, and owns ordered Agent, Session, and terminal teardown.

The package config defaults are:

| Field | Default | Effect |
|---|---:|---|
| `showReasoning` | `true` | Render reasoning blocks with terminal styling. |
| `maxToolOutputLines` | `12` | Retain at most this many rendered lines for one tool block. |
| `maxToolOutputBytes` | `32768` | Retain at most this many UTF-8 bytes for one tool block. |

The rolling renderer commits settled lines to ordinary scrollback and redraws only its bounded active region. The transcript projector consumes durable Session events, streams reasoning and text, and asks tool definitions for presentation intents instead of branching on tool names. The command adapter registers `/help`, `/clear`, and `/exit`; running submissions steer, idle submissions follow up, and the structured-question provider remains independent of approvals.

`appendCliSessionMarker()` writes `sandbox/mode`, `approval/policy`, then the required `cli/session` marker. `readCliSessionMarker()` requires exactly one supported marker and verifies that its sandbox mode and approval policy match the preceding policy events. The package invariant applies the same relation to loaded logs and new `session/event` candidates only after a marker exists, so Web and Headless Sessions plus a fresh CLI's policy events before its marker remain valid. Resume also requires the recorded workspace and selects the latest logged request model, falling back to the deployment default only for a blank Session.

The shipped patch sets `danger-full-access` and approval policy `never`, disables the permission selector, and mounts no approval UI. The terminal warning is part of the user-visible behavior. Loader or provider configuration fails before terminal acquisition; after acquisition, plugin disposal drains the Agent and Session before restoring the terminal.

## Model Experience

Indirectly, through the CLI persona, native tool presentation mode, and durable Session events that carry user messages, steering, structured answers, policy facts, assistant streams, and tool calls/results without a second model history.

#### KV Cache effect

The package adds no independent prompt section or tool schema. Cache changes come from the bundle's selected persona, native tool catalog, and durable conversation state assembled by their owning plugins.

## Known Limitations and Deferred Work

- The process requires TTY stdin and stdout.
- Resume is explicit, accepts only CLI Sessions from the same workspace, and has no cross-process lease; concurrent processes can race the same Session.
- The shipped CLI has no approval UI and no runtime permission selector. A higher profile or home patch can replace bundle policy, but the CLI runner currently records the shipped `danger-full-access` and `never` values for fresh Session identity.
