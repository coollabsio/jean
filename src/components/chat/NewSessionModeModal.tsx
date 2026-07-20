import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  MessageSquarePlus,
  Loader2,
  Terminal,
  Zap,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { useCreateSession } from '@/services/chat'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { useCodexCliStatus } from '@/services/codex-cli'
import { useOpencodeCliStatus } from '@/services/opencode-cli'
import { useCursorCliStatus } from '@/services/cursor-cli'
import { usePiCliStatus } from '@/services/pi-cli'
import { useCommandCodeCliStatus } from '@/services/commandcode-cli'
import { useGrokCliStatus } from '@/services/grok-cli'
import { useKimiCliStatus } from '@/services/kimi-cli'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import {
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import type { CliBackend } from '@/types/preferences'
import { usePreferences } from '@/services/preferences'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  NativeCliSessionsModal,
  type NativeCliSessionKind,
} from './NativeCliSessionsModal'

const BACKEND_ORDER: CliBackend[] = [
  'codex',
  'claude',
  'opencode',
  'cursor',
  'pi',
  'commandcode',
  'grok',
  'kimi',
]

const backendCommands: Record<CliBackend, string> = {
  codex: 'codex',
  claude: 'claude',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  pi: 'pi',
  commandcode: 'commandcode',
  grok: 'grok',
  kimi: 'kimi',
}

const YOLO_ARGS_BY_BACKEND: Partial<Record<CliBackend, string[]>> = {
  claude: ['--permission-mode', 'bypassPermissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  cursor: ['--yolo', '--sandbox', 'disabled'],
  grok: ['--always-approve', '--sandbox', 'off'],
  kimi: ['--yolo'],
}

export function NewSessionModeModal() {
  const target = useUIStore(state => state.newSessionModeTarget)
  const close = useUIStore(state => state.closeNewSessionModeModal)
  const createSession = useCreateSession()
  const claudeStatus = useClaudeCliStatus({ enabled: target !== null })
  const codexStatus = useCodexCliStatus({ enabled: target !== null })
  const opencodeStatus = useOpencodeCliStatus({ enabled: target !== null })
  const cursorStatus = useCursorCliStatus({ enabled: target !== null })
  const piStatus = usePiCliStatus({ enabled: target !== null })
  const commandcodeStatus = useCommandCodeCliStatus({
    enabled: target !== null,
  })
  const grokStatus = useGrokCliStatus({ enabled: target !== null })
  const kimiStatus = useKimiCliStatus({ enabled: target !== null })
  const { data: preferences } = usePreferences()
  const [nativePickerKind, setNativePickerKind] =
    useState<NativeCliSessionKind | null>(null)
  const [nativePickerInitialCommandArgs, setNativePickerInitialCommandArgs] =
    useState<string[]>([])
  const [mobileBackendActions, setMobileBackendActions] =
    useState<CliBackend | null>(null)
  const autoHandledTargetRef = useRef<string | null>(null)
  const open = target !== null
  const isMobile = useIsMobile()

  const installedBackendChoices = useMemo(() => {
    const statusByBackend: Record<
      CliBackend,
      { installed?: boolean; path?: string | null }
    > = {
      codex: {
        installed: codexStatus.data?.installed,
        path: codexStatus.data?.path,
      },
      claude: {
        installed: claudeStatus.data?.installed,
        path: claudeStatus.data?.path,
      },
      opencode: {
        installed: opencodeStatus.data?.installed,
        path: opencodeStatus.data?.path,
      },
      cursor: {
        installed: cursorStatus.data?.installed,
        path: cursorStatus.data?.path,
      },
      pi: {
        installed: piStatus.data?.installed,
        path: piStatus.data?.path,
      },
      commandcode: {
        installed: commandcodeStatus.data?.installed,
        path: commandcodeStatus.data?.path,
      },
      grok: {
        installed: grokStatus.data?.installed,
        path: grokStatus.data?.path,
      },
      kimi: {
        installed: kimiStatus.data?.installed,
        path: kimiStatus.data?.path,
      },
    }

    return BACKEND_ORDER.map((backend, index) => {
      const status = statusByBackend[backend]
      return {
        backend,
        shortcut: String(index + 2),
        installed: Boolean(status.installed),
        command: status.path ?? backendCommands[backend],
      }
    }).filter(choice => choice.installed)
  }, [
    claudeStatus.data?.installed,
    claudeStatus.data?.path,
    codexStatus.data?.installed,
    codexStatus.data?.path,
    commandcodeStatus.data?.installed,
    commandcodeStatus.data?.path,
    cursorStatus.data?.installed,
    cursorStatus.data?.path,
    grokStatus.data?.installed,
    grokStatus.data?.path,
    kimiStatus.data?.installed,
    kimiStatus.data?.path,
    opencodeStatus.data?.installed,
    opencodeStatus.data?.path,
    piStatus.data?.installed,
    piStatus.data?.path,
  ])

  const isCheckingBackends =
    claudeStatus.isLoading ||
    codexStatus.isLoading ||
    opencodeStatus.isLoading ||
    cursorStatus.isLoading ||
    piStatus.isLoading ||
    commandcodeStatus.isLoading ||
    grokStatus.isLoading ||
    kimiStatus.isLoading

  const nativePickerCommand = useMemo(() => {
    if (nativePickerKind === null || nativePickerKind === 'terminal') {
      return null
    }
    return (
      installedBackendChoices.find(
        choice => choice.backend === nativePickerKind
      )?.command ?? backendCommands[nativePickerKind]
    )
  }, [installedBackendChoices, nativePickerKind])

  const openSessionModal = useCallback(
    (sessionId: string, worktreeId: string, worktreePath: string) => {
      if (!target) return
      if (target.origin === 'canvas') {
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId, worktreeId, worktreePath },
          })
        )
      } else if (target.origin === 'modal') {
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId },
          })
        )
      }
    },
    [target]
  )

  const chooseChat = useCallback(() => {
    if (!target) return
    const { worktreeId, worktreePath } = target
    close()
    createSession.mutate(
      { worktreeId, worktreePath },
      {
        onSuccess: session => {
          const defaultExecutionMode =
            preferences?.default_execution_mode ?? 'plan'
          useChatStore
            .getState()
            .setExecutionMode(session.id, defaultExecutionMode)
          invoke('update_session_state', {
            worktreeId,
            worktreePath,
            sessionId: session.id,
            selectedExecutionMode: defaultExecutionMode,
          }).catch(() => undefined)
          useChatStore.getState().setActiveSession(worktreeId, session.id)
          useUIStore.getState().setSessionPrimarySurface(session.id, 'chat')
          openSessionModal(session.id, worktreeId, worktreePath)
        },
      }
    )
  }, [close, createSession, openSessionModal, preferences, target])

  const choosePlainTerminal = useCallback(() => {
    setNativePickerInitialCommandArgs([])
    setNativePickerKind('terminal')
  }, [])

  const chooseBackendTerminal = useCallback((backend: CliBackend) => {
    setNativePickerInitialCommandArgs([])
    setNativePickerKind(backend)
    setMobileBackendActions(null)
  }, [])

  const chooseBackendTerminalYolo = useCallback((backend: CliBackend) => {
    const yoloArgs = YOLO_ARGS_BY_BACKEND[backend]
    if (!yoloArgs) return
    setNativePickerInitialCommandArgs(yoloArgs)
    setNativePickerKind(backend)
    setMobileBackendActions(null)
  }, [])

  const closeAll = useCallback(() => {
    autoHandledTargetRef.current = null
    setNativePickerKind(null)
    setNativePickerInitialCommandArgs([])
    setMobileBackendActions(null)
    close()
  }, [close])

  useEffect(() => {
    if (!target || target.intent !== 'default') {
      autoHandledTargetRef.current = null
      return
    }
    if (!preferences) return

    const defaultKind = preferences.default_new_session_kind ?? 'chat'
    const targetKey = `${target.worktreeId}:${target.worktreePath}:${target.origin}:${defaultKind}`
    if (autoHandledTargetRef.current === targetKey) return
    autoHandledTargetRef.current = targetKey

    if (defaultKind === 'chat') {
      chooseChat()
      return
    }

    if (defaultKind === 'terminal') {
      setNativePickerInitialCommandArgs([])
      setNativePickerKind('terminal')
      return
    }

    setNativePickerInitialCommandArgs([])
    setNativePickerKind(defaultKind)
  }, [chooseChat, preferences?.default_new_session_kind, target])

  useEffect(() => {
    if (!open || nativePickerKind !== null) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        chooseChat()
        return
      }

      if (event.key === '1') {
        event.preventDefault()
        event.stopPropagation()
        choosePlainTerminal()
        return
      }

      const choice = installedBackendChoices.find(
        item => item.shortcut === event.key
      )
      if (choice) {
        event.preventDefault()
        event.stopPropagation()
        chooseBackendTerminal(choice.backend)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    chooseBackendTerminal,
    chooseBackendTerminalYolo,
    chooseChat,
    choosePlainTerminal,
    installedBackendChoices,
    nativePickerKind,
    open,
  ])

  return (
    <>
      <Dialog
        open={open && nativePickerKind === null && target?.intent !== 'default'}
        onOpenChange={nextOpen => !nextOpen && closeAll()}
      >
        <DialogContent className="w-[min(420px,calc(100vw-32px))] gap-3 p-4 sm:max-w-[420px]">
          {mobileBackendActions ? (
            <MobileBackendActions
              backend={mobileBackendActions}
              disabled={createSession.isPending}
              onBack={() => setMobileBackendActions(null)}
              onNormal={() => chooseBackendTerminal(mobileBackendActions)}
              onYolo={() => chooseBackendTerminalYolo(mobileBackendActions)}
            />
          ) : (
            <>
              <DialogHeader className="space-y-1 pr-6">
                <DialogTitle className="text-base font-semibold">
                  New session
                </DialogTitle>
                <DialogDescription className="text-xs leading-5">
                  Choose what to open for this worktree.
                </DialogDescription>
              </DialogHeader>

              <div className="grid min-w-0 gap-2">
                <NewSessionChoice
                  icon={
                    createSession.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <MessageSquarePlus className="size-4" />
                    )
                  }
                  title="Jean Chat"
                  subtitle="Normal ChatWindow session with Jean features"
                  badge="Default"
                  shortcut="↵"
                  showShortcut={!isMobile}
                  disabled={createSession.isPending}
                  onClick={chooseChat}
                />

                <NewSessionChoice
                  icon={<Terminal className="size-4" />}
                  title="Terminal"
                  subtitle="Open a plain terminal on this worktree"
                  shortcut="1"
                  showShortcut={!isMobile}
                  disabled={createSession.isPending}
                  onClick={choosePlainTerminal}
                />

                <div
                  aria-hidden="true"
                  data-testid="new-session-backend-separator"
                  className="my-1 h-px bg-border/70"
                />

                {isMobile && installedBackendChoices.length > 0 && (
                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      AI backends
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {installedBackendChoices.map(choice => {
                        const Icon = getBackendIcon(choice.backend)
                        const label = getBackendPlainLabel(choice.backend)
                        return (
                          <MobileBackendChoice
                            key={choice.backend}
                            icon={<Icon className="size-4" />}
                            title={label}
                            disabled={createSession.isPending}
                            onClick={() =>
                              setMobileBackendActions(choice.backend)
                            }
                          />
                        )
                      })}
                    </div>
                  </div>
                )}

                {!isMobile &&
                  installedBackendChoices.map(choice => {
                    const Icon = getBackendIcon(choice.backend)
                    const label = getBackendPlainLabel(choice.backend)
                    const yoloArgs = YOLO_ARGS_BY_BACKEND[choice.backend]
                    return (
                      <NativeBackendChoice
                        key={choice.backend}
                        icon={<Icon className="size-4" />}
                        title={label}
                        subtitle={`Open native ${label} in a terminal session`}
                        shortcut={choice.shortcut}
                        yoloAvailable={Boolean(yoloArgs)}
                        disabled={createSession.isPending}
                        onClick={() => chooseBackendTerminal(choice.backend)}
                        onYoloClick={() =>
                          chooseBackendTerminalYolo(choice.backend)
                        }
                      />
                    )
                  })}

                {isCheckingBackends && installedBackendChoices.length === 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Checking installed backends…
                  </div>
                )}

                {!isCheckingBackends &&
                  installedBackendChoices.length === 0 && (
                    <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
                      No installed backend CLIs found.
                    </div>
                  )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {target && (
        <NativeCliSessionsModal
          open={open && nativePickerKind !== null}
          kind={nativePickerKind}
          worktreeId={target.worktreeId}
          worktreePath={target.worktreePath}
          command={nativePickerCommand}
          initialCommandArgs={nativePickerInitialCommandArgs}
          onBack={() => {
            setNativePickerKind(null)
            setNativePickerInitialCommandArgs([])
          }}
          onClose={closeAll}
          onOpenSessionModal={openSessionModal}
          autoStartNew={target.intent === 'default'}
        />
      )}
    </>
  )
}

function MobileBackendActions({
  backend,
  disabled,
  onBack,
  onNormal,
  onYolo,
}: {
  backend: CliBackend
  disabled?: boolean
  onBack: () => void
  onNormal: () => void
  onYolo: () => void
}) {
  const label = getBackendPlainLabel(backend)
  const yoloAvailable = Boolean(YOLO_ARGS_BY_BACKEND[backend])

  return (
    <>
      <DialogHeader className="space-y-1 pr-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-1 inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </button>
        <DialogTitle className="text-base font-semibold">{label}</DialogTitle>
        <DialogDescription className="text-xs leading-5">
          Choose how to start {label} for this worktree.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onNormal}
          className={cn(
            'rounded-lg border border-border/70 bg-muted/25 px-3 py-3 text-left text-sm font-medium transition-colors',
            'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
          )}
        >
          Start normal
        </button>
        {yoloAvailable && (
          <button
            type="button"
            disabled={disabled}
            onClick={onYolo}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-3 text-left text-sm font-medium transition-colors',
              'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
            )}
          >
            <Zap className="size-4 text-destructive" />
            Start yolo
          </button>
        )}
      </div>
    </>
  )
}

function MobileBackendChoice({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-3 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
    </button>
  )
}

function NativeBackendChoice({
  icon,
  title,
  subtitle,
  shortcut,
  yoloAvailable,
  disabled,
  onClick,
  onYoloClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  shortcut: string
  yoloAvailable: boolean
  disabled?: boolean
  onClick: () => void
  onYoloClick: () => void
}) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          {subtitle}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5">
        {yoloAvailable && (
          <button
            type="button"
            disabled={disabled}
            onClick={onYoloClick}
            title={`Start ${title} in yolo mode`}
            aria-label={`Start ${title} in yolo mode`}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-muted-foreground transition-colors',
              'hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-background'
            )}
          >
            <Zap className="size-3.5 text-destructive" />
            Yolo
          </button>
        )}
        <Kbd className="h-7 min-w-7 shrink-0 text-[10px]">{shortcut}</Kbd>
      </span>
    </div>
  )
}

function NewSessionChoice({
  icon,
  title,
  subtitle,
  badge,
  shortcut,
  showShortcut = true,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: string
  shortcut: string
  showShortcut?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
          {badge && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {showShortcut && <Kbd className="shrink-0 text-[10px]">{shortcut}</Kbd>}
    </button>
  )
}
