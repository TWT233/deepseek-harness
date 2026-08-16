/**
 * Interactive CLI command-line parsing and startup selection.
 * @module @deepseek-ai/dsh-cli-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'cli-startup'

/** Launcher command-line service required before parsing. */
export const inject = ['cmdlineArgs']

/** Service provided to the interactive CLI runner. */
export const CLI_STARTUP_SERVICE = 'cliStartup'

/** Startup selection resolved from the interactive CLI command line. */
export interface CliStartupValues {
  /** Existing CLI Session requested for resume. */
  readonly resumeSessionId?: SessionId
}

/**
 * Parse the interactive CLI command line and publish its startup selection.
 * Help and usage errors request process exit without publishing the service.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile cli')
    .description('Run the interactive DeepSeek Harness terminal agent.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'resume one CLI session in its recorded workspace')
  program.action((options: { resume?: string }) => {
    if (options.resume === '') program.error('error: --resume needs a session id')
    ctx.provide(CLI_STARTUP_SERVICE, {
      ...(options.resume === undefined ? {} : { resumeSessionId: SessionId(options.resume) }),
    } satisfies CliStartupValues)
  })
  parseCmdline(ctx, program)
}
