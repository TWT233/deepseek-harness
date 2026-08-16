import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it } from 'vitest'
import { CliTranscriptProjector } from '../src/transcript.ts'
import type {
  RollingTerminalItem,
  RollingTerminalPort,
} from '../src/types.ts'

class FakeTerminal implements RollingTerminalPort {
  readonly active = new Map<string, RollingTerminalItem>()
  readonly upserts: RollingTerminalItem[] = []
  clearCount = 0

  start(): void {}

  upsert(item: RollingTerminalItem): void {
    this.active.set(item.id, item)
    this.upserts.push(item)
  }

  remove(id: string): void {
    this.active.delete(id)
  }

  setQuestion(): void {}

  setStatus(): void {}

  setInputEnabled(): void {}

  clear(): void {
    this.clearCount++
    this.active.clear()
  }

  async stop(): Promise<void> {}
}

function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number },
): Extract<SessionEvent, { type: T }> {
  return {
    type,
    seq,
    time: seq,
    data,
    ...surfaceOp === undefined ? {} : { surfaceOp },
  } as Extract<SessionEvent, { type: T }>
}

function chunk(
  seq: number,
  turn: number,
  step: number,
  value: StreamChunk,
): SessionEvent<'assistant/chunk'> {
  return event('assistant/chunk', seq, { turn, step, chunk: value })
}

function assistantMessage(
  seq: number,
  turn: number,
  step: number,
  text: string,
  surfaceOp: 'append' | { op: 'replace'; start: number; end: number } = 'append',
): SessionEvent<'assistant/message'> {
  return event('assistant/message', seq, {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'p', model: 'm' },
    }),
  }, surfaceOp)
}

function userMessage(
  seq: number,
  text: string,
  source: { kind: 'user' } | { kind: 'plugin'; plugin: string },
  surfaceOp: 'append' | { op: 'replace'; start: number; end: number } = 'append',
): SessionEvent<'user/message'> {
  return event('user/message', seq, createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), surfaceOp)
}

function toolCall(
  seq: number,
  callId: string,
  name = 'plain',
): SessionEvent<'tool/call'> {
  return event('tool/call', seq, {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name,
    arguments: '{"path":"a.ts"}',
  })
}

function toolResult(
  seq: number,
  callId: string,
  text: string,
  isError = false,
  surfaceOp: 'append' | { op: 'replace'; start: number; end: number } = 'append',
): SessionEvent<'tool/result'> {
  return event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text }],
      isError,
    }),
  }, surfaceOp)
}

describe('CLI transcript projector', () => {
  let ctx: Context
  let agent: Agent
  let terminal: FakeTerminal
  let projector: CliTranscriptProjector

  beforeEach(() => {
    ctx = new Context()
    ctx.provide('tools', { get: () => undefined })
    agent = { ctx } as Agent
    terminal = new FakeTerminal()
    projector = new CliTranscriptProjector(ctx, agent, terminal, {
      showReasoning: true,
      maxToolOutputLines: 12,
      maxToolOutputBytes: 32_768,
    })
  })

  it('joins live deltas into one exact assistant stream and settles it from the message', () => {
    projector.accept(chunk(1, 1, 1, {
      type: 'text-delta',
      index: 0,
      text: 'hel',
    }))
    projector.accept(chunk(2, 1, 1, {
      type: 'text-delta',
      index: 0,
      text: 'lo',
    }))

    expect(terminal.active.get('assistant:1:1')).toEqual({
      id: 'assistant:1:1',
      order: 1,
      settled: false,
      lines: ['hello'],
    })

    projector.accept(assistantMessage(3, 1, 1, 'hello'))
    expect(terminal.active.get('assistant:1:1')).toEqual({
      id: 'assistant:1:1',
      order: 1,
      settled: true,
      lines: ['hello'],
    })
  })

  it('keeps interleaved assistant streams isolated and ignores non-rendering chunks', () => {
    projector.accept(chunk(1, 1, 1, {
      type: 'reasoning-delta',
      index: 0,
      text: 'think',
    }))
    projector.accept(chunk(2, 2, 1, {
      type: 'text-delta',
      index: 0,
      text: 'other',
    }))
    projector.accept(chunk(3, 1, 1, {
      type: 'usage',
      usage: { inputTokens: 1, outputTokens: 1 },
    }))

    expect(terminal.active.get('assistant:1:1')?.lines).toEqual([
      '\u001b[2mthink\u001b[22m',
    ])
    expect(terminal.active.get('assistant:2:1')?.lines).toEqual(['other'])
    expect(terminal.upserts).toHaveLength(2)
  })

  it('orders streamed blocks and replaces deltas with their completed block', () => {
    projector.accept(chunk(1, 1, 1, {
      type: 'reasoning-delta',
      index: 1,
      text: 'think ',
    }))
    projector.accept(chunk(2, 1, 1, {
      type: 'reasoning-delta',
      index: 1,
      text: 'more',
    }))
    projector.accept(chunk(3, 1, 1, {
      type: 'text-delta',
      index: 0,
      text: 'partial',
    }))
    projector.accept(chunk(4, 1, 1, {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'answer' },
    }))

    expect(terminal.active.get('assistant:1:1')?.lines).toEqual([
      'answer',
      '\u001b[2mthink more\u001b[22m',
    ])
  })

  it('replays assembled messages without briefly projecting their raw chunks', () => {
    projector.replay([
      chunk(1, 1, 1, { type: 'text-delta', index: 0, text: 'wrong ' }),
      chunk(2, 2, 1, { type: 'text-delta', index: 0, text: 'live fragment' }),
      assistantMessage(3, 1, 1, 'assembled'),
    ])

    expect(terminal.clearCount).toBe(1)
    expect(terminal.active.get('assistant:1:1')).toEqual({
      id: 'assistant:1:1',
      order: 3,
      settled: true,
      lines: ['assembled'],
    })
    expect(terminal.active.get('assistant:2:1')).toEqual({
      id: 'assistant:2:1',
      order: 2,
      settled: false,
      lines: ['live fragment'],
    })
    expect(terminal.upserts.some(item => item.lines.includes('wrong '))).toBe(false)
  })

  it('renders only append-origin direct human and assistant surface messages', () => {
    projector.replay([
      userMessage(1, 'human prompt', { kind: 'user' }),
      userMessage(2, 'plugin instructions', {
        kind: 'plugin',
        plugin: 'instructions',
      }),
      userMessage(3, 'replacement summary', { kind: 'user' }, {
        op: 'replace',
        start: 1,
        end: 2,
      }),
      assistantMessage(4, 1, 1, 'replacement assistant', {
        op: 'replace',
        start: 1,
        end: 3,
      }),
    ])

    expect([...terminal.active.values()]).toEqual([{
      id: 'user:1',
      order: 1,
      settled: true,
      lines: ['human prompt'],
    }])
  })

  it('pairs calls and results by call id while preserving pending-call order', () => {
    projector.accept(toolCall(4, 'call-1'))
    projector.accept(toolResult(7, 'call-1', 'done'))

    expect(terminal.active.get('tool:call-1')).toEqual({
      id: 'tool:call-1',
      order: 4,
      settled: true,
      lines: ['plain', '{', '  "path": "a.ts"', '}', 'done'],
    })
  })

  it('holds a later parallel result behind the earlier active call', () => {
    projector.accept(toolCall(4, 'first'))
    projector.accept(toolCall(5, 'second'))
    projector.accept(toolResult(6, 'second', 'second done'))

    expect(terminal.active.get('tool:first')?.settled).toBe(false)
    expect(terminal.active.get('tool:second')).toMatchObject({
      order: 5,
      settled: true,
      lines: ['plain', '{', '  "path": "a.ts"', '}', 'second done'],
    })

    projector.accept(toolResult(7, 'first', 'first done'))
    expect(terminal.active.get('tool:first')?.settled).toBe(true)
  })

  it('renders append-origin unpaired results and ignores replaced results', () => {
    projector.accept(toolResult(2, 'missing', 'orphan'))
    projector.accept(toolResult(3, 'replaced', 'hidden', false, {
      op: 'replace',
      start: 1,
      end: 2,
    }))

    expect(terminal.active.get('tool:missing')).toEqual({
      id: 'tool:missing',
      order: 2,
      settled: true,
      lines: ['orphan'],
    })
    expect(terminal.active.has('tool:replaced')).toBe(false)
  })

  it('omits a replayed call whose result was surface-replaced', () => {
    projector.replay([
      toolCall(1, 'replaced-call'),
      toolResult(2, 'replaced-call', 'hidden', false, {
        op: 'replace',
        start: 1,
        end: 1,
      }),
    ])

    expect(terminal.active.has('tool:replaced-call')).toBe(false)
  })

  it('passes result metadata to a presenter and replaces the pending title', () => {
    ctx.set('tools', {
      get: () => ({
        presentCall: () => ({ card: 'generic', title: 'Pending' }),
        presentResult: (_args: unknown, result: { meta?: unknown }) => ({
          card: 'generic',
          title: `Done ${JSON.stringify(result.meta)}`,
        }),
      }),
    })
    const local = new CliTranscriptProjector(ctx, agent, terminal, {
      showReasoning: true,
      maxToolOutputLines: 12,
      maxToolOutputBytes: 32_768,
    })
    local.accept(toolCall(1, 'meta'))
    local.accept(event('tool/result', 2, {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('meta'),
        content: [{ type: 'text', text: 'raw' }],
        isError: false,
      }),
      meta: { page: 1 },
    }, 'append'))

    expect(terminal.active.get('tool:meta')?.lines).toEqual([
      'Done {"page":1}',
    ])
  })

  it('keeps the pending title when a result presenter omits its title', () => {
    ctx.set('tools', {
      get: () => ({
        presentCall: () => ({ card: 'generic', title: 'Pending' }),
        presentResult: () => ({
          card: 'terminal',
          output: 'complete',
          exitCode: 0,
        }),
      }),
    })
    const local = new CliTranscriptProjector(ctx, agent, terminal, {
      showReasoning: true,
      maxToolOutputLines: 12,
      maxToolOutputBytes: 32_768,
    })
    local.accept(toolCall(1, 'untitled-result'))
    local.accept(toolResult(2, 'untitled-result', 'raw'))

    expect(terminal.active.get('tool:untitled-result')?.lines).toEqual([
      'Pending',
      'complete',
      '[exit code: 0]',
    ])
  })

  it('hides reasoning in raw tool results when configured', () => {
    const hidden = new CliTranscriptProjector(ctx, agent, terminal, {
      showReasoning: false,
      maxToolOutputLines: 12,
      maxToolOutputBytes: 32_768,
    })
    hidden.accept(event('tool/result', 1, {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('reasoning'),
        content: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'visible' },
        ],
        isError: false,
      }),
    }, 'append'))

    expect(terminal.active.get('tool:reasoning')?.lines).toEqual(['visible'])
  })

  it.each([
    {
      reason: {
        kind: 'error',
        error: { message: 'disk\u001b', code: 'UNKNOWN' },
      },
      line: 'Turn failed: disk\\x1b [UNKNOWN]',
    },
    {
      reason: { kind: 'aborted', reason: { kind: 'user' } },
      line: 'Turn aborted: user',
    },
    {
      reason: { kind: 'max-tokens' },
      line: 'Turn stopped: maximum output tokens reached',
    },
  ] as const)('renders a $reason.kind turn-end notice', ({ reason, line }) => {
    projector.accept(event('turn/end', 9, { turn: 3, reason }))

    expect(terminal.active.get('notice:9')).toEqual({
      id: 'notice:9',
      order: 9,
      settled: true,
      lines: [line],
    })
  })

  it('ignores completed, blocked, interrupted, and merge-extensible turn reasons', () => {
    projector.accept(event('turn/end', 1, {
      turn: 1,
      reason: { kind: 'completed' },
    }))
    projector.accept(event('turn/end', 2, {
      turn: 2,
      reason: { kind: 'blocked' },
    }))
    projector.accept(event('turn/end', 3, {
      turn: 3,
      reason: { kind: 'interrupted' },
    }))
    projector.accept(event('turn/end', 4, {
      turn: 4,
      reason: { kind: 'future' },
    } as never))

    expect(terminal.active.size).toBe(0)
  })

  it('ignores unrelated durable events', () => {
    projector.accept(event('turn/start', 1, { turn: 1 }))
    projector.accept(event('step/start', 2, { turn: 1, step: 1 }))
    projector.accept(event('step/end', 3, { turn: 1, step: 1 }))

    expect(terminal.active.size).toBe(0)
  })
})
