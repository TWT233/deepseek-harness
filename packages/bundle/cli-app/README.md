# `@deepseek-ai/dsh-cli-app`

English | [中文](README.zh.md)

Shared contracts and durable Session identity for the interactive terminal application. The package exports the rolling-terminal port, transcript projector declaration, transcript bounds, CLI Session marker, marker writer, and strict resume fold. The separate [`startup`](src/startup.ts) entry parses `dsh --profile cli [--resume <session-id>]` through the launcher-owned [`dsh-cmdline`](../../boot/cmdline/README.md) service and publishes `cliStartup`; help and usage errors request exit without publishing that service.

`appendCliSessionMarker()` writes `sandbox/mode`, `approval/policy`, then the required `cli/session` marker. `readCliSessionMarker()` requires exactly one supported marker and verifies that its sandbox mode and approval policy match the preceding policy events. The package invariant applies the same relation to loaded logs and new `session/event` candidates only after a marker exists, so Web and Headless Sessions plus a fresh CLI's policy events before its marker remain valid.

## Model Experience

Indirectly, through the Session policy events consumed by sandbox and approval plugins; this package registers no prompt or tool schema.

#### KV Cache effect

None directly; the policy consumers own any request-context change caused by the recorded mode and approval policy.

## Known Limitations and Deferred Work

- **Contracts only at this checkpoint** — the rolling terminal, transcript projector, command/question adapters, and runner are declared for parallel implementation but are not exposed as a root plugin yet.
