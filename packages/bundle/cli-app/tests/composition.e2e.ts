/**
 * Shipped CLI bundle over the real Loader tree with only process-owned
 * startup and terminal inputs substituted.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import {
  boot,
  healProfilesModuleFallback,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import type { ModulePhase } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CliApp from '../src/index.ts'
import type {
  RollingTerminalInput,
  RollingTerminalItem,
  RollingTerminalPort,
} from '../src/types.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const appManifest = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
const basePatch = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const cliPatch = join(packageRoot, 'cordis.patch.yml')
const productionTerminalFactory = CliApp.internals.terminalFactory
const roots: string[] = []
const contexts: Context[] = []
const originalDshHome = process.env.DSH_HOME

const policyCases = [
  {
    label: 'shipped full-access policy',
    overlays: [],
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    startupText: 'danger-full-access is active and approval is disabled',
  },
  {
    label: 'higher policy overlay',
    overlays: [
      { id: 'sandbox-policy', config: { mode: 'workspace-write' } },
      { id: 'approval', config: { policy: 'ask' } },
    ],
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    startupText: 'Sandbox mode: workspace-write. Approval policy: ask.',
  },
  {
    label: 'full-access policy with approval questions',
    overlays: [
      { id: 'approval', config: { policy: 'ask' } },
    ],
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'ask',
    startupText: 'danger-full-access is active. Commands and tools can modify any path',
  },
] as const

class FakeTerminal implements RollingTerminalPort {
  readonly items: RollingTerminalItem[] = []

  start(onInput: (input: RollingTerminalInput) => void): void {
    onInput({ kind: 'eof' })
  }

  upsert(item: RollingTerminalItem): void {
    this.items.push(item)
  }

  remove(): void {}
  setQuestion(): void {}
  setStatus(): void {}
  setInputEnabled(): void {}
  clear(): void {}
  async stop(): Promise<void> {}
}

afterEach(async () => {
  CliApp.internals.terminalFactory = productionTerminalFactory
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shipped CLI Loader composition', () => {
  it.each(policyCases)('records the $label in one CLI Session', async ({
    overlays,
    sandboxMode,
    approvalPolicy,
    startupText,
  }) => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: string } } }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    const root = mkdtempSync(join(tmpdir(), 'dsh-cli-composition-'))
    roots.push(root)
    process.env.DSH_HOME = root
    healProfilesModuleFallback(appManifest, root)
    const profileDir = join(root, 'profiles', 'composition')
    mkdirSync(profileDir, { recursive: true })
    const configPath = join(profileDir, 'cordis.yml')
    const startupPath = join(root, 'startup.mjs')
    writeFileSync(configPath, '[]\n')
    writeFileSync(startupPath, [
      "export const name = 'cli-test-startup'",
      'export function apply(ctx) {',
      "  ctx.provide('cliStartup', {})",
      '}',
      '',
    ].join('\n'))

    const sessions: Session[] = []
    const exits: number[] = []
    const terminal = new FakeTerminal()
    CliApp.internals.terminalFactory = () => terminal
    const ctx = await boot('dsh-cli-composition', configPath, [
      ...loadOverlayPatches('dsh-cli-composition', basePatch),
      ...loadOverlayPatches('dsh-cli-composition', cliPatch),
      ...overlays,
      { id: 'cli-startup', disabled: true },
      {
        insert: [{
          id: 'cli-test-startup',
          name: pathToFileURL(startupPath).href,
        }],
      },
    ], (hostCtx) => {
      hostCtx.provide('appExit', code => void exits.push(code))
      hostCtx.on('session/created', session => void sessions.push(session))
      const nativeLoader = hostCtx.loader.internal
      if (nativeLoader === undefined) throw new Error('test requires the Node module loader')
      hostCtx.loader.internal = {
        ...nativeLoader,
        async import(
          specifier: string,
          parentURL: string,
          attributes: Record<string, string>,
          phase?: ModulePhase,
          isEntryPoint?: boolean,
        ): Promise<unknown> {
          if (specifier === '@deepseek-ai/dsh-cli-app') return CliApp
          if (nativeLoader.version === 'v2') {
            return nativeLoader.import(
              specifier,
              parentURL,
              attributes,
              phase,
              isEntryPoint,
            )
          }
          return nativeLoader.import(specifier, parentURL, attributes)
        },
      }
    })
    contexts.push(ctx)

    await vi.waitFor(() => {
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.events.some(event => event.type === 'cli/session')).toBe(true)
      expect(exits).toEqual([0])
    })
    const unsettled = [...ctx.loader.entries()]
      .filter(entry => !entry.disabled
        && (entry.fiber === undefined || entry.fiber.state !== FiberState.ACTIVE))
      .map(entry => entry.options.id ?? entry.options.name)
    expect(unsettled).toEqual([])
    expect(ctx.sandboxPolicy.defaultMode).toBe(sandboxMode)
    expect(ctx.approval.config.policy).toBe(approvalPolicy)
    expect(ctx.get('permissionPresets')).toBeUndefined()
    expect(sessions.flatMap(session => session.events)
      .filter(event => event.type === 'cli/session')
      .map(event => event.data)).toEqual([{
      version: 1,
      sandboxMode,
      approvalPolicy,
    }])
    expect(terminal.items.some(item => item.lines.some(line =>
      line.includes(startupText)))).toBe(true)
  })
})
