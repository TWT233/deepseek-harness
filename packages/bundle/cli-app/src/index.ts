/**
 * Interactive rolling-terminal Agent application.
 * @module @deepseek-ai/dsh-cli-app
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createRollingTerminal, ProcessTerminalDevice } from './terminal.ts'
import { runCli, type CliTerminalFactory } from './runner.ts'
import { CLI_STARTUP_SERVICE, type CliStartupValues } from './startup.ts'

export * from './types.ts'
export * from './session.ts'
export { runCli } from './runner.ts'

/** Stable Cordis plugin name. */
export const name = 'cli-runner'

/** Services required before the interactive runner can start. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'commands',
  'sessionPersistence',
  'sessions',
  'tools',
  'userQuestions',
  CLI_STARTUP_SERVICE,
]

/** Transcript visibility and output bounds. */
export interface Config {
  /** Maximum terminal lines retained for one tool result. */
  maxToolOutputLines: number
  /** Maximum UTF-8 bytes retained for one tool result. */
  maxToolOutputBytes: number
  /** Whether model reasoning blocks are rendered. */
  showReasoning: boolean
}

export const Config: z<Config> = z.object({
  maxToolOutputLines: z.natural().default(12),
  maxToolOutputBytes: z.natural().default(32_768),
  showReasoning: z.boolean().default(true),
})

function processTerminalFactory(): ReturnType<CliTerminalFactory> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive CLI requires TTY stdin and stdout')
  }
  return createRollingTerminal(new ProcessTerminalDevice(), {})
}

/** Process-owned terminal substitution point used by focused tests. */
export const internals: { terminalFactory: CliTerminalFactory } = {
  terminalFactory: processTerminalFactory,
}

/**
 * Mount the interactive runner.
 * @param ctx - plugin context carrying the launcher exit request and runtime services.
 * @param config - validated transcript config.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('cli-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const startup = ctx.get(CLI_STARTUP_SERVICE) as CliStartupValues | undefined
  if (startup === undefined) {
    throw new Error('cli-runner: cliStartup must be provided before the tree mounts')
  }
  void runCli(ctx, config, startup, internals.terminalFactory)
    .catch((error: unknown) => {
      ctx.logger.error(error)
      exit(1)
    })
}
