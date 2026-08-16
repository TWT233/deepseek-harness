/**
 * Structured terminal questions for the interactive CLI.
 * @module @deepseek-ai/dsh-cli-app/questions
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { displayText } from './display.ts'
import type {
  RollingTerminalInput,
  RollingTerminalPort,
} from './types.ts'

type ParsedAnswer = Omit<AskUserQuestionAnswerItem, 'id'>

interface ActiveQuestion {
  readonly request: AskUserQuestionRequest
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly answers: AskUserQuestionAnswerItem[]
  index: number
  error?: string
  removeAbort?: () => void
}

function optionLabels(question: AskUserQuestionItem): string[] {
  return (question.options ?? []).map(option => option.label)
}

function selectedLabel(
  raw: string,
  question: AskUserQuestionItem,
  seen?: Set<number>,
): string {
  const index = Number(raw)
  const labels = optionLabels(question)
  if (!Number.isSafeInteger(index) || index < 1 || index > labels.length) {
    throw new Error(
      `option index ${raw} is outside 1-${String(labels.length)}`,
    )
  }
  if (seen?.has(index) === true) {
    throw new Error(`option index ${raw} is selected more than once`)
  }
  seen?.add(index)
  return labels[index - 1] as string
}

/**
 * Parse one single-select terminal answer.
 * @param input - submitted number or custom answer.
 * @param question - question carrying the selectable labels.
 * @returns selected labels and optional custom text.
 */
export function parseSingleAnswer(
  input: string,
  question: AskUserQuestionItem,
): ParsedAnswer {
  const value = input.trim()
  if (/^\d+$/u.test(value)) {
    return { selected: [selectedLabel(value, question)] }
  }
  return {
    selected: [],
    ...value === '' ? {} : { custom: value },
  }
}

/**
 * Parse one multi-select terminal answer.
 * @param input - comma-separated indices with optional custom text after `;`.
 * @param question - question carrying the selectable labels.
 * @returns selected labels and optional custom text.
 */
export function parseMultiAnswer(
  input: string,
  question: AskUserQuestionItem,
): ParsedAnswer {
  const separator = input.indexOf(';')
  const selectionText = (separator === -1 ? input : input.slice(0, separator)).trim()
  const custom = separator === -1 ? '' : input.slice(separator + 1).trim()
  const seen = new Set<number>()
  const selected = selectionText === ''
    ? []
    : selectionText.split(',').map(raw => selectedLabel(raw.trim(), question, seen))
  return {
    selected,
    ...custom === '' ? {} : { custom },
  }
}

function renderQuestion(
  question: AskUserQuestionItem,
  error?: string,
): string[] {
  const lines = [
    ...question.header === undefined ? [] : [question.header],
    question.question,
    ...question.detail === undefined ? [] : [question.detail],
    ...(question.options ?? []).map(
      (option, index) => `${String(index + 1)}. ${option.label}`
        + (option.description === undefined ? '' : ` — ${option.description}`),
    ),
    ...question.multiSelect === true
      ? ['Select comma-separated numbers; add custom text after ";".']
      : [],
    ...error === undefined ? [] : [`Invalid answer: ${error}`],
  ]
  return lines.map(displayText)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('question request aborted')
}

/**
 * One terminal-backed provider bound to the runner's exact Agent.
 *
 * The provider owns at most one active batch. Disposal rejects that batch and
 * permanently refuses later requests.
 */
export class CliQuestionProvider implements UserQuestionProvider {
  private active: ActiveQuestion | undefined
  private disposed = false

  /**
   * Create a provider.
   * @param agent - exact Agent allowed to ask questions.
   * @param terminal - terminal used for question presentation and input state.
   */
  constructor(
    private readonly agent: Agent,
    private readonly terminal: RollingTerminalPort,
  ) {}

  /** @inheritdoc */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (this.disposed) {
      return Promise.reject(new Error('CLI question provider disposed'))
    }
    if (request.agent !== this.agent) {
      return Promise.reject(
        new Error('question request does not belong to the CLI agent'),
      )
    }
    if (this.active !== undefined) {
      return Promise.reject(new Error('another CLI question batch is active'))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(abortError(request.signal))
    }

    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const active: ActiveQuestion = {
        request,
        resolve,
        reject,
        answers: [],
        index: 0,
      }
      if (request.signal !== undefined) {
        const onAbort = (): void => {
          this.rejectActive(abortError(request.signal as AbortSignal))
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        active.removeAbort = () => {
          request.signal?.removeEventListener('abort', onAbort)
        }
      }
      this.active = active
      this.present()
    })
  }

  /**
   * Consume terminal input when a question batch is active.
   * @param input - rolling terminal input.
   * @returns whether the provider consumed the input.
   */
  accept(input: RollingTerminalInput): boolean {
    const active = this.active
    if (active === undefined) return false
    if (input.kind !== 'submit') {
      this.rejectActive(new Error('question cancelled by user'))
      return true
    }

    this.terminal.setInputEnabled(false)
    const question = active.request.questions[active.index] as AskUserQuestionItem
    try {
      const answer = question.multiSelect === true
        ? parseMultiAnswer(input.text, question)
        : parseSingleAnswer(input.text, question)
      active.answers.push({ id: question.id, ...answer })
      active.index += 1
      delete active.error
      if (active.index === active.request.questions.length) {
        const result = { answers: active.answers }
        this.finishActive()
        active.resolve(result)
      } else {
        this.present()
      }
    } catch (error: unknown) {
      active.error = (error as Error).message
      this.present()
    }
    return true
  }

  /** Abort the active request and refuse future requests. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rejectActive(new Error('CLI question provider disposed'))
  }

  private present(): void {
    const active = this.active as ActiveQuestion
    const question = active.request.questions[active.index] as AskUserQuestionItem
    this.terminal.setQuestion(renderQuestion(question, active.error))
    this.terminal.setInputEnabled(true)
  }

  private rejectActive(error: Error): void {
    const active = this.active
    if (active === undefined) return
    this.finishActive()
    active.reject(error)
  }

  private finishActive(): void {
    const active = this.active as ActiveQuestion
    active.removeAbort?.()
    this.active = undefined
    this.terminal.setQuestion(undefined)
    this.terminal.setInputEnabled(true)
  }
}
