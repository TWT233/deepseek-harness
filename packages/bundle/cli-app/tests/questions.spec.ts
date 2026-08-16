import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import {
  CliQuestionProvider,
  parseMultiAnswer,
  parseSingleAnswer,
} from '../src/questions.ts'
import type {
  RollingTerminalInput,
  RollingTerminalItem,
  RollingTerminalPort,
} from '../src/types.ts'

class FakeTerminal implements RollingTerminalPort {
  readonly questions: (readonly string[] | undefined)[] = []
  readonly inputStates: boolean[] = []

  start(_onInput: (input: RollingTerminalInput) => void): void {}
  upsert(_item: RollingTerminalItem): void {}
  remove(_id: string): void {}
  setQuestion(lines: readonly string[] | undefined): void {
    this.questions.push(lines)
  }
  setStatus(_line: string | undefined): void {}
  setInputEnabled(enabled: boolean): void {
    this.inputStates.push(enabled)
  }
  clear(): void {}
  async stop(): Promise<void> {}
}

const question: AskUserQuestionItem = {
  id: 'choice',
  question: 'Choose',
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
}

describe('structured question parsing', () => {
  it('parses single selections and custom answers', () => {
    expect(parseSingleAnswer('2', question)).toEqual({ selected: ['B'] })
    expect(parseSingleAnswer('custom answer', question)).toEqual({
      selected: [],
      custom: 'custom answer',
    })
    expect(parseSingleAnswer('', { id: 'plain', question: 'Answer' }))
      .toEqual({ selected: [] })
  })

  it('parses multiple selections with optional custom text', () => {
    expect(parseMultiAnswer('1,3; extra', question)).toEqual({
      selected: ['A', 'C'],
      custom: 'extra',
    })
    expect(parseMultiAnswer('', question)).toEqual({ selected: [] })
  })

  it('rejects invalid and duplicate option indices', () => {
    expect(() => parseSingleAnswer('4', question)).toThrow(
      'option index 4 is outside 1-3',
    )
    expect(() => parseSingleAnswer('1', {
      id: 'plain',
      question: 'No options',
    })).toThrow('option index 1 is outside 1-0')
    expect(() => parseMultiAnswer('1,1', question)).toThrow(
      'option index 1 is selected more than once',
    )
  })
})

describe('CLI question provider', () => {
  function setup(): {
    terminal: FakeTerminal
    provider: CliQuestionProvider
    agent: Agent
  } {
    const terminal = new FakeTerminal()
    const agent = { id: 'question-agent' } as Agent
    return {
      terminal,
      agent,
      provider: new CliQuestionProvider(agent, terminal),
    }
  }

  function request(
    agent: Agent,
    signal?: AbortSignal,
  ): AskUserQuestionRequest {
    return {
      agent,
      questions: [
        question,
        {
          id: 'many',
          question: 'Choose several',
          detail: 'Multiple values are accepted.',
          options: [{ label: 'X' }, { label: 'Y' }],
          multiSelect: true,
        },
      ],
      ...(signal === undefined ? {} : { signal }),
    }
  }

  it('progresses through a batch and disables input during each transition', async () => {
    const { agent, provider, terminal } = setup()
    const pending = provider.ask(request(agent))

    expect(terminal.questions.at(-1)).toEqual([
      'Choose',
      '1. A',
      '2. B',
      '3. C',
    ])
    expect(terminal.inputStates).toEqual([true])

    expect(provider.accept({ kind: 'submit', text: '2' })).toBe(true)
    expect(terminal.inputStates).toEqual([true, false, true])
    expect(terminal.questions.at(-1)).toEqual([
      'Choose several',
      'Multiple values are accepted.',
      '1. X',
      '2. Y',
      'Select comma-separated numbers; add custom text after ";".',
    ])

    expect(provider.accept({ kind: 'submit', text: '1,2; note' })).toBe(true)
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'choice', selected: ['B'] },
        { id: 'many', selected: ['X', 'Y'], custom: 'note' },
      ],
    })
    expect(terminal.questions.at(-1)).toBeUndefined()
    expect(terminal.inputStates).toEqual([true, false, true, false, true])
  })

  it('keeps the current question active after invalid input', async () => {
    const { agent, provider, terminal } = setup()
    const pending = provider.ask({
      agent,
      questions: [question],
    })

    expect(provider.accept({ kind: 'submit', text: '9' })).toBe(true)
    expect(terminal.questions.at(-1)).toEqual([
      'Choose',
      '1. A',
      '2. B',
      '3. C',
      'Invalid answer: option index 9 is outside 1-3',
    ])
    expect(terminal.inputStates).toEqual([true, false, true])

    provider.accept({ kind: 'submit', text: '1' })
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'choice', selected: ['A'] }],
    })
  })

  it('cancels the active batch from the request signal or interrupt', async () => {
    const signalled = setup()
    const controller = new AbortController()
    const first = signalled.provider.ask(request(signalled.agent, controller.signal))
    controller.abort(new Error('tool stopped'))
    await expect(first).rejects.toThrow('tool stopped')
    expect(signalled.terminal.questions.at(-1)).toBeUndefined()
    expect(signalled.terminal.inputStates.at(-1)).toBe(true)

    const interrupted = setup()
    const second = interrupted.provider.ask(request(interrupted.agent))
    expect(interrupted.provider.accept({ kind: 'interrupt' })).toBe(true)
    await expect(second).rejects.toThrow('question cancelled by user')
    expect(interrupted.provider.accept({ kind: 'eof' })).toBe(false)
  })

  it('rejects another Agent and aborts the active request on disposal', async () => {
    const { agent, provider, terminal } = setup()
    await expect(provider.ask({
      agent: { id: agent.id } as Agent,
      questions: [question],
    })).rejects.toThrow('question request does not belong to the CLI agent')

    const pending = provider.ask(request(agent))
    provider.dispose()
    await expect(pending).rejects.toThrow('CLI question provider disposed')
    expect(terminal.questions.at(-1)).toBeUndefined()
    expect(terminal.inputStates.at(-1)).toBe(true)
    await expect(provider.ask(request(agent))).rejects.toThrow(
      'CLI question provider disposed',
    )
    provider.dispose()
  })

  it('renders headings and option descriptions and rejects concurrent batches', async () => {
    const { agent, provider, terminal } = setup()
    const pending = provider.ask({
      agent,
      questions: [{
        id: 'described',
        header: 'Decision',
        question: 'Choose',
        options: [{ label: 'A', description: 'First option' }],
      }],
    })

    expect(terminal.questions.at(-1)).toEqual([
      'Decision',
      'Choose',
      '1. A — First option',
    ])
    await expect(provider.ask({ agent, questions: [question] }))
      .rejects.toThrow('another CLI question batch is active')
    provider.accept({ kind: 'submit', text: '1' })
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'described', selected: ['A'] }],
    })
  })

  it('rejects already-aborted requests including non-Error abort reasons', async () => {
    const { agent, provider, terminal } = setup()
    const controller = new AbortController()
    controller.abort('stopped')

    await expect(provider.ask({
      agent,
      questions: [question],
      signal: controller.signal,
    })).rejects.toThrow('question request aborted')
    expect(terminal.questions).toEqual([])
  })
})
