import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@mariozechner/pi-tui'
import { displayText, wrapDisplayLines } from '../src/display.ts'

describe('terminal display text', () => {
  it('escapes terminal control bytes before rendering', () => {
    expect(displayText('safe\u001b[31mred\u009b')).toBe('safe\\x1B[31mred\\x9B')
    expect(displayText('\u0000\t\u0007\u0008\r\u007f\u0080\u009f')).toBe(
      '\\x00\\x09\\x07\\x08\\x0D\\x7F\\x80\\x9F',
    )
    expect(displayText('a\nb')).toBe('a\nb')
  })

  it('preserves renderer-owned ANSI while wrapping escaped text by display width', () => {
    const rendered = `\u001b[32m${displayText('你好 world')}\u001b[0m`
    const lines = wrapDisplayLines(rendered, 6)

    expect(lines).toEqual([
      '\u001b[32m你好',
      '\u001b[32mworld\u001b[0m',
    ])
    expect(lines.map(visibleWidth)).toEqual([4, 5])
  })

  it('preserves explicit line breaks', () => {
    expect(wrapDisplayLines('a\nb', 80)).toEqual(['a', 'b'])
  })

  it('rewraps the same text for a resized terminal width', () => {
    expect(wrapDisplayLines('alpha beta', 80)).toEqual(['alpha beta'])
    expect(wrapDisplayLines('alpha beta', 5)).toEqual(['alpha', 'beta'])
  })

  it('returns one empty line and clamps invalid widths to one column', () => {
    expect(wrapDisplayLines('', 80)).toEqual([''])
    expect(wrapDisplayLines('ab', 0)).toEqual(['a', 'b'])
  })
})
