import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

/** Startup selection resolved from the interactive CLI command line. */
export interface CliStartupValues {
  readonly resumeSessionId?: SessionId
}

/** Durable CLI Session identity and its recorded execution policies. */
export interface CliSessionMarker {
  readonly version: 1
  readonly sandboxMode: SandboxMode
  readonly approvalPolicy: ApprovalPolicy
}

/** Human input emitted by the rolling terminal editor. */
export type RollingTerminalInput =
  | { readonly kind: 'submit'; readonly text: string }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'eof' }

/** One ordered transcript item retained in the terminal's active region. */
export interface RollingTerminalItem {
  readonly id: string
  /** Sequence of the first Session event that created this item; updates preserve it. */
  readonly order: number
  readonly settled: boolean
  readonly lines: readonly string[]
}

/** Terminal operations consumed by the transcript projector and CLI runner. */
export interface RollingTerminalPort {
  start(onInput: (input: RollingTerminalInput) => void): void
  /**
   * Insert or update an active item. The terminal commits only the lowest-order
   * contiguous settled prefix, so a later settled item waits behind every
   * lower-order active item.
   */
  upsert(item: RollingTerminalItem): void
  remove(id: string): void
  setQuestion(lines: readonly string[] | undefined): void
  setStatus(line: string | undefined): void
  setInputEnabled(enabled: boolean): void
  clear(): void
  stop(): Promise<void>
}

/** Bounds and visibility controls for Session transcript projection. */
export interface CliTranscriptConfig {
  readonly showReasoning: boolean
  readonly maxToolOutputLines: number
  readonly maxToolOutputBytes: number
}

/** Projects replayed and live Session events into rolling terminal items. */
export declare class CliTranscriptProjector {
  constructor(
    ctx: Context,
    agent: Agent,
    terminal: RollingTerminalPort,
    config: CliTranscriptConfig,
  )

  /**
   * Rebuild terminal items from one complete durable Session log.
   * @param events - Session events in sequence order.
   */
  replay(events: readonly SessionEvent[]): void

  /**
   * Apply one newly appended Session event to the live projection.
   * @param event - exact post-commit Session event.
   */
  accept(event: SessionEvent): void
}
