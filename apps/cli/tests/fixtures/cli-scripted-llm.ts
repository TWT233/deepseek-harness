import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const PROVIDER = 'cli-scripted'
const MODEL = 'cli-scripted-model'
const BASH_CALL = CallId('call-cli-bash')
const EDIT_CALL = CallId('call-cli-edit')
const QUESTION_CALL = CallId('call-cli-question')
const RELEASE_FILE = '.release-steering'

function trailingText(options: GenerateOptions): string {
  const texts: string[] = []
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message?.role !== 'user') break
    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text)
    }
  }
  return texts.join('\n')
}

function latestToolResult(options: GenerateOptions): {
  id: CallId
  text: string
} | undefined {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message?.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      return {
        id: block.toolCallId,
        text: block.content
          .flatMap(content => content.type === 'text' ? [content.text] : [])
          .join(''),
      }
    }
  }
  return undefined
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    {
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: text.length },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(
  id: CallId,
  name: string,
  args: Record<string, unknown>,
): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id,
      name,
      argumentsDelta: argumentsJson,
    },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id,
        name,
        arguments: argumentsJson,
      },
    },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function waitForSteeringRelease(signal?: AbortSignal): Promise<void> {
  const path = join(process.cwd(), RELEASE_FILE)
  for (let attempt = 0; attempt < 500; attempt += 1) {
    signal?.throwIfAborted()
    try {
      await access(path)
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`scripted CLI steering release did not appear at ${path}`)
}

/** Network-free adapter for the shipped CLI product acceptance journeys. */
class ScriptedCliAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: MODEL, name: 'Scripted CLI' }])
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Scripted CLI',
      context: { contextWindow: 128_000 },
    })
  }

  override async * stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER || options.model !== MODEL) {
      throw new Error('scripted CLI fixture received the wrong model route')
    }
    const userText = trailingText(options)
    const result = latestToolResult(options)

    if (userText.includes('Hold for interrupt.')) {
      for (const chunk of textChunks('Active turn is waiting for Ctrl+C.')) {
        if (chunk.type === 'finish') {
          await waitForSteeringRelease(options.signal)
        }
        yield chunk
      }
      return
    }
    if (userText.includes('Hold for SIGTERM.')) {
      for (const chunk of textChunks('Active turn is waiting for SIGTERM.')) {
        if (chunk.type === 'finish') {
          await waitForSteeringRelease(options.signal)
        }
        yield chunk
      }
      return
    }
    if (userText.includes('Steer with this update.')) {
      yield * textChunks('Steering received: Steer with this update.')
      return
    }
    if (userText.includes('Hold for steering.')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'text-delta',
        index: 0,
        text: 'Second turn is waiting for steering.',
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: 'Second turn is waiting for steering.',
        },
      }
      await waitForSteeringRelease(options.signal)
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (result?.id === QUESTION_CALL) {
      const answer = JSON.parse(result.text) as {
        answers: Array<{
          selected: string[]
          custom?: string
        }>
      }
      const selected = answer.answers[0]?.selected.join(', ') ?? ''
      const custom = answer.answers[0]?.custom
      yield * textChunks(
        `Decision received: ${selected}${custom === undefined ? '' : `; ${custom}`}.`,
      )
      return
    }
    if (result?.id === EDIT_CALL) {
      yield * toolChunks(QUESTION_CALL, 'ask_user_question', {
        questions: [{
          id: 'mode',
          header: 'Execution mode',
          question: 'How should the scripted run proceed?',
          multi_select: true,
          options: [
            {
              label: 'Safe',
              description: 'Use the reviewed path.',
            },
            {
              label: 'Fast',
              description: 'Use the shorter path.',
            },
          ],
        }],
      })
      return
    }
    if (result?.id === BASH_CALL) {
      yield * toolChunks(EDIT_CALL, 'str_replace_editor', {
        command: 'create',
        path: join(process.cwd(), 'snapshot-created.txt'),
        file_text: 'created by the real editor\n',
      })
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield {
      type: 'reasoning-delta',
      index: 0,
      text: 'Inspect the workspace, then apply the requested change.',
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'reasoning',
        text: 'Inspect the workspace, then apply the requested change.',
      },
    }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield {
      type: 'text-delta',
      index: 1,
      text: 'I will run the terminal check first.',
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'text',
        text: 'I will run the terminal check first.',
      },
    }
    const bashArgs = JSON.stringify({
      command: 'printf "CLI_TERMINAL_OUTPUT\\n"',
      description: 'Print scripted terminal output',
    })
    yield { type: 'block-start', index: 2, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 2,
      id: BASH_CALL,
      name: 'bash',
      argumentsDelta: bashArgs,
    }
    yield {
      type: 'block-end',
      index: 2,
      block: {
        type: 'tool-call',
        id: BASH_CALL,
        name: 'bash',
        arguments: bashArgs,
      },
    }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'cli-scripted-llm'
export const inject = ['llm']

/** Register the scripted adapter used by real-PTY CLI acceptance. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], new ScriptedCliAdapter())
}
