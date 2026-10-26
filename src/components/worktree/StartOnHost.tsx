import { useCallback, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { isNativeApp } from '@/lib/environment'
import { useRemoteConnections } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import {
  isStartOnHostCancelled,
  progressUpdateFromEvent,
  startProjectOnHost,
  type EnsureProgressEvent,
  type EnvCopyOffer,
} from '@/lib/start-on-host'
import { invokeForServer, listen } from '@/lib/transport'
import type { Project } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { useQueryClient } from '@tanstack/react-query'
import { invalidateProjectLists } from '@/services/projects'

type PromptPhase = 'idle' | 'preparing' | 'confirm-env' | 'copying' | 'error'

interface PromptState {
  phase: PromptPhase
  message: string | null
  error: string | null
  offer: EnvCopyOffer | null
  /** 0–100 when known. `null` draws an indeterminate bar. */
  percent: number | null
}

const idlePrompt: PromptState = {
  phase: 'idle',
  message: null,
  error: null,
  offer: null,
  percent: null,
}

let promptState: PromptState = idlePrompt
const promptListeners = new Set<() => void>()
let envDecision: ((decision: 'copy' | 'skip' | 'cancel') => void) | null = null
let startCancelled = false

function setPrompt(next: PromptState) {
  promptState = next
  for (const listener of promptListeners) listener()
}

function subscribePrompt(listener: () => void) {
  promptListeners.add(listener)
  return () => promptListeners.delete(listener)
}

export function useStartOnHostPromptState(): PromptState {
  return useSyncExternalStore(
    subscribePrompt,
    () => promptState,
    () => promptState
  )
}

export function cancelStartOnHost() {
  startCancelled = true
  envDecision?.('cancel')
  envDecision = null
  setPrompt(idlePrompt)
}

export function acceptEnvCopy() {
  envDecision?.('copy')
  envDecision = null
}

export function skipEnvCopy() {
  envDecision?.('skip')
  envDecision = null
}

interface StartOnHostPickerProps {
  value: string
  onChange: (serverId: string) => void
  disabled?: boolean
}

export function StartOnHostPicker({
  value,
  onChange,
  disabled,
}: StartOnHostPickerProps) {
  const connections = useRemoteConnections()
  const snapshots = useServerConnectionSnapshots()
  if (!isNativeApp()) return null

  const remotes = connections.filter(connection => connection.enabled !== false)
  if (remotes.length === 0) return null

  const options = [
    { id: LOCAL_SERVER_ID, name: 'Local', detail: null as string | null },
    ...remotes.map(connection => {
      const status = snapshots.get(connection.id)?.status
      const detail =
        status && status !== 'online' && status !== 'local' ? status : null
      return { id: connection.id, name: connection.name, detail }
    }),
  ]

  return (
    <div className="space-y-1">
      <label htmlFor="start-on-host" className="text-xs font-medium">
        Start on
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id="start-on-host"
          className="w-full"
          aria-label="Start on"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.id} value={option.id}>
              {option.detail
                ? `${option.name} (${option.detail})`
                : option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function useStartOnHost(
  project: Project | null | undefined,
  initialServerId?: string
) {
  const snapshots = useServerConnectionSnapshots()
  const queryClient = useQueryClient()
  // A new session already lives on a host. Keep that host even when the
  // sidebar row is the other checkout of the same project, and before the
  // project list has loaded. Reset only when that starting host changes.
  const resetKey = initialServerId ?? project?.id ?? LOCAL_SERVER_ID
  const defaultHost = initialServerId ?? project?.serverId ?? LOCAL_SERVER_ID
  const [trackedKey, setTrackedKey] = useState(resetKey)
  const [hostId, setHostId] = useState(defaultHost)
  if (trackedKey !== resetKey) {
    setTrackedKey(resetKey)
    setHostId(defaultHost)
  }
  const prompt = useStartOnHostPromptState()

  const run = useCallback(async () => {
    if (!project?.id || !project.path) {
      throw new Error('No project selected')
    }
    const snapshot = snapshots.get(hostId)
    const targetServerName =
      hostId === LOCAL_SERVER_ID
        ? 'Local'
        : (snapshot?.name ??
          project.hostCheckouts?.find(c => c.serverId === hostId)?.serverName ??
          hostId)
    const targetOnline =
      hostId === LOCAL_SERVER_ID || snapshot?.status === 'online'

    startCancelled = false
    setPrompt({
      phase: 'preparing',
      message: `Preparing ${project.name} on ${targetServerName}…`,
      error: null,
      offer: null,
      percent: null,
    })

    const operationId = globalThis.crypto.randomUUID()
    let unlisten: (() => void) | null = null
    try {
      unlisten = await listen<EnsureProgressEvent>(
        'project:ensure-progress',
        event => {
          const update = progressUpdateFromEvent(
            event.payload,
            operationId,
            promptState.phase
          )
          if (!update) return
          setPrompt({
            phase: update.phase,
            message: update.message,
            percent: update.percent,
            error: null,
            offer: promptState.offer,
          })
        }
      )
      const result = await startProjectOnHost(
        {
          project,
          targetServerId: hostId,
          targetServerName,
          targetOnline,
          targetError: snapshot?.error,
          operationId,
        },
        {
          invoke: (serverId, command, args) =>
            invokeForServer(serverId, command, args),
          onProgress: progress =>
            setPrompt({
              phase: progress.phase === 'copy' ? 'copying' : 'preparing',
              message: progress.message,
              percent: progress.percent,
              error: null,
              offer: promptState.offer,
            }),
          confirmEnvCopy: offer =>
            new Promise(resolve => {
              envDecision = resolve
              setPrompt({
                phase: 'confirm-env',
                message: null,
                error: null,
                offer,
                percent: null,
              })
            }),
          isCancelled: () => startCancelled,
        }
      )
      if (result.status !== 'current') {
        invalidateProjectLists(queryClient)
      }
      setPrompt(idlePrompt)
      return result
    } catch (error) {
      if (isStartOnHostCancelled(error) || startCancelled) {
        setPrompt(idlePrompt)
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      setPrompt({
        phase: 'error',
        message: null,
        error: message,
        offer: null,
        percent: null,
      })
      throw error
    } finally {
      unlisten?.()
    }
  }, [hostId, project, queryClient, snapshots])

  return {
    hostId,
    setHostId,
    phase: prompt.phase,
    run,
  }
}

export function HostProgressBar({
  percent,
  message,
}: {
  percent: number | null
  message: string
}) {
  const determinate = percent != null
  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
        aria-valuetext={message}
        aria-label="Start progress"
        className="bg-secondary relative h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className={
            determinate
              ? 'bg-primary h-full rounded-full transition-[width] duration-150'
              : 'bg-primary absolute inset-y-0 w-1/3 rounded-full animate-start-on-host-indeterminate'
          }
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

export function StartOnHostPrompt() {
  const state = useStartOnHostPromptState()
  const open = state.phase !== 'idle'

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) cancelStartOnHost()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {state.phase === 'confirm-env'
              ? 'Copy env files?'
              : state.phase === 'error'
                ? 'Could not start on that host'
                : 'Starting on host'}
          </DialogTitle>
          <DialogDescription>
            {state.phase === 'confirm-env' && state.offer
              ? `${state.offer.sourceServerName} has ${state.offer.files.join(', ')}. Copy them onto the host you are starting on? These files can contain secrets. Jean copies them only for this start and does not keep syncing.`
              : state.phase === 'error'
                ? (state.error ?? 'Could not prepare the checkout.')
                : 'Preparing the checkout on the host you picked. This stays open until it is ready.'}
          </DialogDescription>
        </DialogHeader>
        {state.phase === 'confirm-env' && state.offer && (
          <ul className="list-disc pl-5 text-sm">
            {state.offer.files.map(name => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        {(state.phase === 'preparing' || state.phase === 'copying') && (
          <HostProgressBar
            percent={state.percent}
            message={state.message ?? 'Preparing the checkout…'}
          />
        )}
        <DialogFooter>
          {state.phase === 'confirm-env' ? (
            <>
              <Button type="button" variant="outline" onClick={skipEnvCopy}>
                {"Don't copy"}
              </Button>
              <Button type="button" onClick={acceptEnvCopy}>
                Copy env files
              </Button>
            </>
          ) : state.phase === 'error' ? (
            <Button type="button" onClick={cancelStartOnHost}>
              Close
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={cancelStartOnHost}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
