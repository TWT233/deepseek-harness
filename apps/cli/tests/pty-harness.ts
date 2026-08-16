import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import {
  resolveExampleLaunch,
  type ExampleLaunch,
} from '@deepseek-ai/dsh-loader-smoke'

const POSIX_PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, launch_args_json, launch_env_json, cwd, actions_json, expected_exit, timeout_seconds, columns, rows = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({"COLUMNS": columns, "LINES": rows})
env.pop("COLORTERM", None)
actions = json.loads(actions_json)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(columns), 0, 0))

output = bytearray()
action_index = 0
deadline = time.monotonic() + float(timeout_seconds)
status = None

def read_pty():
    try:
        return os.read(fd, 65536)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        return b""

def drain_pty():
    while True:
        chunk = read_pty()
        if not chunk:
            return
        output.extend(chunk)

while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        chunk = read_pty()
        if chunk:
            output.extend(chunk)
    while action_index < len(actions):
        marker = actions[action_index]["waitFor"].encode()
        if output.count(marker) < actions[action_index].get("occurrence", 1):
            break
        action = actions[action_index]
        if "signal" in action:
            os.kill(pid, getattr(signal, action["signal"]))
        elif "writeFile" in action:
            target = os.path.join(cwd, action["writeFile"]["path"])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(action["writeFile"]["content"])
            if "send" in action:
                os.write(fd, action["send"].encode())
        else:
            os.write(fd, action["send"].encode())
        action_index += 1
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
drain_pty()
sys.stdout.buffer.write(output)
if action_index != len(actions):
    sys.stderr.buffer.write(
        f"completed {action_index}/{len(actions)} PTY actions before timeout\ncaptured bytes:\n".encode()
        + bytes(output)
    )
    sys.exit(124)
actual_exit = os.waitstatus_to_exitcode(status)
if actual_exit != int(expected_exit):
    sys.stderr.buffer.write(
        f"expected exit {expected_exit}, got {actual_exit}\ncaptured bytes:\n".encode()
        + bytes(output)
    )
    sys.exit(125)
`

/** One terminal input, process signal, or workspace mutation performed after its marker renders. */
export type CliPtyAction =
  | {
    readonly waitFor: string
    readonly occurrence?: number
    readonly send: string
  }
  | {
    readonly waitFor: string
    readonly occurrence?: number
    readonly signal: 'SIGTERM'
    readonly windowsBridge: {
      readonly path: string
      readonly content: string
    }
  }
  | {
    readonly waitFor: string
    readonly occurrence?: number
    readonly writeFile: {
      readonly path: string
      readonly content: string
    }
    readonly send?: string
  }

/** How one signal action reaches the child on the selected platform. */
export type CliPtySignalDelivery =
  | { readonly kind: 'process'; readonly signal: 'SIGTERM' }
  | {
    readonly kind: 'marker'
    readonly path: string
    readonly content: string
  }

/** Resolve one signal action without invoking platform-specific process APIs. */
export function resolveCliPtySignalDelivery(
  platform: NodeJS.Platform,
  cwd: string,
  action: Extract<CliPtyAction, { signal: 'SIGTERM' }>,
): CliPtySignalDelivery {
  return platform === 'win32'
    ? {
      kind: 'marker',
      path: join(cwd, action.windowsBridge.path),
      content: action.windowsBridge.content,
    }
    : { kind: 'process', signal: action.signal }
}

/** Inputs for a keyless real-Loader CLI process smoke. */
export interface CliPtySmokeOptions {
  readonly label: string
  readonly tempDirPrefix: string
  readonly binScript: string
  readonly libBinScript?: string
  readonly configArgs?: readonly string[]
  readonly tsconfigPath: string
  readonly actions?: readonly CliPtyAction[]
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly expectedExitCode?: number
  readonly timeoutMs?: number
  readonly cwd?: string
  readonly columns?: number
  readonly rows?: number
  readonly prepare?: (cwd: string) => Promise<void>
  readonly inspect?: (cwd: string) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

async function runPosixPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: CliPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  const result = await execa('python3', [
    '-c',
    POSIX_PTY_DRIVER,
    launch.command,
    JSON.stringify(launch.args),
    JSON.stringify(launch.env),
    cwd,
    JSON.stringify(options.actions ?? []),
    String(options.expectedExitCode ?? 0),
    String(timeoutMs / 1_000),
    String(options.columns ?? 100),
    String(options.rows ?? 30),
  ], {
    stdin: 'ignore',
    timeout: timeoutMs + 5_000,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  if (result.timedOut) {
    throw new Error(
      `${options.label} PTY driver did not exit. stdout:\n${result.stdout}`
      + `\nstderr:\n${result.stderr}`,
    )
  }
  if (result.failed) {
    throw new Error(
      `${options.label} PTY driver exited ${String(result.exitCode)}. stdout:\n`
      + `${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result.stdout
}

async function runWindowsPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: CliPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  const pty = await import('node-pty')
  return await new Promise((resolve, reject) => {
    const actions = options.actions ?? []
    const expectedExitCode = options.expectedExitCode ?? 0
    let output = ''
    let actionIndex = 0
    let timedOut = false
    const terminal = pty.spawn(launch.command, launch.args, {
      name: 'xterm-256color',
      cols: options.columns ?? 100,
      rows: options.rows ?? 30,
      cwd,
      env: definedEnv({
        ...process.env,
        ...launch.env,
        COLORTERM: undefined,
        COLUMNS: String(options.columns ?? 100),
        LINES: String(options.rows ?? 30),
      }),
    })
    const timer = setTimeout(() => {
      timedOut = true
      terminal.kill()
    }, timeoutMs)
    terminal.onData((chunk) => {
      output += chunk
      while (
        actionIndex < actions.length
        && output.split(actions[actionIndex]!.waitFor).length - 1
          >= (actions[actionIndex]!.occurrence ?? 1)
      ) {
        const action = actions[actionIndex]!
        if ('signal' in action) {
          const delivery = resolveCliPtySignalDelivery(
            process.platform,
            cwd,
            action,
          )
          if (delivery.kind === 'process') {
            terminal.kill(delivery.signal)
          } else {
            mkdirSync(dirname(delivery.path), { recursive: true })
            writeFileSync(delivery.path, delivery.content)
          }
        } else if ('writeFile' in action) {
          const target = join(cwd, action.writeFile.path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, action.writeFile.content)
          if (action.send !== undefined) terminal.write(action.send)
        } else {
          terminal.write(action.send)
        }
        actionIndex += 1
      }
    })
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(
          `${options.label} PTY process did not exit before ${String(timeoutMs)}ms.`
          + ` captured bytes:\n${output}`,
        ))
      } else if (actionIndex !== actions.length) {
        reject(new Error(
          `${options.label} completed ${String(actionIndex)}/${String(actions.length)}`
          + ` PTY actions. captured bytes:\n${output}`,
        ))
      } else if (exitCode !== expectedExitCode) {
        reject(new Error(
          `${options.label} expected exit ${String(expectedExitCode)}, got `
          + `${String(exitCode)} (signal ${String(signal)}). captured bytes:\n${output}`,
        ))
      } else {
        resolve(output)
      }
    })
  })
}

/**
 * Boot the shipped CLI in a real pseudo-terminal, drive marker-gated input,
 * and return all captured bytes after the expected process exit.
 * @param options - Launch paths, environment, actions, and expected exit code.
 * @returns Complete pseudo-terminal output.
 */
export async function runCliPtySmoke(
  options: CliPtySmokeOptions,
): Promise<string> {
  const ownedCwd = options.cwd === undefined
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const timeoutMs = options.timeoutMs ?? 25_000
  try {
    await options.prepare?.(cwd)
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      ...options.libBinScript === undefined
        ? {}
        : { libBin: options.libBinScript },
      configArgs: [...options.configArgs ?? []],
      tsconfigPath: options.tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
      },
    })
    const output = process.platform === 'win32'
      ? await runWindowsPtySmoke(launch, cwd, options, timeoutMs)
      : await runPosixPtySmoke(launch, cwd, options, timeoutMs)
    await options.inspect?.(cwd)
    return output
  } finally {
    if (ownedCwd) await rm(cwd, { recursive: true, force: true })
  }
}
