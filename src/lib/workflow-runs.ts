import { useEffect, useState } from 'react'
import type { WorkflowRun } from '@/types/github'

const STORAGE_KEY = 'jean-seen-failed-workflow-runs'
const CHANGE_EVENT = 'jean:seen-failed-workflow-runs-changed'

type SeenRunsStore = Record<string, number[]>

function isBrowserStorageAvailable(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  )
}

function readStore(): SeenRunsStore {
  if (!isBrowserStorageAvailable()) return {}

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [
          key,
          Array.from(
            new Set(
              (value as unknown[]).filter(
                (id): id is number => typeof id === 'number'
              )
            )
          ),
        ])
    )
  } catch {
    return {}
  }
}

function writeStore(store: SeenRunsStore): void {
  if (!isBrowserStorageAvailable()) return

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

export function getWorkflowRunsSeenKey(
  projectPath: string,
  branch?: string | null
): string {
  return `${projectPath}::${branch ?? ''}`
}

export function getSeenFailedWorkflowRunIds(key: string): Set<number> {
  return new Set(readStore()[key] ?? [])
}

export function markFailedWorkflowRunsSeen(key: string, ids: number[]): void {
  const validIds = ids.filter(id => Number.isFinite(id))
  if (validIds.length === 0) return

  const store = readStore()
  store[key] = Array.from(new Set([...(store[key] ?? []), ...validIds]))
  writeStore(store)
}

export function clearSeenFailedWorkflowRuns(key: string): void {
  const store = readStore()
  if (!store[key]?.length) return

  delete store[key]
  writeStore(store)
}

export function isFailedWorkflowRun(run: WorkflowRun): boolean {
  return run.conclusion === 'failure' || run.conclusion === 'startup_failure'
}

export function getLatestFailedRunsByWorkflow(
  runs: WorkflowRun[]
): WorkflowRun[] {
  const seenWorkflows = new Set<string>()
  const failedRuns: WorkflowRun[] = []

  for (const run of runs) {
    if (seenWorkflows.has(run.workflowName)) continue
    seenWorkflows.add(run.workflowName)
    if (isFailedWorkflowRun(run)) failedRuns.push(run)
  }

  return failedRuns
}

export function countVisibleLatestFailedRuns(
  runs: WorkflowRun[],
  seenIds: Set<number>
): number {
  return getLatestFailedRunsByWorkflow(runs).filter(
    run => !seenIds.has(run.databaseId)
  ).length
}

export function useSeenFailedWorkflowRunIds(key: string): Set<number> {
  const [seenIds, setSeenIds] = useState(() => getSeenFailedWorkflowRunIds(key))

  useEffect(() => {
    const updateSeenIds = () => {
      setSeenIds(getSeenFailedWorkflowRunIds(key))
    }

    updateSeenIds()
    return subscribe(updateSeenIds)
  }, [key])

  return seenIds
}
