import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { WorktreeCiStatus } from './WorktreeCiStatus'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

const mockUseJenkinsStatusCached = vi.fn()
const mockUseProjects = vi.fn()

vi.mock('@/services/jenkins', () => ({
  useJenkinsStatusCached: (id: string | null) => mockUseJenkinsStatusCached(id),
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => mockUseProjects(),
}))

function statusWith(
  partial: Partial<JenkinsWorktreeStatus>
): JenkinsWorktreeStatus {
  return {
    worktreeId: 'wt-1',
    prId: '42',
    pipeline: {
      number: 7,
      result: 'SUCCESS',
      building: false,
      timestampMs: 0,
      durationMs: 1000,
      url: '',
      prId: '42',
      branch: 'feature',
    },
    stages: [],
    integrationAttempts: [],
    preview: null,
    previewUrl: null,
    previewFreshness: null,
    queue: null,
    overallStatus: 'SUCCESS',
    verdictSource: 'jenkins',
    checkedAt: 0,
    ...partial,
  }
}

const UNCONFIGURED_SENTINEL: JenkinsWorktreeStatus = {
  worktreeId: 'wt-1',
  prId: '42',
  pipeline: null,
  stages: [],
  integrationAttempts: [],
  preview: null,
  previewUrl: null,
  previewFreshness: null,
  queue: null,
  overallStatus: 'UNKNOWN',
  verdictSource: 'none',
  checkedAt: 0,
}

beforeEach(() => {
  mockUseJenkinsStatusCached.mockReset()
  mockUseProjects.mockReset()
  mockUseProjects.mockReturnValue({ data: [] })
})

describe('WorktreeCiStatus', () => {
  it('renders nothing without a PR (the badge lives at the PR level)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    const { container } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId={null} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['SUCCESS', 'CI OK'],
    ['FAILURE', 'CI échec'],
    ['BUILDING', 'CI en cours'],
    ['QUEUED', 'CI en file'],
  ])(
    'labels the %s verdict pill with text (not color alone): "%s"',
    (overallStatus, label) => {
      mockUseJenkinsStatusCached.mockReturnValue({
        data: statusWith({ overallStatus }),
      })
      const { getByText } = render(
        <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
      )
      expect(getByText(label)).toBeInTheDocument()
    }
  )

  it('adds a labelled preview pill when the preview is stale', () => {
    mockUseJenkinsStatusCached.mockReturnValue({
      data: statusWith({
        overallStatus: 'SUCCESS',
        previewUrl: 'https://42.preview.example.com',
        previewFreshness: {
          status: 'STALE',
          previewSha: 'aaa',
          shaSource: 'preview',
          prHeadSha: 'bbb',
          behindBy: 2,
        },
      }),
    })
    const { getByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI OK')).toBeInTheDocument()
    expect(getByText('Preview périmée')).toBeInTheDocument()
  })

  it('shows a single Testable state when CI and preview are both current', () => {
    mockUseJenkinsStatusCached.mockReturnValue({
      data: statusWith({
        overallStatus: 'SUCCESS',
        previewUrl: 'https://42.preview.example.com',
        previewFreshness: {
          status: 'UP_TO_DATE',
          previewSha: 'abc',
          shaSource: 'preview',
          prHeadSha: 'abc',
          behindBy: 0,
        },
      }),
    })
    const { getByText, queryByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('Testable')).toBeInTheDocument()
    expect(queryByText('CI OK')).toBeNull()
    expect(queryByText('Preview à jour')).toBeNull()
  })

  it('shows the "CI non configuré" pill for a PR worktree whose project lacks config', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    mockUseProjects.mockReturnValue({ data: [{ id: 'p1' }] })
    const { getByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI non configuré')).toBeInTheDocument()
  })

  it('renders nothing while configured but not yet polled (no spurious pill)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    mockUseProjects.mockReturnValue({
      data: [{ id: 'p1', jenkins_url: 'https://ci.example.com' }],
    })
    const { container } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the GitHub-sourced verdict when Jenkins kept no build for the PR', () => {
    // Jenkins rotates builds out within hours; the verdict then only exists as
    // a GitHub commit status. The row must still say CI OK, not stay blank.
    mockUseJenkinsStatusCached.mockReturnValue({
      data: statusWith({
        pipeline: null,
        overallStatus: 'SUCCESS',
        verdictSource: 'github',
      }),
    })
    mockUseProjects.mockReturnValue({
      data: [{ id: 'p1', jenkins_url: 'https://ci.example.com' }],
    })
    const { getByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI OK')).toBeInTheDocument()
  })

  it('shows "CI inconnu" once polled with no verdict on either side', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: UNCONFIGURED_SENTINEL })
    mockUseProjects.mockReturnValue({
      data: [{ id: 'p1', jenkins_url: 'https://ci.example.com' }],
    })
    const { getByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI inconnu')).toBeInTheDocument()
  })

  it('renders nothing while the project list is still loading', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: UNCONFIGURED_SENTINEL })
    mockUseProjects.mockReturnValue({ data: [] })
    const { container } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('treats the unconfigured sentinel as "no data" (config pill, no verdict)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: UNCONFIGURED_SENTINEL })
    mockUseProjects.mockReturnValue({ data: [{ id: 'p1' }] })
    const { getByText, queryByText } = render(
      <WorktreeCiStatus projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI non configuré')).toBeInTheDocument()
    expect(queryByText('CI OK')).toBeNull()
  })
})
