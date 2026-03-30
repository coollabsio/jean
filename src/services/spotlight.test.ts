import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { disposeAllWorktreeTerminals } from '@/lib/terminal-instances'
import type { SpotlightStatus } from '@/types/spotlight'
import type { Worktree } from '@/types/projects'
import {
  activateSpotlightWithEffects,
  deactivateSpotlightWithEffects,
  loadSpotlights,
  shouldUseSpotlightShortcut,
  spotlightQueryKeys,
  syncSpotlightWithEffects,
} from './spotlight'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeAllWorktreeTerminals: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

const makeWorktree = (sessionType: Worktree['session_type']): Worktree => ({
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'alpha',
  path: '/tmp/alpha',
  branch: 'alpha',
  created_at: 0,
  session_type: sessionType,
  order: 1,
})

const makeSpotlightStatus = (): SpotlightStatus => ({
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  worktree_path: '/tmp/alpha',
  root_path: '/tmp/root',
  active: true,
  recovery_id: 'worktree-1',
  restore_pending: false,
  last_synced_at: 123,
})

describe('spotlight service helpers', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = createQueryClient()
    vi.clearAllMocks()
  })

  describe('shouldUseSpotlightShortcut', () => {
    it('falls back to run when Spotlight testing is disabled', () => {
      expect(
        shouldUseSpotlightShortcut({
          spotlightTestingEnabled: false,
          spotlightActive: false,
          targetWorktree: makeWorktree('worktree'),
        })
      ).toBe(false)
    })

    it('falls back to run for base sessions', () => {
      expect(
        shouldUseSpotlightShortcut({
          spotlightTestingEnabled: true,
          spotlightActive: false,
          targetWorktree: makeWorktree('base'),
        })
      ).toBe(false)
    })

    it('keeps Spotlight active when already enabled', () => {
      expect(
        shouldUseSpotlightShortcut({
          spotlightTestingEnabled: true,
          spotlightActive: true,
          targetWorktree: makeWorktree('base'),
        })
      ).toBe(true)
    })
  })

  it('loads cached spotlights without fetching again', async () => {
    const cached = [makeSpotlightStatus()]
    queryClient.setQueryData(spotlightQueryKeys.list(), cached)

    const result = await loadSpotlights(queryClient)

    expect(result).toEqual(cached)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('activates Spotlight with terminal disposal and invalidation', async () => {
    const status = makeSpotlightStatus()
    vi.mocked(invoke).mockResolvedValueOnce(status)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const result = await activateSpotlightWithEffects(queryClient, 'worktree-1')

    expect(result).toEqual(status)
    expect(invoke).toHaveBeenCalledWith('activate_spotlight', {
      worktreeId: 'worktree-1',
    })
    expect(disposeAllWorktreeTerminals).toHaveBeenCalledWith('worktree-1')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: spotlightQueryKeys.all,
    })
  })

  it('syncs Spotlight without disposing terminals', async () => {
    const status = makeSpotlightStatus()
    vi.mocked(invoke).mockResolvedValueOnce(status)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const result = await syncSpotlightWithEffects(queryClient, 'worktree-1')

    expect(result).toEqual(status)
    expect(invoke).toHaveBeenCalledWith('sync_spotlight', {
      worktreeId: 'worktree-1',
    })
    expect(disposeAllWorktreeTerminals).not.toHaveBeenCalled()
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: spotlightQueryKeys.all,
    })
  })

  it('deactivates Spotlight with terminal disposal and invalidation', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await deactivateSpotlightWithEffects(queryClient, 'worktree-1')

    expect(invoke).toHaveBeenCalledWith('deactivate_spotlight', {
      worktreeId: 'worktree-1',
    })
    expect(disposeAllWorktreeTerminals).toHaveBeenCalledWith('worktree-1')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: spotlightQueryKeys.all,
    })
  })
})
