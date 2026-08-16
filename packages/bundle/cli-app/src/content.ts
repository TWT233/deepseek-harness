/**
 * Safe terminal rendering for model content and bounded tool output.
 * @module @deepseek-ai/dsh-cli-app/content
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

const encoder = new TextEncoder()
const DIM = '\u001b[2m'
const DIM_END = '\u001b[22m'

/** Content visibility options shared by message and tool rendering. */
export interface ContentRenderOptions {
  readonly showReasoning: boolean
}

/** Complete limits applied to rendered tool output. */
export interface ToolLineBounds {
  readonly maxLines: number
  readonly maxBytes: number
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

function splitLines(text: string): string[] {
  return text.split('\n')
}

function retainHeadTail(
  text: string,
  headBytes: number,
  tailBytes: number,
): ReturnType<TextRetainer['finish']> {
  const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
  retainer.push(text)
  return retainer.finish()
}

function jsonLines(value: unknown): string[] {
  return splitLines(escapeControls(JSON.stringify(value, undefined, 2)))
}

/**
 * Replace terminal-active C0/C1 controls with visible hexadecimal text.
 * @param text - untrusted terminal text.
 * @returns text safe to render while preserving line feeds.
 */
export function escapeControls(text: string): string {
  let escaped = ''
  for (const character of text) {
    const code = character.codePointAt(0) as number
    const control = code <= 0x1f || code >= 0x7f && code <= 0x9f
    escaped += control && code !== 0x0a
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : character
  }
  return escaped
}

/**
 * Render provider-neutral content blocks into terminal lines.
 * @param content - content blocks in model order.
 * @param options - reasoning visibility.
 * @returns escaped terminal lines.
 */
export function renderContent(
  content: readonly ContentBlock[],
  options: ContentRenderOptions,
): string[] {
  const lines: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        lines.push(...splitLines(escapeControls(block.text)))
        break
      case 'reasoning':
        if (options.showReasoning) {
          lines.push(...splitLines(escapeControls(block.text)).map(line => `${DIM}${line}${DIM_END}`))
        }
        break
      case 'image':
        lines.push('[image unsupported in terminal]')
        break
      case 'tool-call':
        break
      case 'tool-result':
        lines.push(...renderContent(block.content, options))
        break
      default:
        lines.push(...jsonLines(block))
    }
  }
  return lines
}

function lineNotice(count: number): string {
  return `… ${count} lines omitted …`
}

function applyLineBound(lines: readonly string[], maxLines: number): string[] {
  if (maxLines === 0) return []
  if (lines.length <= maxLines) return [...lines]
  if (maxLines === 1) return [lineNotice(lines.length)]

  const headCount = Math.floor((maxLines - 1) / 2)
  const tailCount = maxLines - 1 - headCount
  const omitted = lines.length - headCount - tailCount
  return [
    ...lines.slice(0, headCount),
    lineNotice(omitted),
    ...lines.slice(lines.length - tailCount),
  ]
}

function applyByteBound(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  if (maxBytes === 0) return ''

  let notice = '… bytes omitted …'
  let retained = ''
  for (let iteration = 0; iteration < 4; iteration++) {
    const separatorBytes = 1
    const available = Math.max(0, maxBytes - byteLength(notice) - separatorBytes)
    const headBytes = Math.ceil(available / 2)
    const tailBytes = available - headBytes
    const result = retainHeadTail(text, headBytes, tailBytes)
    retained = result.text
    /* v8 ignore next -- oversized complete input makes headTail omission exact. */
    const omitted = result.omittedBytes.kind === 'exact'
      ? result.omittedBytes.count
      : 0
    const nextNotice = `… ${omitted} bytes omitted …`
    if (nextNotice === notice) break
    notice = nextNotice
  }

  const complete = retained === '' ? notice : `${retained}\n${notice}`
  return byteLength(complete) <= maxBytes
    ? complete
    : retainHeadTail(complete, maxBytes, 0).text
}

/**
 * Apply CLI-owned line and UTF-8 byte limits to complete tool output.
 * @param lines - escaped rendered lines.
 * @param bounds - final line and byte caps.
 * @returns output satisfying both caps.
 */
export function boundToolLines(
  lines: readonly string[],
  bounds: ToolLineBounds,
): string[] {
  const lineBounded = applyLineBound(lines, bounds.maxLines)
  if (lineBounded.length === 0) return []
  const byteBounded = splitLines(applyByteBound(lineBounded.join('\n'), bounds.maxBytes))
  return splitLines(applyByteBound(
    applyLineBound(byteBounded, bounds.maxLines).join('\n'),
    bounds.maxBytes,
  ))
}
