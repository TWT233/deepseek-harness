/**
 * The interactive CLI command-line provider booted through a real Loader row.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  CLI_STARTUP_SERVICE,
  type CliStartupValues,
} from '../src/startup.ts'

interface ExitResult {
  readonly exitCode: number
}

const disposers: (() => Promise<void>)[] = []
const fixtureDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Boot the startup provider and return its service or requested exit.
 * @param args - inner command-line arguments supplied by the launcher.
 * @returns the published startup values, or the requested process exit.
 */
async function parseStartup(args: string[]): Promise<CliStartupValues | ExitResult> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-startup-'))
  fixtureDirs.push(dir)
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'cli-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__cliStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: cli-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))

  const exits: number[] = []
  const observing = { write: (_chunk: string) => true }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as { __cliStartupApply: typeof apply }
  globals.__cliStartupApply = apply

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })

  const values = ctx.get(CLI_STARTUP_SERVICE) as CliStartupValues | undefined
  return values ?? { exitCode: exits[0] ?? -1 }
}

describe('CLI command-line provider', () => {
  it('publishes an empty startup selection by default', async () => {
    expect(await parseStartup([])).toEqual({})
  })

  it('brands the requested resume session', async () => {
    expect(await parseStartup(['--resume', 'session-1'])).toEqual({
      resumeSessionId: SessionId('session-1'),
    })
  })

  it('requests a clean exit for help', async () => {
    expect(await parseStartup(['--help'])).toMatchObject({ exitCode: 0 })
  })

  it('rejects an empty resume session id', async () => {
    expect(await parseStartup(['--resume', ''])).toMatchObject({ exitCode: 1 })
  })

  it('rejects unexpected positional input', async () => {
    expect(await parseStartup(['unexpected'])).toMatchObject({ exitCode: 1 })
  })
})
