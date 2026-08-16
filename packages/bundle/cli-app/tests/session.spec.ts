import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  appendCliSessionMarker,
  readCliSessionMarker,
} from '../src/session.ts'

const marker = {
  version: 1,
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
} as const

function sandboxEvent(mode: unknown, seq = 0): SessionEvent {
  return {
    type: 'sandbox/mode',
    seq,
    time: seq,
    data: { mode },
  } as SessionEvent
}

function approvalEvent(policy: unknown, seq = 1): SessionEvent {
  return {
    type: 'approval/policy',
    seq,
    time: seq,
    data: { policy },
  } as SessionEvent
}

function cliEvent(value: unknown, seq = 2): SessionEvent {
  return {
    type: 'cli/session',
    seq,
    time: seq,
    data: value,
  } as SessionEvent
}

describe('CLI Session marker', () => {
  it('reads the marker after matching policy events', () => {
    expect(readCliSessionMarker([
      sandboxEvent('danger-full-access'),
      approvalEvent('never'),
      cliEvent(marker),
    ])).toEqual(marker)
  })

  it('rejects a log without a marker', () => {
    expect(() => readCliSessionMarker([])).toThrow(/not a CLI session/)
  })

  it('rejects multiple markers', () => {
    expect(() => readCliSessionMarker([
      cliEvent(marker, 0),
      cliEvent(marker, 1),
    ])).toThrow(/multiple cli\/session/)
  })

  it('rejects an unsupported marker version', () => {
    expect(() => readCliSessionMarker([
      cliEvent({ ...marker, version: 2 }),
    ])).toThrow(/unsupported CLI session version/)
  })

  it('rejects a non-object marker payload', () => {
    expect(() => readCliSessionMarker([
      cliEvent(null),
    ])).toThrow(/marker must be a plain object/)
  })

  it('rejects a matching sandbox mode outside the closed vocabulary', () => {
    expect(() => readCliSessionMarker([
      sandboxEvent('unrestricted'),
      approvalEvent('never'),
      cliEvent({ ...marker, sandboxMode: 'unrestricted' }),
    ])).toThrow(/unsupported CLI session sandbox mode/)
  })

  it('rejects a matching approval policy outside the closed vocabulary', () => {
    expect(() => readCliSessionMarker([
      sandboxEvent('danger-full-access'),
      approvalEvent('always'),
      cliEvent({ ...marker, approvalPolicy: 'always' }),
    ])).toThrow(/unsupported CLI session approval policy/)
  })

  it('rejects a marker inconsistent with the preceding sandbox mode', () => {
    expect(() => readCliSessionMarker([
      sandboxEvent('workspace-write'),
      approvalEvent('never'),
      cliEvent(marker),
    ])).toThrow(/sandbox mode/)
  })

  it('rejects a marker inconsistent with the preceding approval policy', () => {
    expect(() => readCliSessionMarker([
      sandboxEvent('danger-full-access'),
      approvalEvent('ask'),
      cliEvent(marker),
    ])).toThrow(/approval policy/)
  })

  it('writes policy events before the required CLI marker', () => {
    const session = Session.create(SessionId('cli-marker-write'))
    const event = appendCliSessionMarker(session, marker)

    expect(session.events.map(current => current.type)).toEqual([
      'sandbox/mode',
      'approval/policy',
      'cli/session',
    ])
    expect(event).toMatchObject({
      type: 'cli/session',
      seq: 2,
      data: marker,
    })
    expect(event.ignorable).toBeUndefined()
  })
})
