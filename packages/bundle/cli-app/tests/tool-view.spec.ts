import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  defineContentToolFixture,
  type ToolCallView,
  type ToolDefinition,
  type ToolResultView,
} from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ToolViewProjector,
  renderToolCallView,
  renderToolResultView,
} from '../src/tool-view.ts'

function tool(
  name: string,
  presenters: Pick<ToolDefinition, 'presentCall' | 'presentResult'>,
): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: `tool ${name}`,
    parameters: {},
    execute: async () => [{ type: 'text', text: `ran ${name}` }],
    ...presenters,
  })
}

function unknownView(card: string): ToolCallView {
  return { card, value: '\u001b' } as unknown as ToolCallView
}

describe('tool intent rendering', () => {
  it.each([
    {
      view: {
        card: 'generic',
        title: 'Read config',
        kind: 'read',
        rawInput: { path: 'a\u001b' },
        content: [{ type: 'text', text: 'detail' }],
        locations: [{ path: 'a.ts', line: 3 }],
      } satisfies ToolCallView,
      lines: ['Read config', '{', '  "path": "a\\u001b"', '}', 'detail', 'a.ts:3'],
    },
    {
      view: {
        card: 'terminal',
        title: 'printf hi',
        description: 'Print text',
        cwd: '/work',
      } satisfies ToolCallView,
      lines: ['Print text', '$ (cd /work && printf hi)'],
    },
    {
      view: {
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
        locations: [{ path: 'a.ts' }],
      } satisfies ToolCallView,
      lines: ['Write a.ts', '--- a.ts', '+++ a.ts', '-old', '+new'],
    },
  ])('maps the $view.card call discriminant', ({ view, lines }) => {
    expect(renderToolCallView(view)).toEqual(lines)
  })

  it.each([
    {
      view: {
        card: 'generic',
        title: 'Finished',
        content: [{ type: 'text', text: 'ok' }],
      } satisfies ToolResultView,
      lines: ['Finished', 'ok'],
    },
    {
      view: {
        card: 'terminal',
        title: 'Done',
        output: 'line 1\nline 2',
        exitCode: 3,
      } satisfies ToolResultView,
      lines: ['Done', 'line 1', 'line 2', '[exit code: 3]'],
    },
    {
      view: {
        card: 'terminal',
        output: 'stopped',
        signal: 'SIGTERM',
      } satisfies ToolResultView,
      lines: ['stopped', '[signal: SIGTERM]'],
    },
    {
      view: {
        card: 'diff',
        diffs: [{ path: 'a.ts', oldText: null, newText: 'new' }],
      } satisfies ToolResultView,
      lines: ['--- /dev/null', '+++ a.ts', '+new'],
    },
    {
      view: {
        card: 'search',
        shape: 'matches',
        title: 'Matches',
        files: [{
          path: 'a.ts',
          matches: [{ lineNumber: 4, line: 'needle' }],
        }],
        truncated: true,
        total: 2,
      } satisfies ToolResultView,
      lines: ['Matches', 'a.ts:4:needle', '… 1 match omitted …'],
    },
    {
      view: {
        card: 'search',
        shape: 'paths',
        paths: ['a.ts', 'b.ts'],
        truncated: false,
        total: 2,
      } satisfies ToolResultView,
      lines: ['a.ts', 'b.ts'],
    },
    {
      view: {
        card: 'read',
        title: 'Read a.ts',
        path: 'a.ts',
        offset: 2,
        lines: [{ number: 2, text: 'const x = 1' }],
        totalLines: 8,
        lang: 'ts',
      } satisfies ToolResultView,
      lines: ['Read a.ts', 'a.ts:2  const x = 1', '[showing 1 of 8 lines]'],
    },
    {
      view: {
        card: 'web',
        kind: 'search',
        title: 'Web results',
        sources: [{
          url: 'https://example.com',
          title: 'Example',
          snippet: 'A source',
        }],
        answer: 'Answer',
        truncated: false,
      } satisfies ToolResultView,
      lines: ['Web results', 'Answer', 'Example — https://example.com', 'A source'],
    },
    {
      view: {
        card: 'web',
        kind: 'fetch',
        url: 'https://example.com/final',
        statusCode: 200,
        truncated: true,
      } satisfies ToolResultView,
      lines: ['https://example.com/final [200] (truncated)'],
    },
  ])('maps the $view.card result discriminant', ({ view, lines }) => {
    expect(renderToolResultView(view)).toEqual(lines)
  })

  it('falls back generically for merge-extensible call and result cards', () => {
    expect(renderToolCallView(unknownView('future'))).toEqual([
      '{',
      '  "card": "future",',
      '  "value": "\\u001b"',
      '}',
    ])
    expect(renderToolResultView(unknownView('future') as unknown as ToolResultView))
      .toEqual([
        '{',
        '  "card": "future",',
        '  "value": "\\u001b"',
        '}',
      ])
  })

  it('renders every optional call field when omitted or scalar', () => {
    expect(renderToolCallView({
      card: 'generic',
      title: 'Scalar',
      rawInput: 'value',
      locations: [{ path: 'a.ts' }],
    })).toEqual(['Scalar', 'value', 'a.ts'])
    expect(renderToolCallView({
      card: 'terminal',
      title: 'pwd',
    })).toEqual(['$ pwd'])
  })

  it('renders every optional generic, terminal, diff, read, search, and web result field', () => {
    expect(renderToolResultView(
      { card: 'generic' },
      { showReasoning: true },
      [{ type: 'text', text: 'raw result' }],
    )).toEqual(['raw result'])
    expect(renderToolResultView(
      { card: 'generic', title: 'Finished' },
      { showReasoning: true },
      [{ type: 'text', text: 'raw result' }],
    )).toEqual(['Finished', 'raw result'])
    expect(renderToolResultView({ card: 'terminal' })).toEqual([])
    expect(renderToolResultView({
      card: 'diff',
      title: 'Applied',
      diffs: [],
    })).toEqual(['Applied'])
    expect(renderToolResultView({
      card: 'read',
      path: 'empty.ts',
      offset: 1,
      lines: [],
      totalLines: 0,
    })).toEqual(['[showing 0 of 0 lines]'])
    expect(renderToolResultView({
      card: 'search',
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'a' }] }],
      truncated: true,
      total: 3,
    })).toEqual(['a.ts:1:a', '… 2 matches omitted …'])
    expect(renderToolResultView({
      card: 'search',
      shape: 'paths',
      paths: ['a.ts'],
      truncated: true,
      total: 2,
    })).toEqual(['a.ts', '… 1 path omitted …'])
    expect(renderToolResultView({
      card: 'search',
      shape: 'paths',
      paths: ['a.ts'],
      truncated: true,
      total: 3,
    })).toEqual(['a.ts', '… 2 paths omitted …'])
    expect(renderToolResultView({
      card: 'web',
      kind: 'fetch',
      title: 'Fetched',
      url: 'https://example.com',
      statusCode: 204,
      truncated: false,
    })).toEqual(['Fetched', 'https://example.com [204]'])
    expect(renderToolResultView({
      card: 'web',
      kind: 'search',
      sources: [{ url: 'https://example.com' }],
      truncated: true,
    })).toEqual([
      'https://example.com',
      '… additional sources omitted …',
    ])
  })

})

describe('tool presenter projection', () => {
  let ctx: Context
  let agent: Agent
  let scopes: unknown[]

  beforeEach(() => {
    ctx = new Context()
    const definitions = new Map<string, ToolDefinition>()
    scopes = []
    ctx.provide('tools', {
      register(definition: ToolDefinition): () => void {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      },
      get(name: string, scope?: unknown): ToolDefinition | undefined {
        scopes.push(scope)
        return definitions.get(name)
      },
    })
    agent = { ctx } as Agent
  })

  it('uses the presenter intent rather than the tool name and preserves call order', () => {
    ctx.tools.register(tool('misleading_terminal_name', {
      presentCall: () => ({ card: 'generic', title: 'Generic intent' }),
    }))
    const projector = new ToolViewProjector(ctx, agent)

    expect(projector.acceptCall({
      callId: CallId('call-1'),
      name: 'misleading_terminal_name',
      arguments: '{"value":1}',
    }, 7)).toEqual({
      callId: CallId('call-1'),
      order: 7,
      replacesPending: false,
      lines: ['Generic intent'],
    })
  })

  it('pairs results with parsed call arguments and the exact Agent scope', () => {
    let seen: unknown
    ctx.tools.register(tool('scoped', {
      presentResult: (args) => {
        seen = args
        return { card: 'generic', title: 'Scoped result' }
      },
    }))
    const projector = new ToolViewProjector(ctx, agent)
    projector.acceptCall({
      callId: CallId('call-2'),
      name: 'scoped',
      arguments: '{"path":"a.ts"}',
    }, 9)

    expect(projector.acceptResult({
      callId: CallId('call-2'),
      content: [{ type: 'text', text: 'raw' }],
      isError: false,
      meta: { page: 1 },
    })).toEqual({
      callId: CallId('call-2'),
      order: 9,
      replacesPending: true,
      lines: ['Scoped result', 'raw'],
    })
    expect(seen).toEqual({ path: 'a.ts' })
    expect(scopes).toEqual([agent, agent])
  })

  it('falls back generically for unknown tools and malformed arguments', () => {
    const projector = new ToolViewProjector(ctx, agent)

    expect(projector.acceptCall({
      callId: CallId('unknown'),
      name: 'no_such_tool',
      arguments: '{"value":"\\u001b"}',
    }, 1)?.lines).toEqual([
      'no_such_tool',
      '{',
      '  "value": "\\u001b"',
      '}',
    ])
    expect(projector.acceptCall({
      callId: CallId('bad-json'),
      name: 'no_such_tool',
      arguments: '{\u001b',
    }, 2)?.lines).toEqual(['no_such_tool', '{\\x1b'])
  })

  it('falls back generically when presenters throw or omit a view', () => {
    ctx.tools.register(tool('throws', {
      presentCall: () => { throw new Error('call failed') },
      presentResult: () => { throw new Error('result failed') },
    }))
    const projector = new ToolViewProjector(ctx, agent)

    expect(projector.acceptCall({
      callId: CallId('throws'),
      name: 'throws',
      arguments: '{"x":1}',
    }, 4)?.lines).toEqual(['throws', '{', '  "x": 1', '}'])
    expect(projector.acceptResult({
      callId: CallId('throws'),
      content: [{ type: 'text', text: 'raw result' }],
      isError: true,
    })?.lines).toEqual(['raw result', '[tool failed]'])
  })

  it('renders an unpaired cross-page result without invoking a presenter', () => {
    const projector = new ToolViewProjector(ctx, agent)

    expect(projector.acceptResult({
      callId: CallId('missing'),
      content: [{ type: 'text', text: 'orphan result' }],
      isError: false,
    })).toEqual({
      callId: CallId('missing'),
      order: undefined,
      replacesPending: false,
      lines: ['orphan result'],
    })
  })
})
