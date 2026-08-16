import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Config,
  apply,
  internals,
  name,
} from '../src/index.ts'
import {
  runCli,
  type CliTerminalFactory,
} from '../src/runner.ts'
import type {
  CliStartupValues,
  RollingTerminalInput,
  RollingTerminalItem,
  RollingTerminalPort,
} from '../src/types.ts'

const marker = {
  version: 1,
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
} as const

function event(
  type: string,
  seq: number,
  data: unknown,
): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function cliEvents(overrides: Partial<typeof marker> = {}): SessionEvent[] {
  const selected = { ...marker, ...overrides }
  return [
    event('sandbox/mode', 0, { mode: marker.sandboxMode }),
    event('approval/policy', 1, { policy: marker.approvalPolicy }),
    event('cli/session', 2, selected),
  ]
}

function header(id: SessionId, cwd = process.cwd()): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd,
  }
}

class FakeTerminal implements RollingTerminalPort {
  readonly calls: string[]
  readonly items: RollingTerminalItem[] = []
  starts = 0
  stops = 0
  startError: Error | undefined
  input: ((input: RollingTerminalInput) => void) | undefined

  constructor(calls: string[] = []) {
    this.calls = calls
  }

  start(onInput: (input: RollingTerminalInput) => void): void {
    this.calls.push('terminal.start')
    this.starts++
    this.input = onInput
    if (this.startError !== undefined) throw this.startError
  }
  upsert(item: RollingTerminalItem): void {
    this.items.push(item)
  }
  remove(_id: string): void {}
  setQuestion(_lines: readonly string[] | undefined): void {}
  setStatus(_line: string | undefined): void {}
  setInputEnabled(_enabled: boolean): void {}
  clear(): void {}
  async stop(): Promise<void> {
    this.calls.push('terminal.stop')
    this.stops++
  }
  send(input: RollingTerminalInput): void {
    this.input?.(input)
  }
}

interface Harness {
  readonly ctx: Context
  readonly terminal: FakeTerminal
  readonly calls: string[]
  readonly createOptions: CreateAgentOptions[]
  readonly resumeOptions: ResumeAgentOptions[]
  readonly exitCodes: number[]
  readonly followup: ReturnType<typeof vi.fn>
  readonly steer: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly defaultSelection: {
    provider: string
    model: string
    reasoningEffort: ReasoningEffortId
  }
  inspection?: { meta: SessionHeader; events: readonly SessionEvent[] }
  flushError?: Error
  agent?: Agent
  handle?: AgentHandle
  terminalFactory: CliTerminalFactory
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestionService)
  const calls: string[] = []
  const terminal = new FakeTerminal(calls)
  const createOptions: CreateAgentOptions[] = []
  const resumeOptions: ResumeAgentOptions[] = []
  const exitCodes: number[] = []
  const followup = vi.fn()
  const steer = vi.fn()
  const cancel = vi.fn(() => {
    calls.push('agent.cancel')
  })
  const defaultSelection = {
    provider: 'default-provider',
    model: 'default-model',
    reasoningEffort: ReasoningEffortId('high'),
  }
  const test = {
    ctx,
    terminal,
    calls,
    createOptions,
    resumeOptions,
    exitCodes,
    followup,
    steer,
    cancel,
    defaultSelection,
    terminalFactory: () => terminal,
  } as Harness

  ctx.provide('loader', {
    await: async () => {
      calls.push('loader.await')
    },
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => {
      calls.push('defaultModel')
      return defaultSelection
    },
  } as never)
  ctx.provide('tools', { get: () => undefined } as never)
  ctx.provide('sessions', {
    flush: async () => {
      calls.push('sessions.flush')
      if (test.flushError !== undefined) throw test.flushError
      return true
    },
  } as never)
  ctx.provide('sessionPersistence', {
    inspect: async (id: SessionId) => {
      calls.push(`inspect:${id}`)
      if (test.inspection === undefined) throw new Error('missing inspection fixture')
      return test.inspection
    },
  } as never)
  ctx.provide('appExit', (code) => {
    calls.push(`appExit:${String(code)}`)
    exitCodes.push(code)
  })

  async function makeAgent(
    id: SessionId,
    events: readonly SessionEvent[],
    sessionHeader: SessionHeader,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> {
    const session = Session.create(id, events, sessionHeader)
    const agent = {
      id,
      session,
      options: {},
      status: 'idle',
      ctx: undefined,
      followup,
      steer,
      cancel,
      whenIdle: vi.fn(async () => {
        calls.push('agent.whenIdle')
      }),
    } as unknown as Agent
    const agentCtx = ctx.extend({ agent })
    Object.assign(agent, { ctx: agentCtx })
    await setup?.(agentCtx)
    const handle: AgentHandle = {
      agent,
      dispose: async () => {
        calls.push('handle.dispose')
      },
    }
    test.agent = agent
    test.handle = handle
    return handle
  }

  ctx.provide('agents', {
    get: (id: SessionId) => test.agent?.id === id ? test.agent : undefined,
    roots: () => test.agent === undefined ? [] : [test.agent],
    create: async (options: CreateAgentOptions) => {
      calls.push('agents.create')
      createOptions.push(options)
      return makeAgent(
        options.sessionId,
        options.seed ?? [],
        header(options.sessionId, options.meta?.cwd),
        options.setup,
      )
    },
    resume: async (options: ResumeAgentOptions) => {
      calls.push('agents.resume')
      resumeOptions.push(options)
      const inspected = test.inspection
      if (inspected === undefined) throw new Error('missing inspection fixture')
      return makeAgent(
        options.resumeSessionId,
        inspected.events,
        inspected.meta,
        options.setup,
      )
    },
  } as never)

  return test
}

const config: Config = {
  maxToolOutputLines: 12,
  maxToolOutputBytes: 32_768,
  showReasoning: true,
}
const productionTerminalFactory = internals.terminalFactory

async function started(
  test: Harness,
  startup: CliStartupValues = {},
): Promise<{ running: Promise<void> }> {
  const running = runCli(test.ctx, config, startup, test.terminalFactory)
  await vi.waitFor(() => {
    expect(test.terminal.starts).toBe(1)
  })
  return { running }
}

describe('interactive CLI runner', () => {
  it('fails loud when called without the launcher exit request', async () => {
    await expect(runCli(
      new Context(),
      config,
      {},
      () => new FakeTerminal(),
    )).rejects.toThrow('must provide ctx.appExit')
  })

  it('creates a fresh Agent with the deployment model and durable CLI policies', async () => {
    const test = await harness()
    const { running } = await started(test)

    expect(test.createOptions).toHaveLength(1)
    expect(test.createOptions[0]).toMatchObject({
      meta: { cwd: process.cwd() },
      agentOptions: test.defaultSelection,
    })
    expect(test.agent?.session.events.filter(entry => (
      entry.type === 'sandbox/mode'
      || entry.type === 'approval/policy'
      || entry.type === 'cli/session'
    )).map(entry => [
      entry.type,
      entry.data,
    ])).toEqual([
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
      ['cli/session', marker],
    ])
    expect(test.calls.slice(0, 4)).toEqual([
      'loader.await',
      'defaultModel',
      'agents.create',
      'terminal.start',
    ])
    expect(test.terminal.items.some(item => item.lines.some(line =>
      line.includes('danger-full-access')))).toBe(true)

    test.terminal.send({ kind: 'eof' })
    await running
    expect(test.exitCodes).toEqual([0])
  })

  it('preflights resume before terminal start and uses the latest logged model', async () => {
    const test = await harness()
    const id = SessionId('resume-model')
    test.inspection = {
      meta: header(id),
      events: [
        ...cliEvents(),
        event('request/header', 3, {
          header: {
            config: {
              provider: 'old-provider',
              model: 'old-model',
            },
          },
          reason: 'initial',
        }),
        event('request/header', 4, {
          header: {
            config: {
              provider: 'logged-provider',
              model: 'logged-model',
              reasoningEffort: ReasoningEffortId('medium'),
            },
          },
          reason: 'change',
        }),
      ],
    }

    const { running } = await started(test, { resumeSessionId: id })

    expect(test.calls.indexOf(`inspect:${id}`)).toBeLessThan(
      test.calls.indexOf('terminal.start'),
    )
    expect(test.resumeOptions[0]).toMatchObject({
      resumeSessionId: id,
      agentOptions: {
        provider: 'logged-provider',
        model: 'logged-model',
        reasoningEffort: 'medium',
      },
    })
    expect(test.calls).not.toContain('defaultModel')
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('uses the deployment default when a resumed CLI Session has no request header', async () => {
    const test = await harness()
    const id = SessionId('resume-blank')
    test.inspection = { meta: header(id), events: cliEvents() }

    const { running } = await started(test, { resumeSessionId: id })

    expect(test.resumeOptions[0]?.agentOptions).toEqual(test.defaultSelection)
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('omits reasoning effort when the logged model selection omits it', async () => {
    const test = await harness()
    const id = SessionId('resume-without-effort')
    test.inspection = {
      meta: header(id),
      events: [
        ...cliEvents(),
        event('request/header', 3, {
          header: {
            config: {
              provider: 'logged-provider',
              model: 'logged-model',
            },
          },
          reason: 'initial',
        }),
      ],
    }

    const { running } = await started(test, { resumeSessionId: id })

    expect(test.resumeOptions[0]?.agentOptions).toEqual({
      provider: 'logged-provider',
      model: 'logged-model',
    })
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it.each([
    ['missing marker', []],
    ['duplicate marker', [...cliEvents(), event('cli/session', 3, marker)]],
    ['unsupported version', cliEvents({ version: 2 as never })],
    ['inconsistent policy', [
      event('sandbox/mode', 0, { mode: 'danger-full-access' }),
      event('approval/policy', 1, { policy: 'ask' }),
      event('cli/session', 2, marker),
    ]],
  ])('rejects %s before raw terminal mode', async (_label, events) => {
    const test = await harness()
    const id = SessionId('resume-invalid')
    test.inspection = { meta: header(id), events }

    await expect(runCli(test.ctx, config, { resumeSessionId: id }, test.terminalFactory))
      .rejects.toThrow()
    expect(test.terminal.starts).toBe(0)
    expect(test.resumeOptions).toEqual([])
  })

  it('rejects a workspace mismatch with the exact quoted recovery command', async () => {
    const test = await harness()
    const id = SessionId("resume'id")
    test.inspection = {
      meta: header(id, "/saved work'space"),
      events: cliEvents(),
    }

    await expect(runCli(test.ctx, config, { resumeSessionId: id }, test.terminalFactory))
      .rejects.toThrow(
        "resume this session from its recorded workspace: cd '/saved work'\\''space' && dsh --resume 'resume'\\''id'",
      )
    expect(test.terminal.starts).toBe(0)
  })

  it('uses the current workspace in recovery when persisted metadata lacks cwd', async () => {
    const test = await harness()
    const id = SessionId('resume-without-cwd')
    test.inspection = {
      meta: {
        version: SESSION_FORMAT_VERSION,
        id,
        createdAt: 1,
      },
      events: cliEvents(),
    }

    await expect(runCli(test.ctx, config, { resumeSessionId: id }, test.terminalFactory))
      .rejects.toThrow(
        `resume this session from its recorded workspace: cd '${process.cwd()}' && dsh --resume 'resume-without-cwd'`,
      )
    expect(test.terminal.starts).toBe(0)
  })

  it('routes idle submit to followup and running submit to steer', async () => {
    const test = await harness()
    const { running } = await started(test)
    const agent = test.agent as Agent

    test.terminal.send({ kind: 'submit', text: 'first' })
    expect(test.followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'first' }],
    }) satisfies Partial<UserMessage>)

    Object.assign(agent, { status: 'running' })
    test.terminal.send({ kind: 'submit', text: 'second' })
    expect(test.steer).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'second' }],
    }) satisfies Partial<UserMessage>)

    Object.assign(agent, { status: 'idle' })
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('lets an active question consume terminal input before Agent dispatch', async () => {
    const test = await harness()
    const { running } = await started(test)
    const question = test.ctx.userQuestions.ask({
      agent: test.agent as Agent,
      questions: [{
        id: 'confirm',
        question: 'Proceed?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      }],
    })

    test.terminal.send({ kind: 'submit', text: '1' })

    await expect(question).resolves.toEqual({
      answers: [{ id: 'confirm', selected: ['Yes'] }],
    })
    expect(test.followup).not.toHaveBeenCalled()
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('projects only live events from the owned Session', async () => {
    const test = await harness()
    const { running } = await started(test)
    const agent = test.agent as Agent
    const live = event('turn/end', agent.session.seq, {
      turn: 1,
      reason: { kind: 'max-tokens' },
    })
    const other = Session.create(SessionId('other-session'))

    agent.ctx.emit('session/event', other, live)
    expect(test.terminal.items.some(item => item.id === `notice:${String(live.seq)}`))
      .toBe(false)
    agent.ctx.emit('session/event', agent.session, live)
    expect(test.terminal.items).toContainEqual({
      id: `notice:${String(live.seq)}`,
      order: live.seq,
      settled: true,
      lines: ['Turn stopped: maximum output tokens reached'],
    })

    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('maps interrupt, EOF, and /exit to the required cancel and exit behavior', async () => {
    const runningTest = await harness()
    const { running } = await started(runningTest)
    Object.assign(runningTest.agent as Agent, { status: 'running' })
    runningTest.terminal.send({ kind: 'interrupt' })
    expect(runningTest.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
    Object.assign(runningTest.agent as Agent, { status: 'idle' })
    runningTest.terminal.send({ kind: 'eof' })
    await running
    expect(runningTest.exitCodes).toEqual([0])

    const idleInterrupt = await harness()
    const { running: interrupted } = await started(idleInterrupt)
    idleInterrupt.terminal.send({ kind: 'interrupt' })
    await interrupted
    expect(idleInterrupt.exitCodes).toEqual([130])

    const commandExit = await harness()
    const { running: command } = await started(commandExit)
    await Promise.all([
      commandExit.ctx.commands.execute(
        commandExit.agent as Agent,
        '/exit',
        new AbortController().signal,
      ),
      commandExit.ctx.commands.execute(
        commandExit.agent as Agent,
        '/exit',
        new AbortController().signal,
      ),
    ])
    await command
    expect(commandExit.exitCodes).toEqual([0])
  })

  it('renders rejected command dispatches as escaped terminal errors', async () => {
    const test = await harness()
    const { running } = await started(test)
    test.ctx.commands.register({
      name: 'explode',
      description: 'Reject with an arbitrary value',
      handler: () => {
        throw 'bad\u001b'
      },
    })

    test.terminal.send({ kind: 'submit', text: '/explode' })
    await vi.waitFor(() => {
      expect(test.terminal.items.at(-1)?.lines).toEqual(['bad\\x1B'])
    })
    test.ctx.commands.register({
      name: 'error',
      description: 'Reject with an Error',
      handler: () => {
        throw new Error('ordinary failure')
      },
    })
    test.terminal.send({ kind: 'submit', text: '/error' })
    await vi.waitFor(() => {
      expect(test.terminal.items.at(-1)?.lines).toEqual(['ordinary failure'])
    })
    test.terminal.send({ kind: 'eof' })
    await running
  })

  it('aborts questions and commands before draining and stopping owned resources', async () => {
    const test = await harness()
    const { running } = await started(test)
    const question = test.ctx.userQuestions.ask({
      agent: test.agent as Agent,
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })

    await test.ctx.commands.execute(
      test.agent as Agent,
      '/exit',
      new AbortController().signal,
    )
    await expect(question).rejects.toThrow('CLI question provider disposed')
    await running

    expect(test.calls.slice(-6)).toEqual([
      'appExit:0',
      'agent.cancel',
      'agent.whenIdle',
      'sessions.flush',
      'handle.dispose',
      'terminal.stop',
    ])
  })

  it('stops a started terminal when later startup work fails', async () => {
    const test = await harness()
    test.terminal.startError = new Error('terminal failed after raw mode')

    await expect(runCli(test.ctx, config, {}, test.terminalFactory))
      .rejects.toThrow('terminal failed after raw mode')
    expect(test.terminal.stops).toBe(1)
  })

  it('disposes the handle and stops the terminal when flushing fails', async () => {
    const test = await harness()
    test.flushError = new Error('flush failed')
    const { running } = await started(test)

    test.terminal.send({ kind: 'eof' })

    await expect(running).rejects.toThrow('flush failed')
    expect(test.calls.slice(-4)).toEqual([
      'agent.whenIdle',
      'sessions.flush',
      'handle.dispose',
      'terminal.stop',
    ])
  })

  it('stops the terminal when Agent creation fails before ownership completes', async () => {
    const test = await harness()
    const failing = test.ctx.isolate('agents')
    failing.provide('agents', {
      create: async () => {
        throw new Error('agent creation failed')
      },
    } as never)

    await expect(runCli(failing, config, {}, test.terminalFactory))
      .rejects.toThrow('agent creation failed')
    expect(test.terminal.stops).toBe(1)
  })

  it('disposes an owned Agent when question-provider registration fails', async () => {
    const test = await harness()
    const unregister = test.ctx.userQuestions.registerProvider({
      ask: async () => ({ answers: [] }),
    })

    await expect(runCli(test.ctx, config, {}, test.terminalFactory))
      .rejects.toThrow('a user-questions provider is already registered')
    expect(test.calls.slice(-5)).toEqual([
      'agent.cancel',
      'agent.whenIdle',
      'sessions.flush',
      'handle.dispose',
      'terminal.stop',
    ])
    unregister()
  })
})

describe('interactive CLI plugin', () => {
  beforeEach(() => {
    internals.terminalFactory = () => new FakeTerminal()
  })

  it('exports the loader-safe root plugin and validates transcript config defaults', () => {
    expect(name).toBe('cli-runner')
    expect(new Config({} as never)).toEqual(config)
    expect(() => new Config({ maxToolOutputLines: -1 } as never)).toThrow()
    expect(() => new Config({ maxToolOutputBytes: 1.5 } as never)).toThrow()
  })

  it('fails loud without launcher-owned appExit', () => {
    expect(() => {
      apply(new Context(), config)
    }).toThrow('must provide ctx.appExit')
  })

  it('fails loud without startup selection', () => {
    const ctx = new Context()
    ctx.provide('appExit', () => {})
    expect(() => {
      apply(ctx, config)
    }).toThrow('cliStartup must be provided')
  })

  it('rejects non-TTY production streams before raw mode', () => {
    expect(() => productionTerminalFactory()).toThrow(
      'requires TTY stdin and stdout',
    )
  })

  it('constructs the process terminal only when both streams are TTYs', () => {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    try {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: true,
      })
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: false,
      })
      expect(() => productionTerminalFactory()).toThrow(
        'requires TTY stdin and stdout',
      )
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      })
      const terminal = productionTerminalFactory()
      expect(typeof terminal.start).toBe('function')
      expect(typeof terminal.stop).toBe('function')
    } finally {
      if (stdin === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdin, 'isTTY', stdin)
      if (stdout === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdout, 'isTTY', stdout)
    }
  })

  it('maps asynchronous runner failures to launcher exit 1', async () => {
    const ctx = new Context()
    const exits: number[] = []
    const errors: unknown[] = []
    ctx.logger.error = (error: unknown) => {
      errors.push(error)
      return ctx.logger
    }
    ctx.provide('appExit', (code) => {
      exits.push(code)
    })
    ctx.provide('cliStartup', {})
    ctx.provide('loader', { await: () => Promise.reject(new Error('loader failed')) } as never)
    internals.terminalFactory = () => new FakeTerminal()

    apply(ctx, config)
    await vi.waitFor(() => {
      expect(exits).toEqual([1])
    })
    expect(errors).toEqual([expect.objectContaining({ message: 'loader failed' })])
  })
})
