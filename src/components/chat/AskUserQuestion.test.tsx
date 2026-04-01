import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import { AskUserQuestion } from './AskUserQuestion'
import type { QuestionAnswer, Question } from '@/types/chat'

describe('AskUserQuestion', () => {
  const questions: Question[] = [
    {
      header: 'Topic',
      question: 'What angle or topic within birds interests you most?',
      multiSelect: false,
      options: [
        {
          label: 'Backyard birding',
          description: 'Personal experiences watching birds at home',
        },
        {
          label: 'Bird photography',
          description: 'Tips around photographing birds',
        },
      ],
    },
    {
      header: 'Tone',
      question: 'What tone should the post have?',
      multiSelect: false,
      options: [
        {
          label: 'Reflective',
          description: 'Deeper thoughts on nature and slowing down',
        },
        {
          label: 'Fun & educational',
          description: 'Light-hearted facts and observations',
        },
      ],
    },
  ]

  const noopSubmit = (_toolCallId: string, _answers: QuestionAnswer[]) =>
    undefined

  it('shows persisted answer labels in the collapsed summary and expanded content', () => {
    render(
      <AskUserQuestion
        toolCallId="tool-1"
        questions={questions}
        onSubmit={noopSubmit}
        readOnly
        submittedAnswers={[
          { questionIndex: 0, selectedOptions: [0] },
          { questionIndex: 1, selectedOptions: [0] },
        ]}
      />
    )

    expect(
      screen.getByText('Backyard birding | Reflective')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByText('Backyard birding | Reflective'))

    expect(
      screen.getByText('Personal experiences watching birds at home')
    ).toBeVisible()
    expect(
      screen.getByText('Deeper thoughts on nature and slowing down')
    ).toBeVisible()
    expect(
      screen.queryByText('Answered (details unavailable)')
    ).not.toBeInTheDocument()
  })

  it('reconstructs answers from persisted tool output when submitted answers are missing', () => {
    render(
      <AskUserQuestion
        toolCallId="tool-1"
        questions={questions}
        onSubmit={noopSubmit}
        readOnly
        hasFollowUpMessage
        toolOutput={JSON.stringify([
          { questionIndex: 0, selectedOptions: [1] },
          { questionIndex: 1, selectedOptions: [1] },
        ])}
      />
    )

    expect(
      screen.getByText('Bird photography | Fun & educational')
    ).toBeInTheDocument()
  })

  it('hides custom text input when the question does not allow other answers', () => {
    render(
      <AskUserQuestion
        toolCallId="tool-1"
        questions={[
          {
            header: 'Choice',
            question: 'Pick one',
            multiSelect: false,
            isOther: false,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ]}
        onSubmit={noopSubmit}
      />
    )

    expect(
      screen.queryByPlaceholderText('Or type your own answer...')
    ).not.toBeInTheDocument()
  })

  it('submits secret custom answers when other answers are allowed', () => {
    const onSubmit = vi.fn()

    render(
      <AskUserQuestion
        toolCallId="tool-1"
        questions={[
          {
            header: 'Token',
            question: 'Paste token',
            multiSelect: false,
            isOther: true,
            isSecret: true,
            options: [],
          },
        ]}
        onSubmit={onSubmit}
      />
    )

    const input = screen.getByPlaceholderText(
      'Or type your own answer...'
    ) as HTMLInputElement
    expect(input.type).toBe('password')

    fireEvent.change(input, { target: { value: 'shhh' } })
    fireEvent.click(screen.getByText('Answer'))

    expect(onSubmit).toHaveBeenCalledWith('tool-1', [
      { questionIndex: 0, selectedOptions: [], customText: 'shhh' },
    ])
  })
})
