import { describe, expect, it } from 'vitest'
import {
  filterSentryIssues,
  hasSentryAccess,
  isSentryAuthError,
} from './sentry'
import type { SentryIssue } from '@/types/sentry'

const issues: SentryIssue[] = [
  {
    id: '123',
    shortId: 'JEAN-42',
    title: 'TypeError: Cannot read properties of undefined',
    culprit: 'src/components/App.tsx in render',
    permalink: 'https://acme.sentry.io/issues/123/',
    level: 'error',
    status: 'unresolved',
    count: '17',
    userCount: 4,
    firstSeen: '2026-07-01T10:00:00Z',
    lastSeen: '2026-07-14T10:00:00Z',
    project: { id: '1', name: 'Jean', slug: 'jean' },
  },
]

describe('filterSentryIssues', () => {
  it('matches issue id, short id, title, and culprit case-insensitively', () => {
    expect(filterSentryIssues(issues, '123')).toEqual(issues)
    expect(filterSentryIssues(issues, 'jean-42')).toEqual(issues)
    expect(filterSentryIssues(issues, 'TYPEERROR')).toEqual(issues)
    expect(filterSentryIssues(issues, 'app.tsx')).toEqual(issues)
    expect(filterSentryIssues(issues, 'missing')).toEqual([])
  })
})

describe('isSentryAuthError', () => {
  it('recognizes missing and invalid Sentry auth token errors', () => {
    expect(
      isSentryAuthError(new Error('No Sentry auth token configured'))
    ).toBe(true)
    expect(isSentryAuthError('Sentry auth token is invalid')).toBe(true)
    expect(
      isSentryAuthError('Sentry auth token is missing the org:read scope')
    ).toBe(true)
    expect(
      isSentryAuthError(
        'Sentry organization membership is disabled because the organization is over its member limit.'
      )
    ).toBe(false)
    expect(isSentryAuthError(new Error('Network unavailable'))).toBe(false)
  })
})

describe('hasSentryAccess', () => {
  const linked = {
    sentry_projects: [{ organization_slug: 'acme', project_slug: 'jean' }],
  }

  it('needs both a token and a linked Sentry project', () => {
    expect(hasSentryAccess(undefined, { sentry_auth_token: 'tok' })).toBe(false)
    expect(hasSentryAccess(linked, { sentry_auth_token: null })).toBe(false)
    expect(hasSentryAccess({}, { sentry_auth_token: 'tok' })).toBe(false)
    expect(
      hasSentryAccess(
        { sentry_projects: [{ organization_slug: ' ', project_slug: 'jean' }] },
        { sentry_auth_token: 'tok' }
      )
    ).toBe(false)
  })

  it('accepts a project token, a global token, or a redacted remote token', () => {
    expect(
      hasSentryAccess({ ...linked, sentry_auth_token: 'tok' }, undefined)
    ).toBe(true)
    expect(hasSentryAccess(linked, { sentry_auth_token: 'tok' })).toBe(true)
    expect(
      hasSentryAccess(linked, {
        sentry_auth_token: null,
        sentry_auth_token_configured: true,
      })
    ).toBe(true)
  })

  it('accepts the legacy organization and project slugs', () => {
    expect(
      hasSentryAccess(
        { sentry_organization_slug: 'acme', sentry_project_slug: 'jean' },
        { sentry_auth_token: 'tok' }
      )
    ).toBe(true)
  })
})
