import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, listen } from '@/lib/transport'
import { startCommitJob } from './commit-jobs'

const environment = vi.hoisted(() => ({ native: true }))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@/lib/environment', () => ({
  isNativeApp: () => environment.native,
}))

const invokeMock = invoke as ReturnType<typeof vi.fn>
const listenMock = listen as ReturnType<typeof vi.fn>

describe('startCommitJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    environment.native = true
    listenMock.mockResolvedValue(vi.fn())
  })

  it('uses a keepalive HTTP request on web access so backgrounding cannot cancel the start', async () => {
    environment.native = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            id: 'job-web',
            worktreePath: '/repo/worktree',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const sendBeacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeacon,
    })
    invokeMock.mockResolvedValue({
      id: 'job-web',
      worktreePath: '/repo/worktree',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    })

    await startCommitJob(
      { worktreePath: '/repo/worktree', push: true },
      vi.fn()
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commit-jobs',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
      })
    )
    expect(sendBeacon).toHaveBeenCalledWith(
      '/api/commit-jobs',
      expect.any(Blob)
    )
    expect(invokeMock).not.toHaveBeenCalledWith(
      'start_commit_job',
      expect.anything()
    )
    fetchMock.mockRestore()
  })

  it('returns after starting the backend job without waiting for the commit', async () => {
    invokeMock.mockResolvedValueOnce({
      job: {
        id: 'job-1',
        worktreePath: '/repo/worktree',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
    })
    invokeMock.mockResolvedValueOnce({
      id: 'job-1',
      worktreePath: '/repo/worktree',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    })

    const onFinished = vi.fn()
    const job = await startCommitJob(
      { worktreePath: '/repo/worktree', push: false },
      onFinished
    )

    expect(job.status).toBe('running')
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'start_commit_job',
      expect.objectContaining({
        worktreePath: '/repo/worktree',
        push: false,
        jobId: expect.any(String),
      })
    )
    expect(listenMock).toHaveBeenCalledWith(
      'commit-job:updated',
      expect.any(Function)
    )
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_commit_job', {
      jobId: 'job-1',
    })
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('reports a job that completed before its event listener was attached', async () => {
    const completedJob = {
      id: 'job-1',
      worktreePath: '/repo/worktree',
      status: 'completed' as const,
      response: {
        commit_hash: 'abc123',
        message: 'fix: keep commit running',
        pushed: false,
        push_fell_back: false,
        push_permission_denied: false,
      },
      createdAt: 1,
      updatedAt: 2,
    }
    invokeMock
      .mockResolvedValueOnce({ job: { ...completedJob, status: 'running' } })
      .mockResolvedValueOnce(completedJob)

    const onFinished = vi.fn()
    await startCommitJob(
      { worktreePath: '/repo/worktree', push: false },
      onFinished
    )

    expect(onFinished).toHaveBeenCalledWith(completedJob)
  })
})
