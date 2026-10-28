import { describe, expect, it } from 'vitest'
import {
  inlineQuestionAnswer,
  parseInlineNumberedQuestion,
  withoutInlineQuestion,
} from './inline-question-utils'

describe('parseInlineNumberedQuestion', () => {
  it('reads a question in the recap and removes the list from the text', () => {
    const text = [
      '## Recap',
      '',
      'Excalidraw has Select and Hand tools.',
      '',
      'Which mode do you want?',
      '',
      'Reply with a number:',
      '',
      '1. Select + Hand buttons (**my recommendation**)',
      '',
      '2. Strict `Excalidraw` modes',
      '3. Do not add modes',
      '',
      '- Waiting for your choice.',
    ].join('\n')

    expect(parseInlineNumberedQuestion(text)).toEqual({
      question: 'Which mode do you want?',
      options: [
        'Select + Hand buttons (my recommendation)',
        'Strict Excalidraw modes',
        'Do not add modes',
      ],
      rest: [
        '## Recap',
        '',
        'Excalidraw has Select and Hand tools.',
        '',
        '- Waiting for your choice.',
      ].join('\n'),
    })
  })

  it('accepts the cue after the list and on the question line', () => {
    expect(
      parseInlineNumberedQuestion(
        'Steps:\n1. Read\n2. Test\n\nHow next?\n1. Open a PR\n2. Keep working\n\nReply with the number.'
      )
    ).toMatchObject({
      question: 'How next?',
      options: ['Open a PR', 'Keep working'],
    })
    expect(
      parseInlineNumberedQuestion('Which one? Reply with a number:\n1. A\n2. B')
    ).toEqual({
      question: 'Which one?',
      options: ['A', 'B'],
      rest: '',
    })
  })

  it('returns null without a cue next to a valid list', () => {
    expect(
      parseInlineNumberedQuestion('Steps:\n1. Read\n2. Write\n3. Test')
    ).toBeNull()
    expect(
      parseInlineNumberedQuestion(
        'Reply with a number later.\n\nSteps:\n1. Read\n2. Write'
      )
    ).toBeNull()
    expect(
      parseInlineNumberedQuestion('Reply with a number:\n1. Only one')
    ).toBeNull()
    expect(
      parseInlineNumberedQuestion('Reply with a number:\n1. A\n2. A')
    ).toBeNull()
  })
})

describe('inlineQuestionAnswer', () => {
  it('sends the number and the option text', () => {
    expect(inlineQuestionAnswer(['Alpha', 'Beta'], 1)).toBe('2. Beta')
  })
})

describe('withoutInlineQuestion', () => {
  const text = 'Done.\n\nDo you want it?\nReply with a number:\n1. Yes\n2. No'
  const asked = parseInlineNumberedQuestion(text)!

  it('removes the question that the buttons show', () => {
    expect(withoutInlineQuestion(text, asked)).toBe('Done.')
  })

  it('keeps the text when it asks a different question', () => {
    const other = 'Pick one?\nReply with a number:\n1. A\n2. B'
    expect(withoutInlineQuestion(other, asked)).toBe(other)
    expect(withoutInlineQuestion('No question here', asked)).toBe(
      'No question here'
    )
  })
})
