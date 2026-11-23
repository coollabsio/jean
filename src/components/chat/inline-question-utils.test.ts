import { describe, expect, it } from 'vitest'
import {
  inlineQuestionsAnswer,
  parseInlineQuestions,
  withoutInlineQuestions,
} from './inline-question-utils'

describe('parseInlineQuestions', () => {
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

    expect(parseInlineQuestions(text)).toEqual({
      questions: [
        {
          question: 'Which mode do you want?',
          options: [
            'Select + Hand buttons (my recommendation)',
            'Strict Excalidraw modes',
            'Do not add modes',
          ],
          multiple: false,
        },
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
      parseInlineQuestions(
        'Steps:\n1. Read\n2. Test\n\nHow next?\n1. Open a PR\n2. Keep working\n\nReply with the number.'
      )
    ).toMatchObject({
      questions: [
        { question: 'How next?', options: ['Open a PR', 'Keep working'] },
      ],
    })
    expect(
      parseInlineQuestions('Which one? Reply with a number:\n1. A\n2. B')
    ).toEqual({
      questions: [
        { question: 'Which one?', options: ['A', 'B'], multiple: false },
      ],
      rest: '',
    })
  })

  it('returns null without a cue next to a valid list', () => {
    expect(
      parseInlineQuestions('Steps:\n1. Read\n2. Write\n3. Test')
    ).toBeNull()
    expect(
      parseInlineQuestions(
        'Reply with a number later.\n\nSteps:\n1. Read\n2. Write'
      )
    ).toBeNull()
    expect(parseInlineQuestions('Reply with a number:\n1. Only one')).toBeNull()
    expect(parseInlineQuestions('Reply with a number:\n1. A\n2. A')).toBeNull()
  })
})

describe('parseInlineQuestions with several questions', () => {
  const text = [
    'Two choices left.',
    '',
    'Q1: Keep the full command text?',
    'Reply with a number:',
    '1. Hash only',
    '2. Full text',
    '',
    'Q2: Which timeouts?',
    'Reply with one or more numbers:',
    '1. Local',
    '2. Remote',
    '3. None',
  ].join('\n')

  it('reads every question and its pick mode', () => {
    expect(parseInlineQuestions(text)).toEqual({
      questions: [
        {
          question: 'Q1: Keep the full command text?',
          options: ['Hash only', 'Full text'],
          multiple: false,
        },
        {
          question: 'Q2: Which timeouts?',
          options: ['Local', 'Remote', 'None'],
          multiple: true,
        },
      ],
      rest: 'Two choices left.',
    })
  })

  it('answers each question with its picks in order', () => {
    const asked = parseInlineQuestions(text)
    if (!asked) throw new Error('missing fixture')
    expect(inlineQuestionsAnswer(asked.questions, [[1], [1, 0]])).toBe(
      'Q1: Keep the full command text?\n2. Full text\n\nQ2: Which timeouts?\n1. Local\n2. Remote'
    )
  })
})

describe('inlineQuestionsAnswer', () => {
  it('sends the number and the option text', () => {
    expect(
      inlineQuestionsAnswer(
        [{ question: 'Q', options: ['Alpha', 'Beta'], multiple: false }],
        [[1]]
      )
    ).toBe('2. Beta')
  })
})

describe('withoutInlineQuestions', () => {
  const text = 'Done.\n\nDo you want it?\nReply with a number:\n1. Yes\n2. No'
  const asked = parseInlineQuestions(text)
  if (!asked) throw new Error('missing inline question fixture')

  it('removes the question that the buttons show', () => {
    expect(withoutInlineQuestions(text, asked)).toBe('Done.')
  })

  it('keeps the text when it asks a different question', () => {
    const other = 'Pick one?\nReply with a number:\n1. A\n2. B'
    expect(withoutInlineQuestions(other, asked)).toBe(other)
    expect(withoutInlineQuestions('No question here', asked)).toBe(
      'No question here'
    )
  })
})
