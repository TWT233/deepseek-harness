import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  boundToolLines,
  escapeControls,
  renderContent,
} from '../src/content.ts'

const dim = (text: string): string => `\u001b[2m${text}\u001b[22m`

describe('CLI content rendering', () => {
  it('renders text and optionally dimmed reasoning in content order', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'thought' },
    ]

    expect(renderContent(content, { showReasoning: true })).toEqual([
      'answer',
      dim('thought'),
    ])
    expect(renderContent(content, { showReasoning: false })).toEqual(['answer'])
  })

  it('renders images and recursively renders nested tool results', () => {
    const content = [
      { type: 'image', attachment: {} },
      {
        type: 'tool-result',
        toolCallId: 'nested',
        content: [
          { type: 'text', text: 'nested result' },
          { type: 'reasoning', text: 'nested thought' },
        ],
      },
      { type: 'tool-call', id: 'hidden', name: 'hidden', arguments: '{}' },
    ] as unknown as ContentBlock[]

    expect(renderContent(content, { showReasoning: true })).toEqual([
      '[image unsupported in terminal]',
      'nested result',
      dim('nested thought'),
    ])
  })

  it('exposes terminal controls while preserving line feeds', () => {
    expect(escapeControls('a\u0000\t\n\u001b[31m\u007f\u0085z')).toBe(
      'a\\x00\\x09\n\\x1b[31m\\x7f\\x85z',
    )
    expect(renderContent([
      { type: 'text', text: 'safe\u001b[2J\nnext\rline' },
    ], { showReasoning: false })).toEqual([
      'safe\\x1b[2J',
      'next\\x0dline',
    ])
  })

  it('falls back to escaped JSON for merge-extensible content', () => {
    const content = [{
      type: 'future',
      value: '\u001b',
    }] as unknown as ContentBlock[]

    expect(renderContent(content, { showReasoning: false })).toEqual([
      '{',
      '  "type": "future",',
      '  "value": "\\u001b"',
      '}',
    ])
  })
})

describe('bounded tool lines', () => {
  it('retains symmetric head and tail lines around the required notice', () => {
    expect(boundToolLines(
      ['1', '2', '3', '4'],
      { maxLines: 3, maxBytes: 32_768 },
    )).toEqual(['1', '… 1 line omitted …', '4'])

    expect(boundToolLines(
      ['1', '2', '3', '4', '5', '6'],
      { maxLines: 4, maxBytes: 32_768 },
    )).toEqual(['1', '… 2 lines omitted …', '5', '6'])
  })

  it('uses TextRetainer cuts without emitting invalid UTF-8', () => {
    const lines = boundToolLines(
      ['start €€€€ middle', 'tail 你好'],
      { maxLines: 10, maxBytes: 32 },
    )
    const rendered = lines.join('\n')

    expect(rendered).not.toContain('�')
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(40)
    expect(lines.some(line => line.includes('bytes omitted'))).toBe(true)
  })

  it('handles exact, zero-line, and tiny-byte bounds', () => {
    expect(boundToolLines(['one', 'two'], { maxLines: 2, maxBytes: 7 }))
      .toEqual(['one', 'two'])
    expect(boundToolLines(['one'], { maxLines: 0, maxBytes: 100 })).toEqual([])
    expect(boundToolLines(['one'], { maxLines: 1, maxBytes: 0 })).toEqual([''])

    const tiny = boundToolLines(['long output'], { maxLines: 1, maxBytes: 4 })
    expect(new TextEncoder().encode(tiny.join('\n')).byteLength).toBeLessThanOrEqual(4)
    expect(tiny.join('\n')).not.toContain('�')
  })
})
