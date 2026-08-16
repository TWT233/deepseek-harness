import {
  Key,
  matchesKey,
  visibleWidth,
} from '@mariozechner/pi-tui'
import { sliceByColumn } from '@mariozechner/pi-tui/dist/utils.js'
import { displayText } from './display.ts'
import type { RollingTerminalInput } from './types.ts'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const HISTORY_LIMIT = 100

interface VisualLine {
  readonly text: string
  readonly width: number
  readonly cursorPositions: readonly CursorPosition[]
}

interface CursorPosition {
  readonly offset: number
  readonly column: number
  readonly canonical: boolean
}

/** Rendered editor rows and the cursor position relative to those rows. */
export interface RollingEditorRender {
  readonly lines: readonly string[]
  readonly cursorRow: number
  readonly cursorColumn: number
}

function graphemeBoundaries(text: string): number[] {
  return [...segmenter.segment(text)].map(segment => segment.index)
}

function previousBoundary(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text.slice(0, offset))
  return boundaries.at(-1) ?? 0
}

function nextBoundary(text: string, offset: number): number {
  const segment = segmenter.segment(text.slice(offset))[Symbol.iterator]().next()
  return offset + (segment.done ? 0 : segment.value.segment.length)
}

function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const previousBreak = text.lastIndexOf('\n', Math.max(0, cursor - 1))
  const nextBreak = text.indexOf('\n', cursor)
  return {
    start: previousBreak + 1,
    end: nextBreak === -1 ? text.length : nextBreak,
  }
}

function offsetAtColumn(line: VisualLine, column: number): number {
  let offset = (line.cursorPositions[0] as CursorPosition).offset
  for (const position of line.cursorPositions) {
    if (position.column > column) break
    offset = position.offset
  }
  return offset
}

function pushCursorPosition(
  positions: CursorPosition[],
  offset: number,
  column: number,
): void {
  const previous = positions.at(-1)
  if (previous?.offset === offset && previous.column === column) return
  positions.push({ offset, column, canonical: true })
}

/**
 * Multiline editor for the rolling terminal active region.
 *
 * The editor recognizes only the CLI's confirmed key set and emits the frozen
 * terminal input union.
 */
export class RollingTerminalEditor {
  private value = ''
  private cursor = 0
  private inputEnabled = true
  private renderWidth = 80
  private pasteBuffer: string | undefined
  private readonly history: string[] = []
  private historyIndex = -1
  private historyDraft = ''
  private preferredColumn: number | undefined

  /**
   * Create an editor.
   * @param emit - Receives submitted text and terminal control inputs.
   */
  constructor(private readonly emit: (input: RollingTerminalInput) => void) {}

  /** Current editable text. */
  get text(): string {
    return this.value
  }

  /**
   * Enable or disable submission.
   * @param enabled - Whether Enter may submit the current text.
   */
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled
  }

  /** Clear the current draft without discarding submitted history. */
  clear(): void {
    this.setValue('', 0)
  }

  /**
   * Apply one input sequence from the terminal.
   * @param data - One key sequence or bracketed-paste fragment.
   */
  handleInput(data: string): void {
    if (this.consumePaste(data)) return
    if (matchesKey(data, Key.ctrl('c'))) {
      this.emit({ kind: 'interrupt' })
    } else if (matchesKey(data, Key.ctrl('d'))) {
      this.emit({ kind: 'eof' })
    } else if (matchesKey(data, Key.alt('enter'))) {
      this.insert('\n')
    } else if (matchesKey(data, Key.enter)) {
      this.submit()
    } else if (matchesKey(data, Key.backspace)) {
      this.deleteBackward()
    } else if (matchesKey(data, Key.left)) {
      this.moveHorizontal(-1)
    } else if (matchesKey(data, Key.right)) {
      this.moveHorizontal(1)
    } else if (matchesKey(data, Key.up)) {
      this.moveVertical(-1)
    } else if (matchesKey(data, Key.down)) {
      this.moveVertical(1)
    } else if (matchesKey(data, Key.ctrl('a'))) {
      this.moveToLineBoundary('start')
    } else if (matchesKey(data, Key.ctrl('e'))) {
      this.moveToLineBoundary('end')
    } else if (matchesKey(data, Key.ctrl('u'))) {
      this.deleteToLineBoundary('start')
    } else if (matchesKey(data, Key.ctrl('k'))) {
      this.deleteToLineBoundary('end')
    } else if (matchesKey(data, Key.ctrl('w'))) {
      this.deleteWordBackward()
    } else if (this.isPrintable(data)) {
      this.insert(data)
    }
  }

  /**
   * Render editor rows for one terminal width.
   * @param width - Current terminal columns.
   * @returns Rows plus the visible cursor position.
   */
  render(width: number): RollingEditorRender {
    this.renderWidth = Math.max(1, Math.floor(width))
    const visualLines = this.layout()
    const cursorRow = this.findCursorLine(visualLines)
    const cursorLine = visualLines[cursorRow] as VisualLine
    const cursorPosition = cursorLine.cursorPositions.find(
      position => position.offset === this.cursor,
    ) as CursorPosition
    const prompt = this.inputEnabled && cursorRow === 0 ? '> ' : '  '
    return {
      lines: visualLines.map((line, index) => (
        `${this.inputEnabled && index === 0 ? '> ' : '  '}${line.text}`
      )),
      cursorRow,
      cursorColumn: visibleWidth(prompt) + cursorPosition.column,
    }
  }

  private consumePaste(data: string): boolean {
    const start = data.indexOf(PASTE_START)
    if (this.pasteBuffer === undefined && start === -1) return false
    if (this.pasteBuffer === undefined) {
      this.pasteBuffer = data.slice(start + PASTE_START.length)
    } else {
      this.pasteBuffer += data
    }
    const end = this.pasteBuffer.indexOf(PASTE_END)
    if (end === -1) return true
    const pasted = this.pasteBuffer.slice(0, end)
    const remaining = this.pasteBuffer.slice(end + PASTE_END.length)
    this.pasteBuffer = undefined
    this.insert(pasted)
    if (remaining) this.handleInput(remaining)
    return true
  }

  private isPrintable(data: string): boolean {
    if (data.length === 0) return false
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index)
      if (code < 32 || code === 0x7F || (code >= 0x80 && code <= 0x9F)) {
        return false
      }
    }
    return true
  }

  private insert(text: string): void {
    this.setValue(
      this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor),
      this.cursor + text.length,
    )
  }

  private submit(): void {
    if (!this.inputEnabled) return
    const submitted = this.value
    if (submitted.trim() !== '' && this.history[0] !== submitted) {
      this.history.unshift(submitted)
      if (this.history.length > HISTORY_LIMIT) this.history.pop()
    }
    this.emit({ kind: 'submit', text: submitted })
    this.setValue('', 0)
  }

  private deleteBackward(): void {
    if (this.cursor === 0) return
    const start = previousBoundary(this.value, this.cursor)
    this.setValue(this.value.slice(0, start) + this.value.slice(this.cursor), start)
  }

  private moveHorizontal(direction: -1 | 1): void {
    const cursor = direction === -1
      ? previousBoundary(this.value, this.cursor)
      : nextBoundary(this.value, this.cursor)
    this.setCursor(cursor)
  }

  private moveVertical(direction: -1 | 1): void {
    const visualLines = this.layout()
    const currentIndex = this.findCursorLine(visualLines)
    const targetIndex = currentIndex + direction
    if (targetIndex < 0 || targetIndex >= visualLines.length) {
      this.navigateHistory(direction)
      return
    }
    const current = visualLines[currentIndex] as VisualLine
    const currentPosition = current.cursorPositions.find(
      position => position.offset === this.cursor,
    ) as CursorPosition
    const currentColumn = currentPosition.column
    this.preferredColumn ??= currentColumn
    this.cursor = offsetAtColumn(
      visualLines[targetIndex] as VisualLine,
      this.preferredColumn,
    )
  }

  private navigateHistory(direction: -1 | 1): void {
    if (this.history.length === 0) return
    const nextIndex = this.historyIndex - direction
    if (nextIndex < -1 || nextIndex >= this.history.length) return
    if (this.historyIndex === -1 && nextIndex >= 0) this.historyDraft = this.value
    this.historyIndex = nextIndex
    const value = nextIndex === -1
      ? this.historyDraft
      : this.history[nextIndex] as string
    this.value = value
    this.cursor = value.length
    this.preferredColumn = undefined
  }

  private moveToLineBoundary(boundary: 'start' | 'end'): void {
    const bounds = lineBounds(this.value, this.cursor)
    this.setCursor(bounds[boundary])
  }

  private deleteToLineBoundary(boundary: 'start' | 'end'): void {
    const bounds = lineBounds(this.value, this.cursor)
    if (boundary === 'start') {
      this.setValue(
        this.value.slice(0, bounds.start) + this.value.slice(this.cursor),
        bounds.start,
      )
    } else {
      this.setValue(
        this.value.slice(0, this.cursor) + this.value.slice(bounds.end),
        this.cursor,
      )
    }
  }

  private deleteWordBackward(): void {
    let start = this.cursor
    while (start > 0 && /\s/u.test(this.value.slice(previousBoundary(this.value, start), start))) {
      start = previousBoundary(this.value, start)
    }
    while (start > 0 && !/\s/u.test(this.value.slice(previousBoundary(this.value, start), start))) {
      start = previousBoundary(this.value, start)
    }
    this.setValue(this.value.slice(0, start) + this.value.slice(this.cursor), start)
  }

  private setValue(value: string, cursor: number): void {
    this.value = value
    this.setCursor(cursor)
    this.historyIndex = -1
  }

  private setCursor(cursor: number): void {
    this.cursor = Math.max(0, Math.min(cursor, this.value.length))
    this.preferredColumn = undefined
  }

  private layout(): VisualLine[] {
    const contentWidth = Math.max(1, this.renderWidth - 3)
    const lines: VisualLine[] = []
    let logicalStart = 0
    for (const logicalLine of this.value.split('\n')) {
      const segments = [...segmenter.segment(logicalLine)]
      if (segments.length === 0) {
        lines.push({
          text: '',
          width: 0,
          cursorPositions: [{
            offset: logicalStart,
            column: 0,
            canonical: true,
          }],
        })
      } else {
        let chunkText = ''
        let chunkWidth = 0
        let cursorPositions: CursorPosition[] = []
        const pushChunk = (): void => {
          lines.push({
            text: chunkText,
            width: chunkWidth,
            cursorPositions,
          })
          chunkText = ''
          chunkWidth = 0
          cursorPositions = []
        }
        for (const segment of segments) {
          const rendered = displayText(segment.segment)
          const width = visibleWidth(rendered)
          const segmentStart = logicalStart + segment.index
          const segmentEnd = segmentStart + segment.segment.length
          if (chunkWidth > 0 && chunkWidth + width > contentWidth) {
            pushChunk()
          }
          if (width > contentWidth && rendered !== segment.segment) {
            let renderedColumn = 0
            while (renderedColumn < width) {
              const text = sliceByColumn(
                rendered,
                renderedColumn,
                contentWidth,
                true,
              )
              const partWidth = visibleWidth(text)
              const partPositions: CursorPosition[] = [{
                offset: segmentStart,
                column: 0,
                canonical: renderedColumn === 0,
              }]
              if (renderedColumn + partWidth === width) {
                partPositions.push({
                  offset: segmentEnd,
                  column: partWidth,
                  canonical: true,
                })
              }
              lines.push({
                text,
                width: partWidth,
                cursorPositions: partPositions,
              })
              renderedColumn += partWidth
            }
            continue
          }
          pushCursorPosition(cursorPositions, segmentStart, chunkWidth)
          chunkText += rendered
          chunkWidth += width
          pushCursorPosition(cursorPositions, segmentEnd, chunkWidth)
        }
        if (chunkText || cursorPositions.length > 0) pushChunk()
      }
      logicalStart += logicalLine.length + 1
    }
    return lines
  }

  private findCursorLine(lines: readonly VisualLine[]): number {
    return lines.findIndex(line => (
      line.cursorPositions.some(position => (
        position.canonical && position.offset === this.cursor
      ))
    ))
  }
}
