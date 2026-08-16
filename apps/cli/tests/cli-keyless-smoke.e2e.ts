import { realpathSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  resolveCliPtySignalDelivery,
  runCliPtySmoke,
  type CliPtySmokeOptions,
} from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const scriptedConfigPath = fileURLToPath(
  new URL('./fixtures/cli-snapshot.cordis.yml', import.meta.url),
)
const scriptedModelPath = fileURLToPath(
  new URL('./fixtures/cli-scripted-llm.ts', import.meta.url),
)
const invalidProviderPath = fileURLToPath(
  new URL('./fixtures/cli-invalid-provider.cordis.yml', import.meta.url),
)
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

async function seedScriptedModel(home: string): Promise<void> {
  const target = join(home, 'profiles', 'tests', 'fixtures')
  await mkdir(target, { recursive: true })
  await copyFile(scriptedModelPath, join(target, 'cli-scripted-llm.ts'))
}

async function onlySession(root: string): Promise<{
  content: string
  id: string
}> {
  const entries = await readdir(root, { recursive: true })
  const logs = entries.filter(entry => entry.endsWith('.jsonl'))
  if (logs.length !== 1) {
    throw new Error(`expected one Session log under ${root}, found ${logs.length}`)
  }
  const content = await readFile(join(root, logs[0] as string), 'utf8')
  const header = JSON.parse(content.split('\n', 1)[0] as string) as {
    id: string
  }
  return { content, id: header.id }
}

function smoke(
  overrides: Partial<CliPtySmokeOptions> & Pick<CliPtySmokeOptions, 'label'>,
): Promise<string> {
  const prepare = overrides.prepare
  return runCliPtySmoke({
    tempDirPrefix: 'dsh-cli-keyless-',
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
    ...overrides,
    prepare: async (cwd) => {
      const home = overrides.env?.DSH_HOME ?? join(cwd, '.dsh')
      await seedScriptedModel(home)
      await prepare?.(cwd)
    },
  })
}

function expectTerminalRestored(output: string): void {
  expect(output).toContain('\u001B[?2004l')
  expect(output).toContain('\u001B[?25h')
}

describe('rolling CLI keyless PTY lifecycle', () => {
  it('submits an Alt+Enter multiline prompt through the real editor', async () => {
    let session = ''
    const output = await smoke({
      label: 'CLI multiline input',
      actions: [
        { waitFor: 'danger-full-access is active', send: 'Run the scripted' },
        { waitFor: '> Run the scripted', send: '\u001B\rterminal journey\r' },
        {
          waitFor: 'How should the scripted run proceed?',
          send: '1; multiline\r',
        },
        {
          waitFor: 'Decision received: Safe; multiline.',
          send: '/exit\r',
        },
      ],
      inspect: async (cwd) => {
        session = (await onlySession(join(cwd, '.sessions'))).content
      },
    })
    expect(output).toContain('Run the scripted')
    expect(output).toContain('terminal journey')
    expect(session).toContain('Run the scripted\\nterminal journey')
    expectTerminalRestored(output)
  })

  it('turns a running submit into steering for the same turn', async () => {
    const output = await smoke({
      label: 'CLI running steering',
      actions: [
        { waitFor: 'danger-full-access is active', send: 'Hold for steering.\r' },
        {
          waitFor: 'Second turn is waiting for steering.',
          writeFile: { path: '.release-steering', content: 'release\n' },
          send: 'Steer with this update.\r',
        },
        {
          waitFor: 'Steering received: Steer with this update.',
          send: '/exit\r',
        },
      ],
    })
    expect(output).toContain('Second turn is waiting for steering.')
    expect(output).toContain('Steering received: Steer with this update.')
  })

  it('aborts an active turn on first Ctrl+C and exits 130 on the second idle Ctrl+C', async () => {
    const output = await smoke({
      label: 'CLI two-stage Ctrl+C',
      expectedExitCode: 130,
      actions: [
        { waitFor: 'danger-full-access is active', send: 'Hold for interrupt.\r' },
        { waitFor: 'Active turn is waiting for Ctrl+C.', send: '\u0003' },
        { waitFor: 'Turn aborted: user', send: '\u0003' },
      ],
    })
    expect(output).toContain('Turn aborted: user')
    expectTerminalRestored(output)
  })

  it('clears terminal presentation while retaining the completed turn in Session', async () => {
    let session = ''
    const output = await smoke({
      label: 'CLI clear',
      actions: [
        {
          waitFor: 'danger-full-access is active',
          send: 'Steer with this update.\r',
        },
        {
          waitFor: 'Steering received: Steer with this update.',
          send: '/clear\r',
        },
        { waitFor: '\u001B[2J\u001B[H', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        session = (await onlySession(join(cwd, '.sessions'))).content
      },
    })
    expect(output).toContain('\u001B[2J\u001B[H')
    expect(session).toContain('Steer with this update.')
    expect(session).toContain('Steering received: Steer with this update.')
  })

  it('flushes the completed turn before /exit returns zero', async () => {
    let session = ''
    const output = await smoke({
      label: 'CLI graceful exit',
      actions: [
        {
          waitFor: 'danger-full-access is active',
          send: 'Steer with this update.\r',
        },
        {
          waitFor: 'Steering received: Steer with this update.',
          send: '/exit\r',
        },
      ],
      inspect: async (cwd) => {
        session = (await onlySession(join(cwd, '.sessions'))).content
      },
    })
    expect(session).toContain('"type":"turn/end"')
    expectTerminalRestored(output)
  })

  it('resumes the first process Session in the same cwd and replays its transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cli-resume-'))
    try {
      const first = await smoke({
        label: 'CLI resume first process',
        cwd,
        actions: [
          {
            waitFor: 'danger-full-access is active',
            send: 'Steer with this update.\r',
          },
          {
            waitFor: 'Steering received: Steer with this update.',
            send: '/exit\r',
          },
        ],
      })
      const sessionId = /Session ID: (?<id>session-[0-9a-f-]+)/iu.exec(first)
        ?.groups?.id
      expect(sessionId).toBeDefined()
      if (sessionId === undefined) {
        throw new Error('fresh CLI output did not expose its Session ID')
      }
      const resumed = await smoke({
        label: 'CLI resume second process',
        cwd,
        configArgs: [
          '--patch',
          scriptedConfigPath,
          '--resume',
          sessionId,
        ],
        actions: [
          {
            waitFor: 'Steering received: Steer with this update.',
            send: '/exit\r',
          },
        ],
      })
      expect(resumed).toContain('Steer with this update.')
      expect(resumed).toContain('Steering received: Steer with this update.')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a wrong-cwd resume before raw mode and prints the recovery command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cli-wrong-cwd-'))
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    const home = join(root, 'home')
    const sessions = join(root, 'sessions')
    await mkdir(firstCwd)
    await mkdir(secondCwd)
    try {
      let sessionId = ''
      const sharedEnv = {
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(root, 'agents'),
        DSH_CLI_SESSIONS_ROOT: sessions,
        DSH_CLI_SESSION_QUERY_PATH: join(root, 'session-query.db'),
      }
      await smoke({
        label: 'CLI wrong-cwd seed',
        cwd: firstCwd,
        env: sharedEnv,
        actions: [
          {
            waitFor: 'danger-full-access is active',
            send: 'Steer with this update.\r',
          },
          {
            waitFor: 'Steering received: Steer with this update.',
            send: '/exit\r',
          },
        ],
        inspect: async () => {
          sessionId = (await onlySession(sessions)).id
        },
      })
      const rejected = await smoke({
        label: 'CLI wrong-cwd rejection',
        cwd: secondCwd,
        env: sharedEnv,
        configArgs: [
          '--patch',
          scriptedConfigPath,
          '--resume',
          sessionId,
        ],
        expectedExitCode: 1,
      })
      expect(rejected).toContain(
        `resume this session from its recorded workspace: cd '${realpathSync.native(firstCwd)}'`,
      )
      expect(rejected).not.toContain('\u001B[?2004h')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid provider configuration before terminal acquisition', async () => {
    const output = await smoke({
      label: 'CLI invalid provider preflight',
      configArgs: ['--patch', invalidProviderPath],
      expectedExitCode: 1,
      timeoutMs: 35_000,
    })
    expect(output).toContain('agent-default-model')
    expect(output).toContain('provider')
    expect(output).not.toContain('\u001B[?2004h')
    expect(output).not.toContain('\u001B[?25l')
  })

  it('exits zero through bounded tree disposal on SIGTERM', async () => {
    const signalAction = {
      waitFor: 'Active turn is waiting for SIGTERM.',
      signal: 'SIGTERM',
      windowsBridge: {
        path: join('.dsh', 'sigterm'),
        content: 'emit\n',
      },
    } as const
    expect(resolveCliPtySignalDelivery('win32', String.raw`C:\work`, signalAction))
      .toEqual({
        kind: 'marker',
        path: join(String.raw`C:\work`, '.dsh', 'sigterm'),
        content: 'emit\n',
      })
    expect(resolveCliPtySignalDelivery('linux', '/work', signalAction))
      .toEqual({ kind: 'process', signal: 'SIGTERM' })

    const output = await smoke({
      label: 'CLI SIGTERM disposal',
      env: {
        DSH_CLI_SIGTERM_BRIDGE: join('.dsh', 'sigterm'),
        DSH_CLI_PTY_DRAIN_PROBE: '1',
      },
      actions: [
        { waitFor: 'danger-full-access is active', send: 'Hold for SIGTERM.\r' },
        signalAction,
      ],
    })
    expectTerminalRestored(output)
    if (process.platform !== 'win32') {
      expect(output).toContain('PTY_DRAINED_TAIL')
    }
  })
})
