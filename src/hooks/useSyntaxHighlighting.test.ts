import { describe, expect, it } from 'vitest'
import { highlightCode } from './useSyntaxHighlighting'

describe('highlightCode', () => {
  it('loads the C# grammar and returns tokenized Shiki markup', async () => {
    const html = await highlightCode(
      'public class Bird {}',
      'csharp',
      'github-light'
    )

    expect(html).toContain('class="shiki github-light"')
    expect(html).toContain('public')
    expect(html).toMatch(/<span style="color:#[A-Fa-f0-9]+">/)
  })
})
