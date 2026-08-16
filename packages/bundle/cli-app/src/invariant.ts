/**
 * Package-owned durable CLI Session marker invariant.
 * @module @deepseek-ai/dsh-cli-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  InvariantFailure,
  InvariantInstaller,
} from '@deepseek-ai/dsh-invariants'
import { readCliSessionMarker } from './session.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-cli-app'

/** Cordis companion plugin name. */
export const name = 'cli-app-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate a marked CLI log while ignoring every log without a marker. */
function validate(events: readonly SessionEvent[], fail: InvariantFailure): void {
  if (!events.some(event => event.type === 'cli/session')) return
  try {
    readCliSessionMarker(events)
  } catch (error: unknown) {
    /* v8 ignore next -- readCliSessionMarker normalizes every rejected relation to Error. */
    fail(error instanceof Error ? error.message : String(error))
  }
}

/** Install loaded-log and pre-append validation for CLI Session markers. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validate(session.events, fail)
  ctx.on('session/created', (session) => {
    validate(session.events, fail)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validate([...session.events, event], fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the CLI application invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
