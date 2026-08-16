import { ProcessTerminal } from '@mariozechner/pi-tui'
import { displayText, wrapDisplayLines } from './display.ts'
import { RollingTerminalEditor } from './editor.ts'
import type {
  RollingTerminalInput,
  RollingTerminalItem,
  RollingTerminalPort,
} from './types.ts'

const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/** Public terminal operations required by the rolling renderer. */
export interface TerminalDevice {
  start(onInput: (data: string) => void, onResize: () => void): void
  drainInput(): Promise<void>
  stop(): void
  write(data: string): void
  readonly columns: number
  readonly rows: number
}

type ProcessTerminalOperations = Pick<
  ProcessTerminal,
  'start' | 'drainInput' | 'stop' | 'write' | 'columns' | 'rows'
>

/** Process-backed device that delegates to pi-tui's public terminal API. */
export class ProcessTerminalDevice implements TerminalDevice {
  /**
   * Create a process terminal device.
   * @param terminal - pi-tui terminal implementation to delegate to.
   */
  constructor(
    private readonly terminal: ProcessTerminalOperations = new ProcessTerminal(),
  ) {}

  /** @inheritdoc */
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.terminal.start(onInput, onResize)
  }

  /** @inheritdoc */
  drainInput(): Promise<void> {
    return this.terminal.drainInput()
  }

  /** @inheritdoc */
  stop(): void {
    this.terminal.stop()
  }

  /** @inheritdoc */
  write(data: string): void {
    this.terminal.write(data)
  }

  /** Current terminal columns. */
  get columns(): number {
    return this.terminal.columns
  }

  /** Current terminal rows. */
  get rows(): number {
    return this.terminal.rows
  }
}

/** Initial rolling terminal behavior. */
export interface RollingTerminalOptions {
  readonly inputEnabled?: boolean
}

interface ActiveItem extends RollingTerminalItem {
  readonly order: number
}

/**
 * Create a bounded rolling terminal over one terminal device.
 * @param device - Terminal lifecycle and output operations.
 * @param options - Initial editor behavior.
 * @returns Terminal port consumed by the CLI runner and transcript projector.
 */
export function createRollingTerminal(
  device: TerminalDevice,
  options: RollingTerminalOptions,
): RollingTerminalPort {
  const active = new Map<string, ActiveItem>()
  let activeHeight = 0
  let committedCount = 0
  let question: readonly string[] | undefined
  let status: string | undefined
  let started = false
  let stopping: Promise<void> | undefined
  let inputHandler: ((input: RollingTerminalInput) => void) | undefined
  const editor = new RollingTerminalEditor(input => inputHandler?.(input))
  editor.setInputEnabled(options.inputEnabled ?? true)

  function orderedItems(): ActiveItem[] {
    return [...active.values()].sort((left, right) => left.order - right.order)
  }

  function clearActiveRegion(): void {
    if (activeHeight === 0) return
    let sequence = '\r'
    if (activeHeight > 1) sequence += `\x1b[${activeHeight - 1}A`
    for (let index = 0; index < activeHeight; index += 1) {
      sequence += '\x1b[2K'
      if (index < activeHeight - 1) sequence += '\x1b[1B\r'
    }
    if (activeHeight > 1) sequence += `\x1b[${activeHeight - 1}A`
    sequence += '\r'
    device.write(sequence)
    activeHeight = 0
  }

  function displayLines(lines: readonly string[]): string[] {
    return lines.flatMap(line => wrapDisplayLines(displayText(line), device.columns))
  }

  function commitSettledPrefix(): void {
    for (const item of orderedItems()) {
      if (!item.settled) break
      active.delete(item.id)
      for (const line of displayLines(item.lines)) {
        device.write(`${line}\r\n`)
        committedCount += 1
      }
    }
  }

  function activeLines(): string[] {
    const lines = orderedItems().flatMap(item => displayLines(item.lines))
    if (question) lines.push(...displayLines(question))
    if (status !== undefined) lines.push(...displayLines([status]))
    lines.push(...editor.render(device.columns).lines.map(displayText))
    return lines
  }

  function redraw(): void {
    if (!started) return
    clearActiveRegion()
    commitSettledPrefix()
    const lines = activeLines()
    device.write(lines.join('\r\n'))
    activeHeight = lines.length
  }

  return {
    start(onInput): void {
      if (started) return
      started = true
      inputHandler = onInput
      device.start((data) => {
        editor.handleInput(data)
        redraw()
      }, redraw)
      device.write(HIDE_CURSOR)
      redraw()
    },

    upsert(item): void {
      const existing = active.get(item.id)
      active.set(item.id, {
        ...item,
        order: existing?.order ?? item.order,
      })
      redraw()
    },

    remove(id): void {
      if (!active.delete(id)) return
      redraw()
    },

    setQuestion(lines): void {
      question = lines
      redraw()
    },

    setStatus(line): void {
      status = line
      redraw()
    },

    setInputEnabled(enabled): void {
      editor.setInputEnabled(enabled)
      redraw()
    },

    clear(): void {
      active.clear()
      question = undefined
      status = undefined
      editor.clear()
      activeHeight = 0
      committedCount = 0
      if (!started) return
      device.write(CLEAR_SCREEN)
      redraw()
    },

    stop(): Promise<void> {
      if (stopping) return stopping
      stopping = (async () => {
        if (!started) return
        clearActiveRegion()
        device.write(SHOW_CURSOR)
        try {
          await device.drainInput()
        } finally {
          device.stop()
          started = false
          inputHandler = undefined
        }
      })()
      return stopping
    },
  }
}
