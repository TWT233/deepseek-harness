import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchCliInput,
  registerCliCommands,
} from '../src/commands.ts'
import type {
  RollingTerminalInput,
  RollingTerminalItem,
  RollingTerminalPort,
} from '../src/types.ts'

class FakeTerminal implements RollingTerminalPort {
  readonly items: RollingTerminalItem[] = []
  clearCount = 0

  start(_onInput: (input: RollingTerminalInput) => void): void {}
  upsert(item: RollingTerminalItem): void {
    this.items.push(item)
  }
  remove(_id: string): void {}
  setQuestion(_lines: readonly string[] | undefined): void {}
  setStatus(_line: string | undefined): void {}
  setInputEnabled(_enabled: boolean): void {}
  clear(): void {
    this.clearCount++
  }
  async stop(): Promise<void> {}
}

describe('CLI commands', () => {
  let ctx: Context
  let agent: Agent
  let terminal: FakeTerminal
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>
  let followup: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const session = Session.create(SessionId('cli-command-test'))
    const agentCtx = ctx.extend({ agent: undefined })
    followup = vi.fn()
    agent = {
      id: session.id,
      session,
      status: 'idle',
      ctx: agentCtx,
      followup,
    } as unknown as Agent
    Object.assign(agentCtx, { agent })
    terminal = new FakeTerminal()
    exit = vi.fn<(code: number) => void>()
    registerCliCommands(agent, terminal, exit)
  })

  it('lists built-ins and effective scoped commands in /help', async () => {
    agent.ctx.commands.register({
      name: 'scoped',
      description: 'Run the scoped command',
      handler: () => ({ kind: 'success' }),
    })

    await dispatchCliInput(ctx, agent, terminal, '/help', new AbortController().signal)

    expect(terminal.items.at(-1)?.lines).toEqual([
      '/clear — Clear terminal output',
      '/exit — Exit the interactive session',
      '/help — List available commands',
      '/scoped — Run the scoped command',
    ])
  })

  it('clears only terminal presentation for /clear', async () => {
    await dispatchCliInput(ctx, agent, terminal, '/clear', new AbortController().signal)

    expect(terminal.clearCount).toBe(1)
    expect(exit).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    expect(terminal.items).toEqual([])
  })

  it('requests graceful shutdown for /exit', async () => {
    await dispatchCliInput(ctx, agent, terminal, '/exit', new AbortController().signal)

    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(followup).not.toHaveBeenCalled()
  })

  it('renders unknown slash input as a terminal error without following up', async () => {
    await dispatchCliInput(ctx, agent, terminal, '/missing value', new AbortController().signal)

    expect(terminal.items.at(-1)?.lines).toEqual([
      'Unknown command: /missing. Run /help for available commands.',
    ])
    expect(followup).not.toHaveBeenCalled()
  })
})
