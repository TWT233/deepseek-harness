/**
 * Interactive CLI Agent lifecycle and ordered teardown.
 * @module @deepseek-ai/dsh-cli-app/runner
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { dispatchCliInput, registerCliCommands } from './commands.ts'
import { displayText } from './display.ts'
import { CliQuestionProvider } from './questions.ts'
import {
  appendCliSessionMarker,
  readCliSessionMarker,
} from './session.ts'
import { CliTranscriptProjector } from './transcript.ts'
import type {
  CliStartupValues,
  CliTranscriptConfig,
  RollingTerminalInput,
  RollingTerminalPort,
} from './types.ts'

const FULL_ACCESS_WARNING = 'Warning: danger-full-access is active and approval is disabled. Commands and tools can modify any path available to this process.'

/** Factory boundary used to substitute a fake rolling terminal in tests. */
export type CliTerminalFactory = () => RollingTerminalPort

interface ResumePlan {
  readonly sessionId: SessionId
  readonly events: readonly SessionEvent[]
  readonly selection: ModelSelection
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function assertSameWorkspace(
  sessionId: SessionId,
  recorded: string | undefined,
  current: string,
): void {
  if (recorded === current) return
  const directory = recorded ?? current
  throw new Error(
    'resume this session from its recorded workspace: '
    + `cd ${shellQuote(directory)} && dsh --resume ${shellQuote(sessionId)}`,
  )
}

async function resumePlan(
  ctx: Context,
  id: SessionId,
): Promise<ResumePlan> {
  const inspected = await ctx.sessionPersistence.inspect(id)
  readCliSessionMarker(inspected.events)
  assertSameWorkspace(id, inspected.meta.cwd, process.cwd())
  const logged = inspected.events.findLast(
    event => event.type === 'request/header',
  )
  const selection = logged?.data.header.config
    ?? ctx.agentDefaultModel.currentSelection()
  return { sessionId: id, events: inspected.events, selection }
}

function agentOptions(selection: ModelSelection): AgentOptions {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort },
  }
}

function installSelection(
  selection: ModelSelection,
): (agentCtx: Context) => void {
  return (agentCtx) => {
    const selected: ModelSelectionRef = {
      current: selection,
      assembled: undefined,
    }
    installModelSelection(agentCtx, selected)
  }
}

function startupItem(
  terminal: RollingTerminalPort,
  sessionId: SessionId,
  order: number,
): void {
  terminal.upsert({
    id: 'cli:startup',
    order,
    settled: true,
    lines: [
      displayText(`Session ID: ${sessionId}`),
      displayText(FULL_ACCESS_WARNING),
    ],
  })
}

function inputHandler(
  ctx: Context,
  agent: Agent,
  terminal: RollingTerminalPort,
  questions: CliQuestionProvider,
  controller: AbortController,
  requestExit: (code: number) => void,
): (input: RollingTerminalInput) => void {
  return (input) => {
    if (questions.accept(input)) {
      if (input.kind === 'eof') requestExit(0)
      return
    }
    if (input.kind === 'submit') {
      void dispatchCliInput(ctx, agent, terminal, input.text, controller.signal)
        .catch((error: unknown) => {
          terminal.upsert({
            id: `input-error:${agent.session.seq}`,
            order: agent.session.seq,
            settled: true,
            lines: [
              displayText(error instanceof Error ? error.message : String(error)),
            ],
          })
        })
      return
    }
    if (input.kind === 'interrupt' && agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      return
    }
    requestExit(input.kind === 'interrupt' ? 130 : 0)
  }
}

async function disposeOwned(
  ctx: Context,
  handle: AgentHandle | undefined,
  terminal: RollingTerminalPort,
  questions: CliQuestionProvider | undefined,
  commandScope: ReturnType<Context['inject']> | undefined,
  unregisterQuestions: (() => void) | undefined,
  controller: AbortController,
): Promise<void> {
  controller.abort(new Error('interactive CLI stopped'))
  const failures: unknown[] = []
  const stage = async (operation: () => unknown): Promise<void> => {
    try {
      await operation()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  await stage(() => questions?.dispose())
  await stage(() => unregisterQuestions?.())
  await stage(() => commandScope?.dispose())
  await stage(() => handle?.agent.cancel({ kind: 'user' }))
  await stage(() => handle?.agent.whenIdle())
  await stage(() => handle === undefined
    ? undefined
    : ctx.sessions.flush(handle.agent.session))
  await stage(() => handle?.dispose())
  await stage(() => terminal.stop())
  if (failures.length > 0) {
    throw new AggregateError(failures, 'interactive CLI teardown failed')
  }
}

function waitForShutdown(
  exit: Promise<number>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return exit.then(() => undefined)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void exit.then(done)
  })
}

/**
 * Compose one interactive Agent and run it until the launcher requests exit.
 * @param ctx - application context carrying Agent, persistence, command, question, and launcher services.
 * @param config - transcript visibility and output bounds.
 * @param startup - fresh or resumed Session selection.
 * @param terminalFactory - factory called only after resume preflight succeeds.
 * @param shutdownSignal - plugin-owned request to stop and drain without requesting process exit.
 */
export async function runCli(
  ctx: Context,
  config: CliTranscriptConfig,
  startup: CliStartupValues,
  terminalFactory: CliTerminalFactory,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  await ctx.get('loader')?.await()
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('cli-runner: the launcher must provide ctx.appExit before the runner starts')
  }
  const plan = startup.resumeSessionId === undefined
    ? undefined
    : await resumePlan(ctx, startup.resumeSessionId)
  const selection = plan?.selection ?? ctx.agentDefaultModel.currentSelection()
  const terminal = terminalFactory()
  let handle: AgentHandle | undefined
  let commandScope: ReturnType<Context['inject']> | undefined
  let questions: CliQuestionProvider | undefined
  let unregisterQuestions: (() => void) | undefined
  const controller = new AbortController()
  const exit = Promise.withResolvers<number>()
  let exitRequested = false
  const requestExit = (code: number): void => {
    if (exitRequested) return
    exitRequested = true
    appExit(code)
    exit.resolve(code)
  }

  try {
    handle = plan === undefined
      ? await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: agentOptions(selection),
        setup: installSelection(selection),
      })
      : await ctx.agents.resume({
        resumeSessionId: plan.sessionId,
        agentOptions: agentOptions(selection),
        setup: installSelection(selection),
      })
    const agent = handle.agent
    questions = new CliQuestionProvider(agent, terminal)
    commandScope = registerCliCommands(agent, terminal, requestExit)
    await commandScope
    unregisterQuestions = ctx.userQuestions.registerProvider({
      ask(request: AskUserQuestionRequest) {
        return (questions as CliQuestionProvider).ask(request)
      },
    })
    const projector = new CliTranscriptProjector(ctx, agent, terminal, config)
    agent.ctx.on('session/event', (session, event) => {
      if (session === agent.session) projector.accept(event)
    })
    if (plan === undefined) {
      appendCliSessionMarker(agent.session, {
        version: 1,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      })
    }
    projector.replay(agent.session.events)
    startupItem(terminal, agent.session.id, agent.session.seq)
    terminal.start(inputHandler(
      ctx,
      agent,
      terminal,
      questions,
      controller,
      requestExit,
    ))
    await waitForShutdown(exit.promise, shutdownSignal)
  } finally {
    await disposeOwned(
      ctx,
      handle,
      terminal,
      questions,
      commandScope,
      unregisterQuestions,
      controller,
    )
  }
}
