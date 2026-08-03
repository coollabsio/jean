import { describe, expect, it } from 'vitest'
import { buildFailurePrompt } from './useSendFailureToAgent'
import type { JenkinsFailureReport } from '@/types/jenkins'

function report(partial: Partial<JenkinsFailureReport>): JenkinsFailureReport {
  return {
    pipelineNumber: 7139,
    stage: 'Elm tests',
    downstreamJob: 'elm-tests',
    downstreamNumber: 6377,
    consoleUrl: 'http://jenkins.example.internal/job/elm-tests/6377/console',
    failedTests: [],
    failedTestCount: 0,
    logExcerpt: '',
    ...partial,
  }
}

const context = { branch: 'feat-widget', prId: '4143' }

describe('buildFailurePrompt', () => {
  it('carries the evidence so the agent has nothing to fetch', () => {
    const prompt = buildFailurePrompt(
      report({ logExcerpt: '-- TYPE MISMATCH --\n`elm make` failed' }),
      context
    )
    expect(prompt).toContain('-- TYPE MISMATCH --')
    expect(prompt).toContain('<jenkins-log>')
    expect(prompt).toContain('Stage en échec : Elm tests')
    expect(prompt).toContain('elm-tests #6377')
    expect(prompt).toContain('PR #4143')
    expect(prompt).toContain('feat-widget')
  })

  it('lists failing tests with their messages', () => {
    const prompt = buildFailurePrompt(
      report({
        failedTests: [
          {
            className: 'WidgetRepo',
            name: 'admin sees all widgets',
            message: 'Exceeded timeout of 5000 ms',
          },
        ],
        failedTestCount: 2,
      }),
      context
    )
    expect(prompt).toContain('<failing-tests count="2">')
    expect(prompt).toContain('WidgetRepo :: admin sees all widgets')
    expect(prompt).toContain('Exceeded timeout of 5000 ms')
  })

  it('does not duplicate the name when class and case match', () => {
    const prompt = buildFailurePrompt(
      report({
        failedTests: [{ className: 'same', name: 'same', message: null }],
        failedTestCount: 1,
      }),
      context
    )
    expect(prompt).toContain('- same\n')
    expect(prompt).not.toContain('same :: same')
  })

  it('omits empty sections rather than emitting blank blocks', () => {
    const prompt = buildFailurePrompt(report({}), context)
    expect(prompt).not.toContain('<jenkins-log>')
    expect(prompt).not.toContain('<failing-tests')
  })

  it('caps the log at its tail, where the failure is reported', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const prompt = buildFailurePrompt(report({ logExcerpt: long }), context)
    expect(prompt).toContain('line 299')
    expect(prompt).not.toContain('line 100\n')
  })

  it('tells the agent not to paper over a flaky test', () => {
    const prompt = buildFailurePrompt(report({ logExcerpt: 'boom' }), context)
    expect(prompt).toMatch(/flaky/i)
  })

  it('requires a deterministic fix to be tested, committed and pushed', () => {
    const prompt = buildFailurePrompt(report({ logExcerpt: 'boom' }), context)
    expect(prompt).toMatch(/tests pertinents/i)
    expect(prompt).toMatch(/commit/i)
    expect(prompt).toMatch(/push/i)
    expect(prompt).toMatch(/force-push/i)
  })
})
