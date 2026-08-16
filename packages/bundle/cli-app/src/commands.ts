/**
 * Interactive CLI command registration and input dispatch.
 * @module @deepseek-ai/dsh-cli-app/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { displayText } from './display.ts'
import type { RollingTerminalPort } from './types.ts'

/** Request application shutdown after the runner-owned lifecycle drains. */
export type CliExitRequest = (code: number) => void

function show(
  terminal: RollingTerminalPort,
  id: string,
  order: number,
  text: string,
): void {
  terminal.upsert({
    id,
    order,
    settled: true,
    lines: displayText(text).split('\n'),
  })
}

/**
 * Register the CLI's built-in commands in one Agent's scoped command layer.
 * @param agent - exact Agent whose effective registry receives the commands.
 * @param terminal - terminal presentation controlled by the built-ins.
 * @param requestExit - launcher-owned graceful exit request.
 * @returns the injection fiber that owns all registrations.
 */
export function registerCliCommands(
  agent: Agent,
  terminal: RollingTerminalPort,
  requestExit: CliExitRequest,
): ReturnType<Context['inject']> {
  return agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(function* () {
      yield commandCtx.commands.register({
        name: 'help',
        description: 'List available commands',
        handler: ({ agent: target }) => ({
          kind: 'success',
          text: commandCtx.commands.list(target)
            .map(command => `/${command.name} — ${command.description}`)
            .join('\n'),
        }),
      })
      yield commandCtx.commands.register({
        name: 'clear',
        description: 'Clear terminal output',
        handler: () => {
          terminal.clear()
          return { kind: 'success' }
        },
      })
      yield commandCtx.commands.register({
        name: 'exit',
        description: 'Exit the interactive session',
        handler: () => {
          requestExit(0)
          return { kind: 'success' }
        },
      })
    }, 'interactive CLI commands')
  })
}

/**
 * Dispatch one submitted editor value to a command or Agent inbox.
 * @param ctx - root context carrying the command registry.
 * @param agent - exact live CLI Agent.
 * @param terminal - terminal receiving direct command outcomes.
 * @param text - submitted editor text.
 * @param signal - runner-owned command cancellation.
 */
export async function dispatchCliInput(
  ctx: Context,
  agent: Agent,
  terminal: RollingTerminalPort,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const parsed = parseCommand(text)
  if (parsed !== undefined) {
    const execution = await ctx.commands.execute(agent, text, signal)
    if (execution === undefined) {
      show(
        terminal,
        `command-error:${agent.session.seq}`,
        agent.session.seq,
        `Unknown command: /${parsed.name}. Run /help for available commands.`,
      )
      return
    }
    if (execution.result.text !== undefined
      && (execution.result.kind === 'error'
        || execution.result.sourceEventSeq === undefined)) {
      show(
        terminal,
        `command:${execution.commandId}`,
        agent.session.seq,
        execution.result.text,
      )
    }
    return
  }

  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  if (agent.status === 'running') agent.steer(message)
  else agent.followup(message)
}
