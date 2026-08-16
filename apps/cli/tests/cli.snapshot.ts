import { realpathSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  scrubRequestHeaders,
} from '@deepseek-ai/dsh-acp-snapshot'
import { describe, expect, it } from 'vitest'
import { runCliPtySmoke } from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const scriptedConfigPath = fileURLToPath(
  new URL('./fixtures/cli-snapshot.cordis.yml', import.meta.url),
)
const scriptedModelPath = fileURLToPath(
  new URL('./fixtures/cli-scripted-llm.ts', import.meta.url),
)
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const snapshotDir = fileURLToPath(
  new URL('./snapshots/rolling-cli/', import.meta.url),
)
const terminalExpected = join(snapshotDir, 'terminal.expected.txt')
const sessionExpected = join(snapshotDir, 'session.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

const SNAPSHOT_COLUMNS = 100
const SNAPSHOT_ROWS = 30

class TerminalTranscript {
  private readonly screen = Array.from(
    { length: SNAPSHOT_ROWS },
    (): string[] => [],
  )
  private readonly scrollback: string[] = []
  private readonly frames: string[] = []
  private cursorRow = 0
  private cursorColumn = 0
  private previousFrame = ''

  write(input: string): string {
    for (let index = 0; index < input.length;) {
      const char = input[index] as string
      if (char === '\u001B' && input[index + 1] === ']') {
        index = this.skipOsc(input, index + 2)
        continue
      }
      if (char === '\u009D') {
        index = this.skipOsc(input, index + 1)
        continue
      }
      if ((char === '\u001B' && input[index + 1] === '[')
        || char === '\u009B') {
        const start = char === '\u009B' ? index + 1 : index + 2
        const sequence = this.readCsi(input, start)
        if (sequence === undefined) break
        this.applyCsi(sequence.parameters, sequence.final)
        index = sequence.end
        continue
      }
      if (char === '\u001B') {
        index += input[index + 1] === undefined ? 1 : 2
        continue
      }
      if (char === '\r') {
        this.cursorColumn = 0
      } else if (char === '\n') {
        this.lineFeed()
        this.capture()
      } else if (char >= ' ' && char !== '\u007F') {
        this.put(char)
      }
      index += 1
    }
    this.capture()
    return `${this.frames.join('\n')}\n`
  }

  private skipOsc(input: string, start: number): number {
    for (let index = start; index < input.length; index += 1) {
      if (input[index] === '\u0007') return index + 1
      if (input[index] === '\u001B' && input[index + 1] === '\\') {
        return index + 2
      }
    }
    return input.length
  }

  private readCsi(
    input: string,
    start: number,
  ): { parameters: string; final: string; end: number } | undefined {
    for (let index = start; index < input.length; index += 1) {
      const code = input.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7E) {
        return {
          parameters: input.slice(start, index),
          final: input[index] as string,
          end: index + 1,
        }
      }
    }
    return undefined
  }

  private applyCsi(parameters: string, final: string): void {
    const amount = (fallback = 1): number => {
      const parsed = Number.parseInt(parameters, 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - amount())
        return
      case 'B':
        this.cursorRow = Math.min(SNAPSHOT_ROWS - 1, this.cursorRow + amount())
        return
      case 'C':
        this.cursorColumn = Math.min(
          SNAPSHOT_COLUMNS - 1,
          this.cursorColumn + amount(),
        )
        return
      case 'D':
        this.cursorColumn = Math.max(0, this.cursorColumn - amount())
        return
      case 'H':
      case 'f': {
        const [rawRow = '1', rawColumn = '1'] = parameters.split(';')
        this.cursorRow = Math.max(
          0,
          Math.min(SNAPSHOT_ROWS - 1, Number.parseInt(rawRow, 10) - 1 || 0),
        )
        this.cursorColumn = Math.max(
          0,
          Math.min(
            SNAPSHOT_COLUMNS - 1,
            Number.parseInt(rawColumn, 10) - 1 || 0,
          ),
        )
        return
      }
      case 'J':
        if (parameters === '2') {
          for (const line of this.screen) line.length = 0
          this.cursorRow = 0
          this.cursorColumn = 0
        }
        return
      case 'K': {
        const line = this.screen[this.cursorRow] as string[]
        if (parameters === '1') {
          for (let index = 0; index <= this.cursorColumn; index += 1) {
            line[index] = ' '
          }
        } else if (parameters === '2') {
          line.length = 0
        } else {
          line.length = this.cursorColumn
        }
        return
      }
      case 'h':
        if (parameters === '?25') this.capture()
        return
      default:
        return
    }
  }

  private put(char: string): void {
    if (this.cursorColumn >= SNAPSHOT_COLUMNS) {
      this.cursorColumn = 0
      this.lineFeed()
    }
    const line = this.screen[this.cursorRow] as string[]
    line[this.cursorColumn] = char
    this.cursorColumn += 1
  }

  private lineFeed(): void {
    this.cursorRow += 1
    if (this.cursorRow < SNAPSHOT_ROWS) return
    this.scrollback.push(this.renderLine(this.screen.shift() as string[]))
    this.screen.push([])
    this.cursorRow = SNAPSHOT_ROWS - 1
  }

  private renderLine(line: readonly string[]): string {
    let end = line.length
    while (end > 0 && (line[end - 1] ?? ' ') === ' ') end -= 1
    return Array.from({ length: end }, (_, index) => line[index] ?? ' ').join('')
  }

  private capture(): void {
    const lines = [
      ...this.scrollback,
      ...this.screen.map(line => this.renderLine(line)),
    ]
    while (lines.at(-1) === '') lines.pop()
    const rendered = lines.join('\n')
    if (rendered === this.previousFrame) return
    this.previousFrame = rendered
    this.frames.push([
      `=== terminal frame ${String(this.frames.length + 1)} ===`,
      rendered,
    ].join('\n'))
  }
}

function normalizeTerminal(raw: string, cwd: string): string {
  const stable = raw
    .split(`/private${cwd}`).join('{{cwd}}')
    .split(cwd).join('{{cwd}}')
    .replace(
      /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
      '{{sessionId}}',
    )
  return new TerminalTranscript().write(stable)
}

function normalizeSession(raw: string, cwd: string, sessionId: string): string {
  return scrubRequestHeaders(normalizeSessionLog(
    raw,
    { cwd, sessionIds: [sessionId] },
  )).replace(/cmd-[0-9a-f]+-\d+/gu, '{{commandId}}')
}

async function readOnlySession(cwd: string): Promise<{
  content: string
  id: string
}> {
  const root = join(cwd, '.sessions')
  const entries = await readdir(root, { recursive: true })
  const logs = entries.filter(entry => entry.endsWith('.jsonl'))
  if (logs.length !== 1) {
    throw new Error(`expected one CLI Session log under ${root}, found ${logs.length}`)
  }
  const content = await readFile(join(root, logs[0] as string), 'utf8')
  const header = JSON.parse(content.split('\n', 1)[0] as string) as {
    id: string
  }
  return { content, id: header.id }
}

describe('rolling CLI product snapshot', () => {
  it('pins one complete keyless terminal journey and its durable Session', async () => {
    expect(normalizeTerminal(
      'expected\r\nUNEXPECTED DIAGNOSTIC\r\nUNEXPECTED DIAGNOSTIC\r\n',
      '/unused',
    )).toBe([
      '=== terminal frame 1 ===',
      'expected',
      '=== terminal frame 2 ===',
      'expected',
      'UNEXPECTED DIAGNOSTIC',
      '=== terminal frame 3 ===',
      'expected',
      'UNEXPECTED DIAGNOSTIC',
      'UNEXPECTED DIAGNOSTIC',
      '',
    ].join('\n'))

    let normalizedTerminal = ''
    let normalizedSession = ''
    let canonicalCwd = ''
    const output = await runCliPtySmoke({
      label: 'rolling CLI snapshot',
      tempDirPrefix: 'dsh-rolling-cli-snapshot-',
      binScript: dshBinScript,
      configArgs: ['--patch', scriptedConfigPath],
      tsconfigPath,
      columns: 100,
      rows: 30,
      env: {
        DSH_TELEMETRY_DISABLED: '1',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        TERM: 'xterm-256color',
      },
      prepare: async (cwd) => {
        canonicalCwd = realpathSync.native(cwd)
        const fixtureDir = join(cwd, '.dsh', 'profiles', 'tests', 'fixtures')
        await mkdir(fixtureDir, { recursive: true })
        await copyFile(scriptedModelPath, join(fixtureDir, 'cli-scripted-llm.ts'))
        await mkdir(join(cwd, '.sessions'), { recursive: true })
        await writeFile(join(cwd, 'snapshot.txt'), 'before\n')
      },
      actions: [
        {
          waitFor: 'danger-full-access is active',
          send: 'Run the scripted',
        },
        { waitFor: '> Run the scripted', send: '\u001B\rterminal journey\r' },
        {
          waitFor: 'How should the scripted run proceed?',
          send: '1; reviewed\r',
        },
        {
          waitFor: 'Decision received: Safe; reviewed.',
          send: 'Hold for steering.\r',
        },
        {
          waitFor: 'Second turn is waiting for steering.',
          send: 'Steer with this update.\r',
        },
        {
          waitFor: 'Steer with this update.',
          writeFile: {
            path: '.release-steering',
            content: 'release\n',
          },
        },
        {
          waitFor: 'Steering received: Steer with this update.',
          send: '/exit\r',
        },
      ],
      inspect: async (cwd) => {
        const session = await readOnlySession(cwd)
        expect(await readFile(join(cwd, 'snapshot-created.txt'), 'utf8'))
          .toBe('created by the real editor\n')
        normalizedSession = normalizeSession(
          session.content,
          canonicalCwd,
          session.id,
        )
      },
    })
    normalizedTerminal = normalizeTerminal(output, canonicalCwd)

    if (refreshing) {
      await mkdir(snapshotDir, { recursive: true })
      await writeFile(terminalExpected, normalizedTerminal)
      await writeFile(sessionExpected, normalizedSession)
    }
    expect(normalizedTerminal).toBe(await readFile(terminalExpected, 'utf8'))
    expect(normalizedSession).toBe(await readFile(sessionExpected, 'utf8'))
  })
})
