import { describe, expect, it } from 'vitest'

import {
  buildReleaseNotesFromTagSessionPrompt,
  buildReleaseNotesSessionPrompt,
} from './release-notes-prompt'

describe('buildReleaseNotesFromTagSessionPrompt', () => {
  it('asks the session to inspect changes since the selected release and reply with copyable Markdown', () => {
    const prompt = buildReleaseNotesFromTagSessionPrompt('v4.2.0', 'Jean 4.2')

    expect(prompt).toContain('v4.2.0')
    expect(prompt).toContain('Jean 4.2')
    expect(prompt).toContain('git log')
    expect(prompt).toContain('GitHub CLI')
    expect(prompt).toContain('Markdown')
    expect(prompt).toContain('single fenced `markdown` code block')
    expect(prompt).toContain('Create release on GitHub')
    expect(prompt).toContain('/releases/new?')
    expect(prompt).toContain('URL-encode the title and complete Markdown body')
    expect(prompt).toContain('prefix the release version with `v`')
    expect(prompt).toContain('`v0.1.74`')
    expect(prompt).toContain(
      'Do not repeat the app name or release version at the top of the release notes body'
    )
    expect(prompt).toContain(
      'title query parameter must contain that same version-only title'
    )
    expect(prompt).toContain('Do not create or edit a GitHub release')
  })

  it('adds the release title and body contract to a configured magic prompt', () => {
    const prompt = buildReleaseNotesFromTagSessionPrompt(
      'v4.2.0',
      'Jean 4.2',
      'Use this custom style for {tag} ({previous_release_name}).'
    )

    expect(prompt).toContain('Use this custom style for v4.2.0 (Jean 4.2).')
    expect(prompt).toContain('prefix the release version with `v`')
    expect(prompt).toContain(
      'title query parameter must contain that same version-only title'
    )
    expect(prompt).not.toContain('{tag}')
    expect(prompt).not.toContain('{previous_release_name}')
  })
})

describe('buildReleaseNotesSessionPrompt', () => {
  it('interpolates the target PR number', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('PR_NUMBER = 123')
    expect(prompt).toContain('Update PR #123 now.')
  })

  it('requires release-command style branch freshness before gathering data', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('Identify the current branch name')
    expect(prompt).toContain('comparison branch')
    expect(prompt).toContain('git fetch origin')
    expect(prompt).toContain('git pull origin <current-branch>')
    expect(prompt).toContain(
      'git fetch origin <comparison-branch>:<comparison-branch>'
    )
  })

  it('requires merged PR and closing keyword evidence like the release command', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain("commits in this branch that aren't in")
    expect(prompt).toContain('For each commit, check if it is from a merged PR')
    expect(prompt).toContain(
      'For each merged PR, also check its git commit history'
    )
    expect(prompt).toContain('PR descriptions AND commit messages')
    expect(prompt).toContain('close/closes/closed')
    expect(prompt).toContain('fix/fixes/fixed')
    expect(prompt).toContain('resolve/resolves/resolved')
  })

  it('uses the release-command output categories and reference rules while avoiding self refs', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('### Features')
    expect(prompt).toContain('### Fixes')
    expect(prompt).toContain('### Improvements')
    expect(prompt).toContain('### Breaking Changes')
    expect(prompt).toContain('For each line item, show the source PR number')
    expect(prompt).toContain(
      'Do not include the target PR number as a self-reference'
    )
    expect(prompt).toContain('(#234, fixes #456, #789)')
    expect(prompt).toContain('(fixes #456, #789)')
  })
})
