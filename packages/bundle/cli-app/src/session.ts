/**
 * Durable CLI Session marker writer and strict resume fold.
 * @module @deepseek-ai/dsh-cli-app/session
 */

import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  APPROVAL_POLICIES,
  setApprovalPolicy,
  type ApprovalPolicy,
} from '@deepseek-ai/dsh-user-approval'
import type { CliSessionMarker } from './types.ts'

/** Current durable CLI Session marker version. */
export const CLI_SESSION_VERSION = 1 as const

/** Whether an untrusted durable value belongs to the closed sandbox vocabulary. */
function isSandboxMode(value: unknown): value is SandboxMode {
  return SANDBOX_MODES.some(mode => mode === value)
}

/** Whether an untrusted durable value belongs to the closed approval vocabulary. */
function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return APPROVAL_POLICIES.some(policy => policy === value)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Identifies an interactive CLI Session and the policies written
     * immediately before this required marker.
     */
    'cli/session': CliSessionMarker
  }
}

/**
 * Append the initial policies followed by the required CLI Session marker.
 * @param session - fresh Session being initialized for the CLI.
 * @param marker - CLI version and execution policies to record.
 * @returns the required `cli/session` event.
 */
export function appendCliSessionMarker(
  session: Session,
  marker: CliSessionMarker,
): SessionEvent<'cli/session'> {
  setSandboxMode(session, marker.sandboxMode)
  setApprovalPolicy(session, marker.approvalPolicy)
  return session.append('cli/session', marker)
}

/**
 * Read and validate the single CLI marker against its preceding policy events.
 * @param events - complete Session log in sequence order.
 * @returns the validated CLI marker.
 * @throws when the log is not a CLI Session or its marker relation is invalid.
 */
export function readCliSessionMarker(events: readonly SessionEvent[]): CliSessionMarker {
  const markers = events.filter(event => event.type === 'cli/session')
  if (markers.length === 0) throw new Error('session is not a CLI session: missing cli/session marker')
  if (markers.length !== 1) {
    throw new Error(`session carries multiple cli/session markers: ${String(markers.length)}`)
  }
  const markerEvent = markers[0] as SessionEvent<'cli/session'>
  const markerData: unknown = markerEvent.data
  if (markerData === null
    || typeof markerData !== 'object'
    || Array.isArray(markerData)
    || Object.getPrototypeOf(markerData) !== Object.prototype) {
    throw new Error('cli/session marker must be a plain object')
  }
  const raw = markerData as {
    version?: unknown
    sandboxMode?: unknown
    approvalPolicy?: unknown
  }
  if (raw.version !== CLI_SESSION_VERSION) {
    throw new Error(`unsupported CLI session version: ${String(raw.version)}`)
  }
  if (!isSandboxMode(raw.sandboxMode)) {
    throw new Error(`unsupported CLI session sandbox mode: ${String(raw.sandboxMode)}`)
  }
  if (!isApprovalPolicy(raw.approvalPolicy)) {
    throw new Error(`unsupported CLI session approval policy: ${String(raw.approvalPolicy)}`)
  }
  let sandboxMode: SandboxMode | undefined
  let approvalPolicy: ApprovalPolicy | undefined
  for (const event of events) {
    if (event.seq >= markerEvent.seq) break
    if (event.type === 'sandbox/mode') sandboxMode = event.data.mode
    if (event.type === 'approval/policy') approvalPolicy = event.data.policy
  }
  if (sandboxMode !== raw.sandboxMode) {
    throw new Error(`cli/session sandbox mode ${raw.sandboxMode} does not match preceding sandbox/mode ${String(sandboxMode)}`)
  }
  if (approvalPolicy !== raw.approvalPolicy) {
    throw new Error(`cli/session approval policy ${raw.approvalPolicy} does not match preceding approval/policy ${String(approvalPolicy)}`)
  }
  return {
    version: CLI_SESSION_VERSION,
    sandboxMode: raw.sandboxMode,
    approvalPolicy: raw.approvalPolicy,
  }
}
