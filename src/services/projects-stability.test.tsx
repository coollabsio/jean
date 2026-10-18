import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactQuery from '@tanstack/react-query'
import type { Project } from '@/types/projects'

const localProject: Project = {
  id: 'local-project',
  name: 'Local',
  path: '/local',
  default_branch: 'main',
  added_at: 1,
  order: 0,
}
const remoteProject = {
  ...localProject,
  id: 'remote-project',
  key: 'remote:remote-project',
  name: 'Remote',
  path: '/remote',
  serverId: 'remote',
  serverName: 'Remote server',
  offline: false,
  cachedAt: 1,
}
const localResult = { data: [localProject], isSuccess: true }
const remoteResult = { data: [remoteProject], isSuccess: true }

vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>()
  return { ...actual, useQuery: () => localResult }
})
vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
  hasBackendTransport: () => true,
  isNativeApp: () => true,
}))
vi.mock('@/lib/remote-connections', () => ({
  useLocalDashboardEnabled: () => true,
}))
vi.mock('./multi-server-projects', () => ({
  useMultiServerProjects: () => remoteResult,
  toRoutedProjects: (projects: typeof remoteResult.data) => projects,
}))

beforeEach(() => vi.clearAllMocks())

describe('useProjects result stability', () => {
  it('keeps the combined project array stable across unrelated renders', async () => {
    const { useProjects } = await import('./projects')
    const { result, rerender } = renderHook(() => useProjects())
    const first = result.current.data

    rerender()

    expect(result.current.data).toBe(first)
  })
})
