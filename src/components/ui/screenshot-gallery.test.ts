import { describe, expect, it } from 'vitest'
import { extractScreenshotBlocks } from './screenshot-gallery'

describe('extractScreenshotBlocks', () => {
  it('removes every screenshots block and keeps other code blocks', () => {
    const markdown = [
      'Before.',
      '```screenshots',
      '- `/tmp/a.png`',
      '```',
      '```ts',
      'const a = 1',
      '```',
      '~~~screenshots',
      '![b](/tmp/b.png)',
      '~~~',
      'After.',
    ].join('\n')

    expect(extractScreenshotBlocks(markdown)).toEqual({
      text: 'Before.\n```ts\nconst a = 1\n```\nAfter.',
      paths: ['/tmp/a.png', '/tmp/b.png'],
    })
  })

  it('returns the text unchanged when there is no screenshots block', () => {
    expect(extractScreenshotBlocks('Plain `screenshots` text')).toEqual({
      text: 'Plain `screenshots` text',
      paths: [],
    })
  })
})
