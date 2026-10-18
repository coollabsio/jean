import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('semantic brand and issue icons', () => {
  const source = readFileSync('src/components/icons/reicon.ts', 'utf8')

  it('maps sync actions to the circular refresh icon', () => {
    expect(source).toContain(
      "export { Refresh as ArrowDownUp } from 'reicon-react'"
    )
    expect(source).not.toContain(
      "export { SortDownUp as ArrowDownUp } from 'reicon-react'"
    )
  })

  it('maps Github to the GitHub brand icon instead of Code', () => {
    expect(source).toContain(
      "export { GithubIcon as Github } from './GithubIcon'"
    )
    expect(source).not.toContain('export { Code as Github }')
  })

  it('maps CircleDot to the issue icon instead of Radio', () => {
    expect(source).toContain(
      "export { IssueIcon as CircleDot } from './IssueIcon'"
    )
    expect(source).not.toContain('export { Radio as CircleDot }')
  })

  it('maps Brain to a brain icon instead of a lightbulb', () => {
    expect(source).toContain("export { BrainIcon as Brain } from './BrainIcon'")
    expect(source).not.toContain('export { LampCharge as Brain }')
  })

  it('maps commit actions to the Git commit icon instead of RecordCircle', () => {
    expect(source).toContain(
      "export { GitCommitIcon as GitCommitHorizontal } from './GitCommitIcon'"
    )
    expect(source).not.toContain(
      "export { RecordCircle as GitCommitHorizontal } from 'reicon-react'"
    )
  })

  it('does not use the voicemail-like RecordCircle icon anywhere', () => {
    expect(source).not.toContain('RecordCircle,')
    expect(source).not.toContain('export { RecordCircle as')
  })

  it('maps CodeRabbit to its official brand mark', () => {
    expect(source).toContain(
      "export { CodeRabbitIcon as Rabbit } from './CodeRabbitIcon'"
    )
    expect(source).not.toContain(
      "export { Speedometer as Rabbit } from 'reicon-react'"
    )
  })

  it('maps Sentry to its official brand mark', () => {
    expect(source).toContain(
      "export { SentryIcon as Sentry } from './SentryIcon'"
    )
  })
})
