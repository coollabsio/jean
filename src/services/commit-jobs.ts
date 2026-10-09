import { invoke, listen } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { generateId } from '@/lib/uuid'
import type { CommitJob, StartCommitJobResponse } from '@/types/projects'

export interface StartCommitJobArgs {
  [key: string]: unknown
  worktreePath: string
  customPrompt?: string | null
  push: boolean
  remote?: string | null
  prNumber?: number | null
  model?: string
  customProfileName?: string | null
  reasoningEffort?: string | null
  specificFiles?: string[] | null
}

export async function startCommitJob(
  args: StartCommitJobArgs,
  onFinished: (job: CommitJob) => void
): Promise<CommitJob> {
  const jobId = generateId()
  const { job } = isNativeApp()
    ? await invoke<StartCommitJobResponse>('start_commit_job', {
        ...args,
        jobId,
      })
    : await startWebCommitJob(args, jobId)
  let handled = false
  const listener: { stop?: () => void } = {}

  const handleUpdate = (updatedJob: CommitJob | null) => {
    if (!updatedJob || updatedJob.id !== job.id || handled) return
    if (updatedJob.status === 'running') return
    handled = true
    listener.stop?.()
    onFinished(updatedJob)
  }

  listener.stop = await listen<CommitJob>('commit-job:updated', event => {
    handleUpdate(event.payload)
  })
  if (handled) listener.stop()

  const currentJob = await invoke<CommitJob | null>('get_commit_job', {
    jobId: job.id,
  })
  handleUpdate(currentJob)

  return job
}

async function startWebCommitJob(
  args: StartCommitJobArgs,
  jobId: string
): Promise<StartCommitJobResponse> {
  const token = localStorage.getItem('jean-http-token') ?? ''
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  const url = `/api/commit-jobs${query}`
  const body = JSON.stringify({ ...args, jobId })

  // Beacon is specifically designed to be delivered while iOS suspends the
  // page. The keepalive fetch provides the response used by the live UI. Both
  // carry the same idempotency id, so the backend starts at most one job.
  navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
  if (!response.ok) {
    throw new Error((await response.text()) || 'Failed to start commit job')
  }
  return response.json() as Promise<StartCommitJobResponse>
}
