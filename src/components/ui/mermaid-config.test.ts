import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'
import { mermaidConfig } from './mermaid-block'

// Uses the real Mermaid config pipeline: diagram directives come from
// untrusted LLM output and must not weaken the locked settings.
describe('mermaidConfig', () => {
  it('locks security settings but keeps harmless diagram options', async () => {
    mermaid.initialize(mermaidConfig(false))
    await mermaid.parse(
      `%%{init: ${JSON.stringify({
        securityLevel: 'loose',
        htmlLabels: true,
        flowchart: { htmlLabels: true, curve: 'step' },
        themeCSS: 'body{display:none}',
        secure: [],
      })}}%%\nflowchart TD\nA-->B`
    )
    const config = mermaid.mermaidAPI.getConfig()
    expect(config.securityLevel).toBe('strict')
    expect(config.htmlLabels).toBe(false)
    expect(config.flowchart?.htmlLabels).toBe(false)
    expect(config.themeCSS).toBeUndefined()
    expect(config.flowchart?.curve).toBe('step')
  })
})
