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

const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
const SHORT_ESCAPE = /\u001B[@-_]/gu

function normalizeTerminal(raw: string, cwd: string): string {
  const plain = raw
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(SHORT_ESCAPE, '')
    .replaceAll('\r', '')
    .split(`/private${cwd}`).join('{{cwd}}')
    .split(cwd).join('{{cwd}}')
    .replace(
      /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
      '{{sessionId}}',
    )
  const visible = [
    'Warning: danger-full-access is active and approval is disabled. Commands and tools can modify any',
    'path available to this process.',
    'Run the scripted',
    'terminal journey',
    'Inspect the workspace, then apply the requested change.',
    'I will run the terminal check first.',
    'Print scripted terminal output',
    '$ printf "CLI_TERMINAL_OUTPUT\\n"',
    'CLI_TERMINAL_OUTPUT',
    '[exit code: 0]',
    'create {{cwd}}/snapshot-created.txt',
    '--- /dev/null',
    '+++ {{cwd}}/snapshot-created.txt',
    '+created by the real editor',
    'Execution mode',
    'How should the scripted run proceed?',
    '1. Safe — Use the reviewed path.',
    '2. Fast — Use the shorter path.',
    'Select comma-separated numbers; add custom text after ";".',
    '> 1; reviewed',
    'Decision received: Safe; reviewed.',
    'Hold for steering.',
    'Second turn is waiting for steering.',
    'Steer with this update.',
    'Steering received: Steer with this update.',
    '> /exit',
  ]
  const normalized: string[] = []
  let searchFrom = 0
  for (const marker of visible) {
    const index = plain.indexOf(marker, searchFrom)
    if (index === -1) continue
    normalized.push(marker)
    searchFrom = index + marker.length
  }
  return `${normalized.join('\n')}\n`
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
          writeFile: {
            path: '.release-steering',
            content: 'release\n',
          },
          send: 'Steer with this update.\r',
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
