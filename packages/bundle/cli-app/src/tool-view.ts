/**
 * Tool-owned presentation intent rendering and durable call/result pairing.
 * @module @deepseek-ai/dsh-cli-app/tool-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  FileDiff,
  FileLocation,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import {
  type ContentRenderOptions,
  escapeControls,
  renderContent,
} from './content.ts'

/** Durable fields needed to project one tool call. */
export interface ToolCallProjectionInput {
  readonly callId: CallId
  readonly name: string
  readonly arguments: string
}

/** Durable fields needed to project one tool result. */
export interface ToolResultProjectionInput {
  readonly callId: CallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: JsonValue
}

/** Rendered tool lines plus their pending-call ordering anchor. */
export interface ProjectedToolView {
  readonly callId: CallId
  readonly order: number | undefined
  readonly lines: readonly string[]
  readonly replacesPending: boolean
}

interface RetainedCall {
  readonly name: string
  readonly parsedArgs: ParsedArgs
  readonly order: number
}

type ParsedArgs =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

function jsonLines(value: unknown): string[] {
  return escapeControls(JSON.stringify(value, undefined, 2)).split('\n')
}

function valueLines(value: unknown): string[] {
  return typeof value === 'string'
    ? escapeControls(value).split('\n')
    : jsonLines(value)
}

function locationLines(locations: readonly FileLocation[]): string[] {
  return locations.map(location => escapeControls(
    location.line === undefined ? location.path : `${location.path}:${location.line}`,
  ))
}

function diffLines(diffs: readonly FileDiff[]): string[] {
  const lines: string[] = []
  for (const diff of diffs) {
    const path = escapeControls(diff.path)
    lines.push(`--- ${diff.oldText === null ? '/dev/null' : path}`, `+++ ${path}`)
    if (diff.oldText !== null) {
      lines.push(...escapeControls(diff.oldText).split('\n').map(line => `-${line}`))
    }
    lines.push(...escapeControls(diff.newText).split('\n').map(line => `+${line}`))
  }
  return lines
}

function renderGenericCall(
  view: Extract<ToolCallView, { card: 'generic' }>,
  options: ContentRenderOptions,
): string[] {
  return [
    escapeControls(view.title),
    ...view.rawInput === undefined ? [] : valueLines(view.rawInput),
    ...view.content === undefined
      ? []
      : renderContent(view.content, options),
    ...view.locations === undefined ? [] : locationLines(view.locations),
  ]
}

function renderTerminalCall(view: Extract<ToolCallView, { card: 'terminal' }>): string[] {
  const command = view.cwd === undefined
    ? `$ ${escapeControls(view.title)}`
    : `$ (cd ${escapeControls(view.cwd)} && ${escapeControls(view.title)})`
  return [
    ...view.description === undefined ? [] : [escapeControls(view.description)],
    command,
  ]
}

function renderDiffCall(view: Extract<ToolCallView, { card: 'diff' }>): string[] {
  return [escapeControls(view.title), ...diffLines(view.diffs)]
}

/**
 * Render one current call-intent discriminant into terminal lines.
 * @param view - tool-owned call presentation.
 * @param options - content visibility.
 * @returns escaped terminal lines.
 */
export function renderToolCallView(
  view: ToolCallView,
  options: ContentRenderOptions = { showReasoning: true },
): string[] {
  switch (view.card) {
    case 'generic':
      return renderGenericCall(view, options)
    case 'terminal':
      return renderTerminalCall(view)
    case 'diff':
      return renderDiffCall(view)
    default:
      return jsonLines(view)
  }
}

function renderGenericResult(
  view: Extract<ToolResultView, { card: 'generic' }>,
  options: ContentRenderOptions,
): string[] {
  return [
    ...view.title === undefined ? [] : [escapeControls(view.title)],
    ...view.content === undefined
      ? []
      : renderContent(view.content, options),
  ]
}

function renderTerminalResult(view: Extract<ToolResultView, { card: 'terminal' }>): string[] {
  return [
    ...view.title === undefined ? [] : [escapeControls(view.title)],
    ...view.output === undefined ? [] : escapeControls(view.output).split('\n'),
    ...view.exitCode === undefined ? [] : [`[exit code: ${view.exitCode}]`],
    ...view.signal === undefined ? [] : [`[signal: ${escapeControls(view.signal)}]`],
  ]
}

function renderSearchResult(view: Extract<ToolResultView, { card: 'search' }>): string[] {
  const lines = view.shape === 'matches'
    ? view.files.flatMap(file => file.matches.map(match =>
      `${escapeControls(file.path)}:${match.lineNumber}:${escapeControls(match.line)}`))
    : view.paths.map(escapeControls)
  const omitted = Math.max(0, view.total - (
    view.shape === 'matches'
      ? view.files.reduce((count, file) => count + file.matches.length, 0)
      : view.paths.length
  ))
  return [
    ...view.title === undefined ? [] : [escapeControls(view.title)],
    ...lines,
    ...view.truncated
      ? [`… ${omitted} ${omitted === 1
        ? view.shape === 'matches' ? 'match' : 'path'
        : view.shape === 'matches' ? 'matches' : 'paths'} omitted …`]
      : [],
  ]
}

function renderReadResult(view: Extract<ToolResultView, { card: 'read' }>): string[] {
  return [
    ...view.title === undefined ? [] : [escapeControls(view.title)],
    ...view.lines.map(line =>
      `${escapeControls(view.path)}:${line.number}  ${escapeControls(line.text)}`),
    `[showing ${view.lines.length} of ${view.totalLines} lines]`,
  ]
}

function renderWebResult(view: Extract<ToolResultView, { card: 'web' }>): string[] {
  if (view.kind === 'fetch') {
    return [
      ...view.title === undefined ? [] : [escapeControls(view.title)],
      `${escapeControls(view.url)} [${view.statusCode}]${view.truncated ? ' (truncated)' : ''}`,
    ]
  }
  return [
    ...view.title === undefined ? [] : [escapeControls(view.title)],
    ...view.answer === undefined ? [] : escapeControls(view.answer).split('\n'),
    ...view.sources.flatMap(source => [
      source.title === undefined
        ? escapeControls(source.url)
        : `${escapeControls(source.title)} — ${escapeControls(source.url)}`,
      ...source.snippet === undefined ? [] : escapeControls(source.snippet).split('\n'),
    ]),
    ...view.truncated ? ['… additional sources omitted …'] : [],
  ]
}

/**
 * Render one current result-intent discriminant into terminal lines.
 * @param view - tool-owned result presentation.
 * @param options - content visibility.
 * @returns escaped terminal lines.
 */
export function renderToolResultView(
  view: ToolResultView,
  options: ContentRenderOptions = { showReasoning: true },
): string[] {
  switch (view.card) {
    case 'generic':
      return renderGenericResult(view, options)
    case 'terminal':
      return renderTerminalResult(view)
    case 'diff':
      return [
        ...view.title === undefined ? [] : [escapeControls(view.title)],
        ...diffLines(view.diffs),
      ]
    case 'search':
      return renderSearchResult(view)
    case 'read':
      return renderReadResult(view)
    case 'web':
      return renderWebResult(view)
    default:
      return jsonLines(view)
  }
}

function genericCallLines(name: string, raw: string, parsedArgs: ParsedArgs): string[] {
  return [
    escapeControls(name),
    ...(parsedArgs.ok
      ? valueLines(parsedArgs.value)
      : escapeControls(raw).split('\n')),
  ]
}

function genericResultLines(
  input: ToolResultProjectionInput,
  options: ContentRenderOptions,
): string[] {
  return [
    ...renderContent(input.content, options),
    ...input.isError ? ['[tool failed]'] : [],
  ]
}

/**
 * Correlates durable calls/results and invokes tool presenters in Agent scope.
 */
export class ToolViewProjector {
  private readonly calls = new Map<CallId, RetainedCall>()

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly options: ContentRenderOptions = { showReasoning: true },
  ) {}

  /** Forget every retained call before rebuilding a replay. */
  clear(): void {
    this.calls.clear()
  }

  /**
   * Parse, retain, and render one durable tool call.
   * @param input - durable call identity, name, and raw arguments.
   * @param order - sequence of the call event.
   * @returns pending call lines with their ordering anchor.
   */
  acceptCall(input: ToolCallProjectionInput, order: number): ProjectedToolView {
    let parsedArgs: ParsedArgs
    try {
      parsedArgs = { ok: true, value: JSON.parse(input.arguments) }
    } catch {
      parsedArgs = { ok: false }
    }
    const retained = {
      name: input.name,
      parsedArgs,
      order,
    }
    this.calls.set(input.callId, retained)

    let view: ToolCallView | undefined
    if (parsedArgs.ok) {
      try {
        view = this.ctx.tools.get(input.name, this.agent)?.presentCall?.(
          parsedArgs.value,
        )
      } catch {
        view = undefined
      }
    }
    return {
      callId: input.callId,
      order,
      replacesPending: false,
      lines: view === undefined
        ? genericCallLines(input.name, input.arguments, parsedArgs)
        : renderToolCallView(view, this.options),
    }
  }

  /**
   * Pair and render one durable tool result, falling back to raw content.
   * @param input - durable result fields and optional presentation metadata.
   * @returns result lines with the paired call's ordering anchor when available.
   */
  acceptResult(input: ToolResultProjectionInput): ProjectedToolView {
    const call = this.calls.get(input.callId)
    let view: ToolResultView | undefined
    if (call !== undefined && call.parsedArgs.ok) {
      try {
        view = this.ctx.tools.get(call.name, this.agent)?.presentResult?.(
          call.parsedArgs.value,
          {
            content: [...input.content],
            isError: input.isError,
            ...input.meta === undefined ? {} : { meta: input.meta },
          },
        )
      } catch {
        view = undefined
      }
    }
    return {
      callId: input.callId,
      order: call?.order,
      replacesPending: view?.title !== undefined,
      lines: view === undefined
        ? genericResultLines(input, this.options)
        : renderToolResultView(view, this.options),
    }
  }
}
