/**
 * Replay and live projection of durable Session events into rolling terminal items.
 * @module @deepseek-ai/dsh-cli-app/transcript
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  boundToolLines,
  escapeControls,
  renderContent,
} from './content.ts'
import {
  ToolViewProjector,
  type ProjectedToolView,
} from './tool-view.ts'
import type {
  CliTranscriptConfig,
  RollingTerminalItem,
  RollingTerminalPort,
} from './types.ts'

interface AssistantStream {
  readonly order: number
  readonly blocks: Map<number, ContentBlock>
}

function assistantId(turn: number, step: number): string {
  return `assistant:${turn}:${step}`
}

function assistantCoordinate(turn: number, step: number): string {
  return `${turn}:${step}`
}

function toolId(callId: string): string {
  return `tool:${callId}`
}

function isAppend(event: SessionEvent): boolean {
  return 'surfaceOp' in event && event.surfaceOp === 'append'
}

function chunkBlock(chunk: StreamChunk): {
  index: number
  block: ContentBlock
  replace: boolean
} | undefined {
  switch (chunk.type) {
    case 'text-delta':
      return {
        index: chunk.index,
        block: { type: 'text', text: chunk.text },
        replace: false,
      }
    case 'reasoning-delta':
      return {
        index: chunk.index,
        block: { type: 'reasoning', text: chunk.text },
        replace: false,
      }
    case 'block-end':
      return { index: chunk.index, block: chunk.block, replace: true }
    default:
      return undefined
  }
}

function mergeBlock(current: ContentBlock | undefined, incoming: ContentBlock): ContentBlock {
  if (current?.type === 'text' && incoming.type === 'text') {
    return { type: 'text', text: `${current.text}${incoming.text}` }
  }
  if (current?.type === 'reasoning' && incoming.type === 'reasoning') {
    return { type: 'reasoning', text: `${current.text}${incoming.text}` }
  }
  return incoming
}

function renderTurnNotice(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'error':
      return `Turn failed: ${escapeControls(reason.error.message)} [${escapeControls(reason.error.code)}]`
    case 'aborted':
      return `Turn aborted: ${escapeControls(reason.reason.kind)}`
    case 'max-tokens':
      return 'Turn stopped: maximum output tokens reached'
    case 'completed':
    case 'blocked':
    case 'interrupted':
      return undefined
    default:
      return undefined
  }
}

/** Projects replayed and live Session events into rolling terminal items. */
export class CliTranscriptProjector {
  private readonly tools: ToolViewProjector
  private readonly items = new Map<string, RollingTerminalItem>()
  private readonly assistantStreams = new Map<string, AssistantStream>()
  private replayAssembled = new Set<string>()
  private replayHiddenToolCalls = new Set<string>()

  constructor(
    ctx: Context,
    agent: Agent,
    private readonly terminal: RollingTerminalPort,
    private readonly config: CliTranscriptConfig,
  ) {
    this.tools = new ToolViewProjector(ctx, agent, config)
  }

  /**
   * Rebuild terminal items from one complete durable Session log.
   * @param events - Session events in sequence order.
   */
  replay(events: readonly SessionEvent[]): void {
    this.terminal.clear()
    this.items.clear()
    this.assistantStreams.clear()
    this.tools.clear()
    this.replayAssembled = new Set(events.flatMap(event =>
      event.type === 'assistant/message'
        ? [assistantCoordinate(event.data.turn, event.data.step)]
        : []))
    this.replayHiddenToolCalls = new Set(events.flatMap(event =>
      event.type === 'tool/result' && !isAppend(event)
        ? [event.data.message.source.callId]
        : []))
    for (const event of events) this.apply(event, true)
    this.replayAssembled.clear()
    this.replayHiddenToolCalls.clear()
  }

  /**
   * Apply one newly appended Session event to the live projection.
   * @param event - exact post-commit Session event.
   */
  accept(event: SessionEvent): void {
    this.apply(event, false)
  }

  private upsert(
    id: string,
    order: number,
    settled: boolean,
    lines: readonly string[],
  ): void {
    const existing = this.items.get(id)
    const item = {
      id,
      order: existing?.order ?? order,
      settled,
      lines,
    }
    this.items.set(id, item)
    this.terminal.upsert(item)
  }

  private apply(event: SessionEvent, replaying: boolean): void {
    switch (event.type) {
      case 'assistant/chunk':
        if (replaying && this.replayAssembled.has(
          assistantCoordinate(event.data.turn, event.data.step),
        )) return
        this.acceptAssistantChunk(event)
        return
      case 'assistant/message':
        if (isAppend(event)) this.acceptAssistantMessage(event)
        return
      case 'user/message':
        if (isAppend(event) && event.data.source.kind === 'user') {
          this.upsert(
            `user:${event.seq}`,
            event.seq,
            true,
            renderContent(event.data.content, this.config),
          )
        }
        return
      case 'tool/call':
        if (replaying && this.replayHiddenToolCalls.has(event.data.callId)) {
          this.tools.acceptCall(event.data, event.seq)
          return
        }
        this.acceptToolCall(event)
        return
      case 'tool/result':
        if (isAppend(event)) {
          this.acceptToolResult(event)
        } else {
          const id = toolId(event.data.message.source.callId)
          this.items.delete(id)
          this.terminal.remove(id)
        }
        return
      case 'turn/end': {
        const notice = renderTurnNotice(event.data.reason)
        if (notice !== undefined) {
          this.upsert(`notice:${event.seq}`, event.seq, true, [notice])
        }
        return
      }
      default:
        return
    }
  }

  private acceptAssistantChunk(event: SessionEvent<'assistant/chunk'>): void {
    const projected = chunkBlock(event.data.chunk)
    if (projected === undefined) return
    const id = assistantId(event.data.turn, event.data.step)
    const stream = this.assistantStreams.get(id) ?? {
      order: event.seq,
      blocks: new Map<number, ContentBlock>(),
    }
    stream.blocks.set(
      projected.index,
      projected.replace
        ? projected.block
        : mergeBlock(stream.blocks.get(projected.index), projected.block),
    )
    this.assistantStreams.set(id, stream)
    this.upsert(
      id,
      stream.order,
      false,
      renderContent([...stream.blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block), this.config),
    )
  }

  private acceptAssistantMessage(event: SessionEvent<'assistant/message'>): void {
    const id = assistantId(event.data.turn, event.data.step)
    const stream = this.assistantStreams.get(id)
    this.assistantStreams.delete(id)
    this.upsert(
      id,
      stream?.order ?? event.seq,
      true,
      renderContent(event.data.message.content, this.config),
    )
  }

  private acceptToolCall(event: SessionEvent<'tool/call'>): void {
    const projected = this.tools.acceptCall(event.data, event.seq)
    this.upsert(
      toolId(event.data.callId),
      event.seq,
      false,
      this.bound(projected.lines),
    )
  }

  private acceptToolResult(event: SessionEvent<'tool/result'>): void {
    const [result] = event.data.message.content
    const projected = this.tools.acceptResult({
      callId: event.data.message.source.callId,
      content: result.content,
      isError: result.isError === true,
      ...event.data.meta === undefined ? {} : { meta: event.data.meta },
    })
    const id = toolId(projected.callId)
    const existing = this.items.get(id)
    const lines = existing === undefined || projected.replacesPending
      ? projected.lines
      : this.combineToolLines(existing, projected)
    this.upsert(
      id,
      projected.order ?? event.seq,
      true,
      this.bound(lines),
    )
  }

  private combineToolLines(
    pending: RollingTerminalItem,
    result: ProjectedToolView,
  ): readonly string[] {
    return [...pending.lines, ...result.lines]
  }

  private bound(lines: readonly string[]): readonly string[] {
    return boundToolLines(lines, {
      maxLines: this.config.maxToolOutputLines,
      maxBytes: this.config.maxToolOutputBytes,
    })
  }
}
