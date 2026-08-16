# Use the terminal CLI

English | [中文](cli.zh.md)

This guide starts an interactive coding Agent in the current directory, continues it across turns, and resumes it later. Use a terminal with TTY input and output, Node.js 22.19 or later, and a configured model credential.

## Start in your workspace

Change to the project the Agent may inspect and modify, then run:

```sh
npx @deepseek-ai/dsh
```

The CLI uses that directory as the Session workspace and prints the Session ID and a warning before the editor opens. The shipped `cli` profile runs with `danger-full-access` and approval policy `never`: commands and tools can modify any path available to the `dsh` process, and the CLI provides no approval prompt. Start it only in an environment where that access is acceptable.

Model-requested questions remain interactive. The lack of an approval UI does not suppress questions the Agent asks to complete the task.

## Submit a task

Type a request and press Enter:

> Summarize this repository and identify the next useful change.

The terminal keeps completed output in normal scrollback and redraws only the live assistant response, running tools, questions, status, and editor. Reasoning and answer text stream as they arrive. Tool rows use each tool's presentation intent for terminal output, diffs, reads, searches, Web results, or a generic fallback.

Press Alt+Enter to insert a line break before submitting a multiline request. Pasted multiline text is accepted directly.

## Steer active work

The editor stays available while the Agent runs. Submit another message to steer the active turn; submit while the Agent is idle to begin a follow-up turn.

When the Agent asks structured questions, enter an option number or custom text. For a multi-select question, use comma-separated option numbers and optionally append custom text after `;`.

## Use terminal commands

- `/help` lists the terminal commands available to this Agent.
- `/clear` clears the current terminal presentation without changing the Session or erasing existing terminal scrollback.
- `/exit` cancels active work if needed, flushes the Session, restores the terminal, and exits with status 0.

Ctrl+C cancels active Agent work and leaves the CLI open. Press Ctrl+C while idle to exit with status 130. Ctrl+D or end-of-file exits normally with status 0.

## Resume a Session

Copy the Session ID printed above the editor, return to the same workspace, and run:

```sh
dsh --resume <session-id>
```

Resume is explicit: bare `dsh` always creates a fresh Session. The CLI rejects non-CLI Sessions, unsupported or inconsistent markers, and a different current workspace before acquiring the terminal. A resumed Session uses the model in its latest request header; a blank Session uses the deployment's current default model.

## Choose another interface

Use the Web UI for a browser workflow:

```sh
dsh web
```

Use Headless mode for automation that should run one fresh task, print the final answer, and exit:

```sh
dsh --profile headless "summarize this repository"
```

See the [`dsh` behavior reference](../../../apps/cli/reference/README.md) for exact argument boundaries, configuration dumps, profile composition, resume validation, and shutdown semantics.
