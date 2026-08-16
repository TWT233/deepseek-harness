import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as CliInvariant from '../src/invariant.ts'

const marker = {
  version: 1,
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
} as const

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function sandboxEvent(mode: unknown, seq = 0): SessionEvent {
  return event('sandbox/mode', { mode }, seq)
}

function approvalEvent(policy: unknown, seq = 1): SessionEvent {
  return event('approval/policy', { policy }, seq)
}

function cliEvent(value: unknown, seq = 2): SessionEvent {
  return event('cli/session', value, seq)
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(CliInvariant)
  return ctx
}

function emit(ctx: Context, session: Session, candidate: SessionEvent): void {
  ctx.emit('session/event', session, candidate)
}

describe('CLI Session invariant', () => {
  it('ignores non-CLI Sessions and in-progress CLI initialization', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('unmarked'))

    expect(() => { emit(ctx, session, sandboxEvent('danger-full-access')) }).not.toThrow()
    expect(() => { emit(ctx, session, approvalEvent('never')) }).not.toThrow()
    expect(() => { emit(ctx, session, event('turn/start', { turn: 1 }, 2)) }).not.toThrow()
  })

  it.each([
    {
      name: 'duplicate marker',
      existing: [
        sandboxEvent('danger-full-access'),
        approvalEvent('never'),
        cliEvent(marker),
      ],
      candidate: cliEvent(marker, 3),
    },
    {
      name: 'unsupported marker version',
      existing: [
        sandboxEvent('danger-full-access'),
        approvalEvent('never'),
      ],
      candidate: cliEvent({ ...marker, version: 2 }),
    },
    {
      name: 'matching sandbox mode outside the closed vocabulary',
      existing: [
        sandboxEvent('unrestricted'),
        approvalEvent('never'),
      ],
      candidate: cliEvent({ ...marker, sandboxMode: 'unrestricted' }),
    },
    {
      name: 'matching approval policy outside the closed vocabulary',
      existing: [
        sandboxEvent('danger-full-access'),
        approvalEvent('always'),
      ],
      candidate: cliEvent({ ...marker, approvalPolicy: 'always' }),
    },
    {
      name: 'inconsistent sandbox mode',
      existing: [
        sandboxEvent('workspace-write'),
        approvalEvent('never'),
      ],
      candidate: cliEvent(marker),
    },
    {
      name: 'inconsistent approval policy',
      existing: [
        sandboxEvent('danger-full-access'),
        approvalEvent('ask'),
      ],
      candidate: cliEvent(marker),
    },
  ])('rejects $name through session/event dispatch', async ({ existing, candidate }) => {
    const ctx = await setup()
    const session = Session.create(SessionId(`invalid-${candidate.seq}`), existing)

    expect(() => { emit(ctx, session, candidate) }).toThrow(InvariantError)
  })

  it('rejects an invalid marked Session loaded before registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('loaded-invalid-cli'), {
      seed: [
        sandboxEvent('workspace-write'),
        approvalEvent('never'),
        cliEvent(marker),
      ],
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(CliInvariant).then(() => undefined)).rejects.toThrow(InvariantError)
  })

  it('rejects an invalid marked Session created after registration', async () => {
    const ctx = await setup()

    expect(() => ctx.sessions.create(SessionId('created-invalid-cli'), {
      seed: [
        sandboxEvent('workspace-write'),
        approvalEvent('never'),
        cliEvent(marker),
      ],
    })).toThrow(InvariantError)
    expect(ctx.sessions.get(SessionId('created-invalid-cli'))).toBeUndefined()
  })

  it('removes validation when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(CliInvariant)
    const session = Session.create(SessionId('disposed-cli-invariant'), [
      sandboxEvent('workspace-write'),
      approvalEvent('never'),
    ])

    expect(() => { emit(ctx, session, cliEvent(marker)) }).toThrow(InvariantError)
    await fiber.dispose()
    expect(() => { emit(ctx, session, cliEvent(marker)) }).not.toThrow()
  })
})
