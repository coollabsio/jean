import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { invoke, listen, useWsConnectionStatus } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import { logger } from '@/lib/logger'
import { projectsQueryKeys, useProjects } from '@/services/projects'
import { useSendFailureToAgent } from '@/components/mission-control/useSendFailureToAgent'
import type {
  JenkinsFailureReport,
  JenkinsWorktreeStatus,
} from '@/types/jenkins'
import type { Project, Worktree } from '@/types/projects'
import {
  nextRecoveryAction,
  type JenkinsRecoveryRecord,
} from './automatic-recovery'

const emptyRecord = (): JenkinsRecoveryRecord => ({
  lastHandledBuild: null,
  cycleCount: 0,
  sessionId: null,
  lastAutomatedCommit: null,
})

/**
 * Turns new Jenkins failures into agent runs without stealing navigation.
 * State intentionally starts as a baseline after each app start: old failures
 * never trigger retroactive edits or pushes.
 */
export function useAutomaticJenkinsRecovery() {
  const queryClient = useQueryClient()
  const { data: projects = [] } = useProjects()
  const projectsRef = useRef<Project[]>(projects)
  const recordsRef = useRef(new Map<string, JenkinsRecoveryRecord>())
  const initializedRef = useRef(new Set<string>())
  const runningRef = useRef(new Set<string>())
  const sendFailureToAgent = useSendFailureToAgent()
  const wsConnected = useWsConnectionStatus()

  projectsRef.current = projects

  useEffect(() => {
    if (!hasBackendTransport()) return

    let disposed = false
    let unlisten: UnlistenFn | undefined

    void listen<JenkinsWorktreeStatus>('jenkins:status-update', async event => {
      const status = event.payload
      const build = status.pipeline
      const prId = status.prId
      if (!build || !prId) return

      const key = `${status.worktreeId}:${prId}`
      if (
        build.building ||
        !['SUCCESS', 'FAILURE'].includes(status.overallStatus)
      ) {
        // Seeing the in-progress build arms recovery for its terminal result.
        initializedRef.current.add(key)
        return
      }
      const firstObservation = !initializedRef.current.has(key)
      initializedRef.current.add(key)
      const current = recordsRef.current.get(key) ?? emptyRecord()
      const transition = nextRecoveryAction(
        current,
        build.number,
        status.overallStatus,
        firstObservation
      )
      recordsRef.current.set(key, transition.record)

      if (transition.kind === 'intervention') {
        toast.error(`PR #${prId} : intervention requise après 3 corrections`)
        return
      }
      if (transition.kind !== 'recover' || runningRef.current.has(key)) return

      const worktree = queryClient
        .getQueriesData<Worktree[]>({ queryKey: projectsQueryKeys.all })
        .flatMap(([, value]) => (Array.isArray(value) ? value : []))
        .find(item => item.id === status.worktreeId && 'project_id' in item)
      const project = projectsRef.current.find(
        item => item.id === worktree?.project_id
      )
      if (!worktree || !project) {
        logger.warn('Automatic Jenkins recovery: worktree not found', {
          worktreeId: status.worktreeId,
          prId,
        })
        return
      }

      runningRef.current.add(key)
      toast.info(`PR #${prId} : diagnostic automatique démarré`)
      try {
        const report = await invoke<JenkinsFailureReport>(
          'get_jenkins_failure_report',
          {
            projectId: project.id,
            worktreeId: worktree.id,
            buildNumber: build.number,
            prId,
            branch: worktree.branch,
          }
        )
        if (disposed) return
        await sendFailureToAgent({
          project,
          worktree,
          prId,
          report,
          navigate: false,
          reuseMostRecent: true,
        })
      } catch (error) {
        logger.error('Automatic Jenkins recovery failed', { error, prId })
        toast.error(`PR #${prId} : diagnostic automatique impossible`)
      } finally {
        runningRef.current.delete(key)
      }
    }).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [queryClient, sendFailureToAgent, wsConnected])
}
