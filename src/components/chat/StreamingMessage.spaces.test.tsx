import { describe, expect, it } from 'vitest'
import { render } from '@/test/test-utils'
import { StreamingMessage } from './StreamingMessage'

describe('StreamingMessage Grok space preservation', () => {
  it('keeps spaces when content is built from Grok leading-space deltas', () => {
    const chunks = [
      "I'll",
      ' add',
      ' SQ',
      'Lite',
      ' backup',
      ' encryption',
      ' using',
      ' a',
      ' key',
      ' from',
      ' `.',
      'env',
      '`',
      ' (',
      'Bun',
      ' crypto',
      ',',
      ' no',
      ' `',
      'age',
      '`',
      ' dependency',
      ').',
    ]
    let acc = ''
    for (const c of chunks) {
      acc += c
      const { container } = render(
        <StreamingMessage
          sessionId="s1"
          contentBlocks={[{ type: 'text', text: acc }]}
          toolCalls={[]}
          streamingContent={acc}
          onQuestionAnswer={() => undefined}
          onQuestionSkip={() => undefined}
          isQuestionAnswered={() => false}
          getSubmittedAnswers={() => undefined}
          areQuestionsSkipped={() => false}
          onFileClick={() => undefined}
        />
      )
      const text = container.textContent ?? ''
      expect(text.includes("I'lladd")).toBe(false)
      if (acc.includes(' add')) {
        expect(text).toMatch(/I'll\s+add/)
      }
      if (acc.includes('Bun crypto') || (acc.includes('Bun') && acc.includes(' crypto'))) {
        // once we have both
      }
    }
    const { container } = render(
      <StreamingMessage
        sessionId="s1"
        contentBlocks={[{ type: 'text', text: acc }]}
        toolCalls={[]}
        streamingContent={acc}
        onQuestionAnswer={() => undefined}
        onQuestionSkip={() => undefined}
        isQuestionAnswered={() => false}
        getSubmittedAnswers={() => undefined}
        areQuestionsSkipped={() => false}
        onFileClick={() => undefined}
      />
    )
    expect(container.textContent).toContain("I'll add SQLite backup")
    expect(container.textContent).toContain('Bun crypto')
    expect(container.textContent).not.toContain('Buncrypto')
    expect(container.textContent).not.toContain("I'lladd")
  })
})
