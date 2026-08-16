import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RollingTerminalInput } from '../src/types.ts'
import { RollingTerminalEditor } from '../src/editor.ts'

function setup() {
  const inputs: RollingTerminalInput[] = []
  const editor = new RollingTerminalEditor(input => inputs.push(input))
  return { editor, inputs }
}

describe('rolling terminal editor', () => {
  it('inserts a newline with Alt+Enter and submits multiline text', () => {
    const { editor, inputs } = setup()

    editor.handleInput('hello')
    editor.handleInput('\x1b\r')
    editor.handleInput('world')
    editor.handleInput('\r')

    expect(inputs).toEqual([{ kind: 'submit', text: 'hello\nworld' }])
    expect(editor.render(80)).toMatchObject({ lines: ['> '] })
  })

  it('emits interrupt and eof independently of editable text', () => {
    const { editor, inputs } = setup()

    editor.handleInput('\x03')
    editor.handleInput('\x04')

    expect(inputs).toEqual([{ kind: 'interrupt' }, { kind: 'eof' }])
  })

  it('deletes one grapheme with Backspace', () => {
    const { editor } = setup()

    editor.handleInput('\x7f')
    editor.handleInput('\x1b[D')
    editor.handleInput('a👍')
    editor.handleInput('\x7f')
    editor.handleInput('\x1b[C')

    expect(editor.text).toBe('a')
  })

  it('moves left and right across wrapped visual lines after resize', () => {
    const { editor } = setup()

    editor.handleInput('abcdef')
    expect(editor.render(6)).toMatchObject({
      lines: ['> abc', '  def'],
      cursorRow: 1,
      cursorColumn: 5,
    })

    editor.handleInput('\x1b[A')
    expect(editor.render(6)).toMatchObject({ cursorRow: 0, cursorColumn: 5 })
    editor.handleInput('X')
    expect(editor.text).toBe('abcXdef')

    editor.handleInput('\x1b[B')
    editor.handleInput('\x1b[D')
    editor.handleInput('\x1b[C')
    expect(editor.render(80)).toMatchObject({
      lines: ['> abcXdef'],
      cursorRow: 0,
      cursorColumn: 9,
    })
  })

  it('moves to line boundaries with Ctrl+A and Ctrl+E', () => {
    const { editor } = setup()

    editor.handleInput('first')
    editor.handleInput('\x1b\r')
    editor.handleInput('last')
    editor.handleInput('\x1b[A')
    editor.handleInput('\x05')
    editor.handleInput('!')
    editor.handleInput('\x1b[B')
    editor.handleInput('\x01')
    editor.handleInput('>')
    editor.handleInput('\x05')
    editor.handleInput('<')

    expect(editor.text).toBe('first!\n>last<')
  })

  it('places the cursor at the start of an explicit second line', () => {
    const { editor } = setup()

    editor.handleInput('first')
    editor.handleInput('\x1b\r')

    expect(editor.render(80)).toMatchObject({
      lines: ['> first', '  '],
      cursorRow: 1,
      cursorColumn: 2,
    })
  })

  it('deletes to line boundaries with Ctrl+U and Ctrl+K', () => {
    const { editor } = setup()

    editor.handleInput('alpha beta')
    editor.handleInput('\x01')
    editor.handleInput('\x1b[C')
    editor.handleInput('\x1b[C')
    editor.handleInput('\x0b')
    expect(editor.text).toBe('al')

    editor.handleInput('pha')
    editor.handleInput('\x15')
    expect(editor.text).toBe('')
  })

  it('deletes the previous word with Ctrl+W', () => {
    const { editor } = setup()

    editor.handleInput('one two  ')
    editor.handleInput('\x17')

    expect(editor.text).toBe('one ')
  })

  it('buffers bracketed paste markers and normalizes pasted line endings and tabs', () => {
    const { editor } = setup()

    editor.handleInput('\x1b[200~hello\r')
    editor.handleInput('\n\tworld\x1b[201~!')

    expect(editor.text).toBe('hello\r\n\tworld!')
    expect(editor.render(10)).toMatchObject({
      lines: [
        '> hello',
        '  \\x0D',
        '  \\x09wor',
        '  ld!',
      ],
      cursorRow: 3,
      cursorColumn: 5,
    })
  })

  it('accepts a complete bracketed paste without trailing input', () => {
    const { editor } = setup()

    editor.handleInput('\x1b[200~pasted\x1b[201~')

    expect(editor.text).toBe('pasted')
  })

  it('sanitizes pasted controls before wrapping and cursor layout', () => {
    const { editor } = setup()

    editor.handleInput('\x1b[200~a\tb\x1b[31m\x1b[201~')

    expect(editor.text).toBe('a\tb\x1b[31m')
    expect(editor.render(8)).toEqual({
      lines: [
        '> a\\x09',
        '  b\\x1B',
        '  [31m',
      ],
      cursorRow: 2,
      cursorColumn: 6,
    })
  })

  it('wraps one escaped control atom across a one-column content area', () => {
    const { editor } = setup()

    editor.handleInput('\x1b[200~a\t\x1b[201~')

    expect(editor.render(4)).toEqual({
      lines: ['> a', '  \\', '  x', '  0', '  9'],
      cursorRow: 4,
      cursorColumn: 3,
    })
    editor.handleInput('\x1b[A')
    expect(editor.render(4)).toMatchObject({
      cursorRow: 0,
      cursorColumn: 3,
    })
  })

  it('renders a wide grapheme in a one-column content area without hanging', () => {
    const editorUrl = new URL('../src/editor.ts', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '--eval',
        [
          `import { RollingTerminalEditor } from ${JSON.stringify(editorUrl)}`,
          'const editor = new RollingTerminalEditor(() => {})',
          'editor.handleInput("👍")',
          'process.stdout.write(JSON.stringify(editor.render(4)))',
        ].join(';'),
      ],
      {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 1_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      lines: ['> 👍'],
      cursorRow: 0,
      cursorColumn: 4,
    })
  })

  it('navigates submitted history and returns to the current draft', () => {
    const { editor } = setup()

    editor.handleInput('first')
    editor.handleInput('\r')
    editor.handleInput('second')
    editor.handleInput('\r')
    editor.handleInput('draft')
    editor.handleInput('\x1b[A')
    expect(editor.text).toBe('second')
    editor.handleInput('\x1b[A')
    expect(editor.text).toBe('first')
    editor.handleInput('\x1b[B')
    expect(editor.text).toBe('second')
    editor.handleInput('\x1b[B')
    expect(editor.text).toBe('draft')
    editor.handleInput('\x1b[B')
    expect(editor.text).toBe('draft')
  })

  it('ignores history navigation before any submission', () => {
    const { editor } = setup()

    editor.handleInput('\x1b[A')
    editor.handleInput('\x1b[B')

    expect(editor.text).toBe('')
  })

  it('does not retain blank or consecutive duplicate history entries', () => {
    const { editor } = setup()

    editor.handleInput('\r')
    editor.handleInput('same')
    editor.handleInput('\r')
    editor.handleInput('same')
    editor.handleInput('\r')
    editor.handleInput('\x1b[A')
    expect(editor.text).toBe('same')
    editor.handleInput('\x1b[A')
    expect(editor.text).toBe('same')
  })

  it('bounds submitted history to the most recent 100 entries', () => {
    const { editor } = setup()

    for (let index = 0; index < 101; index += 1) {
      editor.handleInput(`entry-${index}`)
      editor.handleInput('\r')
    }
    for (let index = 0; index < 100; index += 1) {
      editor.handleInput('\x1b[A')
    }
    expect(editor.text).toBe('entry-1')
    editor.handleInput('\x1b[A')
    expect(editor.text).toBe('entry-1')
  })

  it('keeps the draft and suppresses submit while input is disabled', () => {
    const { editor, inputs } = setup()

    editor.handleInput('answer')
    editor.setInputEnabled(false)
    editor.handleInput('\r')
    expect(inputs).toEqual([])
    expect(editor.render(80).lines).toEqual(['  answer'])

    editor.setInputEnabled(true)
    editor.handleInput('\r')
    expect(inputs).toEqual([{ kind: 'submit', text: 'answer' }])
  })

  it('clears editable state and ignores unsupported control input', () => {
    const { editor } = setup()

    editor.handleInput('safe')
    editor.handleInput('')
    editor.handleInput('\x00')
    editor.clear()

    expect(editor.text).toBe('')
    expect(editor.render(1)).toMatchObject({
      lines: ['> '],
      cursorRow: 0,
      cursorColumn: 2,
    })
  })

  it('renders a wide grapheme in a one-column content area', () => {
    const { editor } = setup()

    editor.handleInput('你')

    expect(editor.render(3).lines).toEqual(['> 你'])
  })

  it('keeps a preferred visual column when moving through uneven lines', () => {
    const { editor } = setup()

    editor.handleInput('abcd')
    editor.handleInput('\x1b\r')
    editor.handleInput('x')
    editor.handleInput('\x1b\r')
    editor.handleInput('wxyz')
    editor.handleInput('\x1b[A')
    editor.handleInput('\x1b[A')
    editor.handleInput('!')

    expect(editor.text).toBe('abcd!\nx\nwxyz')
  })
})
