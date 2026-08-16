import { describe, expect, it, vi } from 'vitest'
import type { RollingTerminalInput } from '../src/types.ts'
import {
  ProcessTerminalDevice,
  createRollingTerminal,
  type TerminalDevice,
} from '../src/terminal.ts'

class FakeTerminalDevice implements TerminalDevice {
  columns = 80
  rows = 24
  readonly scrollback: string[] = []
  activeLines: string[] = []
  readonly writes: string[] = []
  readonly lifecycle: string[] = []
  rawMode = false
  bracketedPaste = false
  keyboardProtocol = false
  cursorVisible = true
  inputPaused = true
  private onInput?: (data: string) => void
  private onResize?: () => void

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.lifecycle.push('start')
    this.rawMode = true
    this.bracketedPaste = true
    this.keyboardProtocol = true
    this.inputPaused = false
    this.onInput = onInput
    this.onResize = onResize
  }

  async drainInput(): Promise<void> {
    this.lifecycle.push('drain')
    this.keyboardProtocol = false
  }

  stop(): void {
    this.lifecycle.push('stop')
    this.rawMode = false
    this.bracketedPaste = false
    this.inputPaused = true
  }

  write(data: string): void {
    this.writes.push(data)
    if (data === '\x1b[?25l') this.cursorVisible = false
    if (data === '\x1b[?25h') this.cursorVisible = true
    if (data === '\x1b[2J\x1b[H') {
      this.scrollback.length = 0
      this.activeLines = []
    } else if (data.endsWith('\r\n') && !data.includes('\x1b')) {
      this.scrollback.push(data.slice(0, -2))
    } else if (data.startsWith('\r\x1b[2K')) {
      this.activeLines = []
    } else if (!data.includes('\x1b')) {
      this.activeLines = data.split('\r\n')
    }
  }

  input(data: string): void {
    this.onInput?.(data)
  }

  resize(columns: number, rows = this.rows): void {
    this.columns = columns
    this.rows = rows
    this.onResize?.()
  }
}

function setup() {
  const device = new FakeTerminalDevice()
  const inputs: RollingTerminalInput[] = []
  const terminal = createRollingTerminal(device, {})
  terminal.start(input => inputs.push(input))
  return { device, inputs, terminal }
}

describe('rolling terminal', () => {
  it('commits only the contiguous lowest-order settled prefix', () => {
    const { device, terminal } = setup()

    terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
    terminal.upsert({ id: 'b', order: 2, settled: true, lines: ['B done'] })
    expect(device.scrollback).toEqual([])

    terminal.upsert({ id: 'a', order: 1, settled: true, lines: ['A done'] })
    expect(device.scrollback).toEqual(['A done', 'B done'])
    expect(device.activeLines).toContain('> ')
  })

  it('retains an item first order across updates', () => {
    const { device, terminal } = setup()

    terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
    terminal.upsert({ id: 'b', order: 2, settled: true, lines: ['B done'] })
    terminal.upsert({ id: 'b', order: 0, settled: true, lines: ['B updated'] })

    expect(device.scrollback).toEqual([])
    terminal.upsert({ id: 'a', order: 1, settled: true, lines: ['A done'] })
    expect(device.scrollback).toEqual(['A done', 'B updated'])
  })

  it('removing a blocking item releases the next settled item', () => {
    const { device, terminal } = setup()

    terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
    terminal.upsert({ id: 'b', order: 2, settled: true, lines: ['B done'] })
    terminal.remove('a')

    expect(device.scrollback).toEqual(['B done'])
    terminal.remove('missing')
    expect(device.scrollback).toEqual(['B done'])
  })

  it('draws active items, question, status, and disabled editor rows', () => {
    const { device, inputs, terminal } = setup()

    terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
    terminal.setQuestion(['Choose one'])
    terminal.setStatus('Working')
    terminal.setInputEnabled(false)
    device.input('answer')
    device.input('\r')

    expect(inputs).toEqual([])
    expect(device.activeLines).toEqual(['A…', 'Choose one', 'Working', '  answer'])
    terminal.setQuestion(undefined)
    terminal.setStatus(undefined)
    terminal.setInputEnabled(true)
    device.input('\r')
    expect(inputs).toEqual([{ kind: 'submit', text: 'answer' }])
  })

  it('escapes control bytes in transcript and pasted editor text', () => {
    const { device, terminal } = setup()

    terminal.upsert({
      id: 'a',
      order: 1,
      settled: true,
      lines: ['safe\x1b[31m'],
    })
    device.input('\x1b[200~paste\x1b[31m\x1b[201~')

    expect(device.scrollback).toEqual(['safe\\x1B[31m'])
    expect(device.activeLines).toContain('> paste\\x1B[31m')
  })

  it('rewraps the active region after terminal resize', () => {
    const { device, terminal } = setup()

    terminal.upsert({
      id: 'a',
      order: 1,
      settled: false,
      lines: ['alpha beta'],
    })
    expect(device.activeLines).toContain('alpha beta')

    device.resize(5)
    expect(device.activeLines).toEqual(['alpha', 'beta', '> '])
  })

  it('clears screen state and redraws only an empty editor', () => {
    const { device, terminal } = setup()

    terminal.upsert({ id: 'a', order: 1, settled: false, lines: ['A…'] })
    terminal.setQuestion(['Question'])
    terminal.setStatus('Status')
    device.input('draft')
    terminal.clear()

    expect(device.scrollback).toEqual([])
    expect(device.activeLines).toEqual(['> '])
    expect(device.writes).toContain('\x1b[2J\x1b[H')
  })

  it('does not retain committed history in later redraws', () => {
    const { device, terminal } = setup()
    const history = Array.from({ length: 100_000 }, (_, index) => `history-${index}`)

    terminal.upsert({
      id: 'history',
      order: 1,
      settled: true,
      lines: history,
    })
    expect(device.scrollback).toHaveLength(100_000)

    device.writes.length = 0
    terminal.setStatus('fresh')

    expect(device.writes.join('')).not.toContain('history-')
    expect(device.activeLines).toEqual(['fresh', '> '])
  })

  it('clears exactly the previous active height before redraw', () => {
    const { device, terminal } = setup()

    terminal.setQuestion(['one', 'two'])
    device.writes.length = 0
    terminal.setQuestion(['one'])

    const erase = device.writes.find(write => write.includes('\x1b[2K'))
    expect(erase?.match(/\x1b\[2K/g)).toHaveLength(3)
  })

  it('drains input, restores terminal state, and stops once', async () => {
    const { device, terminal } = setup()

    await terminal.stop()
    await terminal.stop()

    expect(device.lifecycle).toEqual(['start', 'drain', 'stop'])
    expect(device.writes).toContain('\x1b[?25h')
    expect(device).toMatchObject({
      rawMode: false,
      bracketedPaste: false,
      keyboardProtocol: false,
      cursorVisible: true,
      inputPaused: true,
    })
  })

  it('accepts state before start and ignores a repeated start', () => {
    const device = new FakeTerminalDevice()
    const terminal = createRollingTerminal(device, { inputEnabled: false })
    const firstInputs: RollingTerminalInput[] = []
    const secondInputs: RollingTerminalInput[] = []

    terminal.upsert({ id: 'a', order: 1, settled: true, lines: ['A done'] })
    terminal.setQuestion(['Question'])
    terminal.setStatus('Status')
    terminal.setInputEnabled(true)
    terminal.start(input => firstInputs.push(input))
    terminal.start(input => secondInputs.push(input))
    device.input('answer')
    device.input('\r')

    expect(device.lifecycle).toEqual(['start'])
    expect(device.scrollback).toEqual(['A done'])
    expect(firstInputs).toEqual([{ kind: 'submit', text: 'answer' }])
    expect(secondInputs).toEqual([])
  })

  it('clears and stops safely before start', async () => {
    const device = new FakeTerminalDevice()
    const terminal = createRollingTerminal(device, {})

    terminal.clear()
    await terminal.stop()

    expect(device.lifecycle).toEqual([])
    expect(device.writes).toEqual([])
  })
})

describe('ProcessTerminalDevice', () => {
  it('delegates only the public ProcessTerminal operations', async () => {
    const processTerminal = {
      start: vi.fn(),
      drainInput: vi.fn(async () => {}),
      stop: vi.fn(),
      write: vi.fn(),
      columns: 120,
      rows: 40,
    }
    const device = new ProcessTerminalDevice(processTerminal)
    const onInput = vi.fn()
    const onResize = vi.fn()

    device.start(onInput, onResize)
    device.write('text')
    await device.drainInput()
    device.stop()

    expect(processTerminal.start).toHaveBeenCalledWith(onInput, onResize)
    expect(processTerminal.write).toHaveBeenCalledWith('text')
    expect(processTerminal.drainInput).toHaveBeenCalledOnce()
    expect(processTerminal.stop).toHaveBeenCalledOnce()
    expect(device.columns).toBe(120)
    expect(device.rows).toBe(40)
  })
})
