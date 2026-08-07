import { describe, expect, it } from 'vitest'

import {
  estimatePromptOverhead,
  formatOverheadTokens,
  type PromptOverheadInput,
} from './prompt-overhead'

const defaults: PromptOverheadInput = {
  quotaSaverEnabled: false,
  parallelExecutionPromptEnabled: true,
  autoRecapsEnabled: true,
  jeanMcpEnabled: true,
  globalSystemPrompt: null,
  parallelExecutionPrompt: null,
}

describe('estimatePromptOverhead', () => {
  it('reports the shipped defaults as several thousand tokens per request', () => {
    const { totalTokens, rows } = estimatePromptOverhead(defaults)

    expect(totalTokens).toBeGreaterThan(6000)
    expect(rows.map(row => row.label)).toContain('Jean MCP tool schemas')
    expect(rows.map(row => row.label)).toContain('Sub-agent fan-out prompt')
    expect(rows.map(row => row.label)).toContain('Recap instruction')
  })

  it('drops MCP schemas, the recap block and the fan-out prompt under quota saver', () => {
    const saver = estimatePromptOverhead({
      ...defaults,
      quotaSaverEnabled: true,
    })
    const labels = saver.rows.map(row => row.label)

    expect(labels).not.toContain('Jean MCP tool schemas')
    expect(labels).not.toContain('Recap instruction')
    expect(labels).not.toContain('Sub-agent fan-out prompt')
    expect(labels).toContain('Sub-agent policy')
    expect(labels).toContain('Global prompt (lean)')
    expect(saver.totalTokens).toBeLessThan(
      estimatePromptOverhead(defaults).totalTokens - 6000
    )
  })

  it('still charges for the counter-instruction when fan-out is off', () => {
    const { rows } = estimatePromptOverhead({
      ...defaults,
      parallelExecutionPromptEnabled: false,
    })
    const policy = rows.find(row => row.label === 'Sub-agent policy')

    expect(policy?.tokens).toBeGreaterThan(0)
  })

  it('measures a custom global prompt instead of the built-in default', () => {
    const short = estimatePromptOverhead({
      ...defaults,
      globalSystemPrompt: 'Be brief.',
    })
    const long = estimatePromptOverhead({
      ...defaults,
      globalSystemPrompt: 'x'.repeat(40000),
    })

    expect(long.totalTokens).toBeGreaterThan(short.totalTokens + 9000)
  })

  it('treats a blank custom prompt as "use the default"', () => {
    expect(
      estimatePromptOverhead({ ...defaults, globalSystemPrompt: '   ' })
        .totalTokens
    ).toBe(estimatePromptOverhead(defaults).totalTokens)
  })
})

describe('formatOverheadTokens', () => {
  it('groups thousands', () => {
    expect(formatOverheadTokens(7600)).toBe('~7,600')
  })
})
