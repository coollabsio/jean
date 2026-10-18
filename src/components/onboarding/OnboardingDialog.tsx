/**
 * Onboarding Dialog for CLI Setup
 *
 * Short flow: usage mode (native) → remote/WSL setup → pick AI backends →
 * one setup checklist (installs in parallel, one sign-in at a time, GitHub
 * CLI required) → done.
 */

/* eslint-disable no-console */
const dbg = (...args: unknown[]) => console.debug('[ONBOARDING]', ...args)

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { AuthLoginState } from './CliSetupComponents'
import { toast } from 'sonner'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  PI_DEFAULT_MAGIC_PROMPT_MODELS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
  GROK_DEFAULT_MAGIC_PROMPT_MODELS,
  KIMI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  KIMI_DEFAULT_MAGIC_PROMPT_MODELS,
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
  type MagicPromptBackends,
  type MagicPromptModels,
} from '@/types/preferences'
import { isServerWindows } from '@/lib/platform'
import { isNativeApp } from '@/lib/environment'
import {
  getActiveConnectionId,
  getRemoteConnections,
  LOCAL_CONNECTION_ID,
} from '@/lib/remote-connections'
import { SettingsTargetProvider } from '@/lib/settings-target'
import { serverResourceKey } from '@/lib/server-resource'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'
import { WslSetupStep } from './WslSetupStep'
import { UsageModeStep, type OnboardingUsageMode } from './UsageModeStep'
import { RemoteSetupStep } from './RemoteSetupStep'
import { ArrowLeft, Loader2 } from '@/components/icons/reicon'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  checkSystemPrerequisites,
  type SystemPrerequisites,
} from '@/services/prerequisites'
import {
  AI_BACKENDS,
  useCliSetupFlows,
  type AIBackend,
  type CliType,
} from './cli-setup-flows'
import { BackendPicker, preselectBackends } from './BackendPicker'
import { SetupChecklist } from './SetupChecklist'
import { OnboardingProgress } from './OnboardingProgress'
import { SuccessStep } from './SuccessStep'

export { AI_BACKENDS }

type OnboardingStep =
  | 'usage-mode'
  | 'remote-setup'
  | 'wsl-setup'
  | 'backends'
  | 'setup'
  | 'complete'

const WHERE_STEPS: readonly OnboardingStep[] = [
  'usage-mode',
  'remote-setup',
  'wsl-setup',
]

function magicDefaultsForBackend(
  backend: AIBackend
): { models: MagicPromptModels; backends: MagicPromptBackends } | null {
  switch (backend) {
    case 'codex':
      return {
        models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'opencode':
      return {
        models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'pi':
      return {
        models: PI_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'commandcode':
      return {
        models: COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'grok':
      return {
        models: GROK_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'kimi':
      return {
        models: KIMI_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: KIMI_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    case 'antigravity':
      return {
        models: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
        backends: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
      }
    default:
      return null
  }
}

function prerequisitesMissing(status: SystemPrerequisites | null): boolean {
  return (
    !!status &&
    (!status.gitInstalled || !status.nodeInstalled || !status.npmInstalled)
  )
}

/**
 * Always mounted so Radix Dialog can properly clean up its portal/overlay
 * when closing. Unmounting while open leaves a stale overlay that blocks clicks.
 */
export function OnboardingDialog() {
  // Server that receives backend installs. Starts local; switches to the
  // remote jean-server after remote setup, so every CLI hook below (via the
  // settings-target context) installs and authenticates on that server.
  const [targetServerId, setTargetServerId] =
    useState<ServerId>(LOCAL_SERVER_ID)
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  if (!onboardingOpen && targetServerId !== LOCAL_SERVER_ID) {
    setTargetServerId(LOCAL_SERVER_ID)
  }

  return (
    <SettingsTargetProvider serverId={targetServerId}>
      <OnboardingDialogContent
        targetServerId={targetServerId}
        onTargetServerChange={setTargetServerId}
      />
    </SettingsTargetProvider>
  )
}

interface OnboardingDialogContentProps {
  targetServerId: ServerId
  onTargetServerChange: (serverId: ServerId) => void
}

function OnboardingDialogContent({
  targetServerId,
  onTargetServerChange,
}: OnboardingDialogContentProps) {
  const remoteTarget = targetServerId !== LOCAL_SERVER_ID
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  const onboardingManuallyTriggered = useUIStore(
    state => state.onboardingManuallyTriggered
  )

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const flows = useCliSetupFlows()

  // --- Host prerequisites (git / node / npm) ------------------------------
  const [prerequisites, setPrerequisites] =
    useState<SystemPrerequisites | null>(null)
  const [installingPrerequisites, setInstallingPrerequisites] = useState(false)
  const [prerequisiteAttempt, setPrerequisiteAttempt] = useState(0)

  const refreshPrerequisites = useCallback(async () => {
    setPrerequisites(null)
    const status = await checkSystemPrerequisites(
      remoteTarget ? targetServerId : undefined
    )
    setPrerequisites(status)
    return status
  }, [remoteTarget, targetServerId])

  useEffect(() => {
    refreshPrerequisites().catch(() => undefined)
  }, [refreshPrerequisites])

  // --- Step + back history -------------------------------------------------
  const [step, setStepRaw] = useState<OnboardingStep>('backends')
  const stepRef = useRef<OnboardingStep>('backends')
  const [historyStack, setHistoryStack] = useState<OnboardingStep[]>([])
  const setStep = useCallback(
    (next: OnboardingStep, opts?: { replace?: boolean }) => {
      const current = stepRef.current
      dbg('step:', current, '→', next, opts?.replace ? '(replace)' : '')
      if (!opts?.replace && current !== next && current !== 'complete') {
        setHistoryStack(h =>
          h[h.length - 1] === current ? h : [...h, current]
        )
      }
      stepRef.current = next
      setStepRaw(next)
    },
    []
  )
  const goBack = useCallback(() => {
    const prev = historyStack.at(-1)
    if (!prev) return
    stepRef.current = prev
    setStepRaw(prev)
    setHistoryStack(h => h.slice(0, -1))
  }, [historyStack])

  const [selectedBackends, setSelectedBackends] = useState<AIBackend[]>([])
  // Preselect detected backends once statuses for the current target load.
  const [needsPreselect, setNeedsPreselect] = useState(false)
  // Remote setup just finished; decide where to go once its statuses load.
  const [pendingRemoteCheck, setPendingRemoteCheck] = useState(false)
  const [completing, setCompleting] = useState(false)

  // Seed for terminal IDs - each retry increments an attempt counter to force a fresh PTY
  const loginSessionSeed = useMemo(
    // eslint-disable-next-line react-hooks/purity
    () => Date.now(),
    []
  )
  // Remote terminal IDs carry the server, so start/stop/output route there.
  const terminalIdFor = useCallback(
    (id: string) =>
      remoteTarget
        ? serverResourceKey({ serverId: targetServerId, resourceId: id })
        : id,
    [remoteTarget, targetServerId]
  )

  const aiLoading = AI_BACKENDS.some(
    b => flows[b].statusLoading || flows[b].authLoading
  )
  const allLoading = aiLoading || flows.gh.statusLoading || flows.gh.authLoading
  const readyBackends = AI_BACKENDS.filter(b => flows[b].ready)
  const ghReady = flows.gh.ready

  const goToBackends = useCallback(
    (opts?: { replace?: boolean }) => {
      setNeedsPreselect(true)
      setStep('backends', opts)
    },
    [setStep]
  )

  const goToSetupWith = useCallback(
    (backends: AIBackend[], opts?: { replace?: boolean }) => {
      setSelectedBackends(backends)
      setStep('setup', opts)
    },
    [setStep]
  )

  useEffect(() => {
    if (step !== 'backends' || !needsPreselect || aiLoading) return
    setNeedsPreselect(false)
    setSelectedBackends(preselectBackends(flows))
  }, [step, needsPreselect, aiLoading, flows])

  // --- Initial routing -----------------------------------------------------
  const initializedFlowRef = useRef(false)
  useEffect(() => {
    if (!onboardingOpen) {
      initializedFlowRef.current = false
      setHistoryStack([])
      setPendingRemoteCheck(false)
      return
    }
    if (allLoading || initializedFlowRef.current || !preferences) return
    initializedFlowRef.current = true

    const remoteActive = getActiveConnectionId() !== LOCAL_CONNECTION_ID
    dbg('init:', { readyBackends, ghReady, remoteActive })

    // Local vs Remote selects the desktop shell's backend. Web Access already
    // targets the Jean server that served the page.
    if (onboardingManuallyTriggered) {
      if (isNativeApp()) setStep('usage-mode', { replace: true })
      else goToBackends({ replace: true })
      return
    }

    const allReady = ghReady && readyBackends.length > 0
    const dismiss = () =>
      useUIStore.setState({
        onboardingOpen: false,
        onboardingStartStep: null,
        onboardingDismissed: true,
      })

    // Already on a remote / Web Access: no usage mode, no WSL.
    if (!isNativeApp() || remoteActive) {
      if (allReady) return dismiss()
      if (readyBackends.length > 0) {
        goToSetupWith(readyBackends, { replace: true })
        return
      }
      goToBackends({ replace: true })
      return
    }

    const needsWslChoice = isServerWindows() && !preferences.wsl_mode_chosen
    if (allReady && !needsWslChoice) return dismiss()
    if (readyBackends.length > 0 && !needsWslChoice) {
      goToSetupWith(readyBackends, { replace: true })
      return
    }
    setStep('usage-mode', { replace: true })
  }, [
    onboardingOpen,
    onboardingManuallyTriggered,
    allLoading,
    preferences,
    readyBackends,
    ghReady,
    setStep,
    goToBackends,
    goToSetupWith,
  ])

  // After remote setup: skip straight to done when the server is ready.
  useEffect(() => {
    if (!pendingRemoteCheck || allLoading) return
    setPendingRemoteCheck(false)
    if (ghReady && readyBackends.length > 0) {
      dbg('remote ready → complete')
      setSelectedBackends(readyBackends)
      setStep('complete', { replace: true })
      return
    }
    setNeedsPreselect(true)
  }, [pendingRemoteCheck, allLoading, ghReady, readyBackends, setStep])

  // --- Handlers ------------------------------------------------------------
  const handleBackendToggle = useCallback(
    (backend: AIBackend, checked: boolean) => {
      setSelectedBackends(prev => {
        if (checked) return prev.includes(backend) ? prev : [...prev, backend]
        return prev.filter(b => b !== backend)
      })
    },
    []
  )

  const handleBackendsContinue = useCallback(() => {
    if (selectedBackends.length === 0 && !onboardingManuallyTriggered) {
      toast.warning('Select at least one AI backend to continue.')
      return
    }
    setStep('setup')
  }, [selectedBackends, onboardingManuallyTriggered, setStep])

  const handleSkipBackend = useCallback((backend: AIBackend) => {
    setSelectedBackends(prev =>
      prev.length > 1 ? prev.filter(b => b !== backend) : prev
    )
  }, [])

  const continueAfterLocalChoice = useCallback(() => {
    if (isServerWindows() && preferences && !preferences.wsl_mode_chosen) {
      setStep('wsl-setup')
      return
    }
    goToBackends()
  }, [preferences, setStep, goToBackends])

  const handleUsageModeSelect = useCallback(
    (mode: OnboardingUsageMode) => {
      if (mode === 'remote') {
        setStep('remote-setup')
        return
      }
      onTargetServerChange(LOCAL_SERVER_ID)
      continueAfterLocalChoice()
    },
    [continueAfterLocalChoice, onTargetServerChange, setStep]
  )

  // WSL only applies to the local Windows shell, so remote goes straight to
  // backends on the new server. Hooks switch server via context, so wait for
  // the remote's statuses before deciding (pendingRemoteCheck effect).
  const handleRemoteReady = useCallback(
    (serverId: ServerId) => {
      dbg('remote-setup complete on', serverId)
      onTargetServerChange(serverId)
      setSelectedBackends([])
      setPendingRemoteCheck(true)
      setStep('backends', { replace: true })
    },
    [onTargetServerChange, setStep]
  )

  const handleWslComplete = useCallback(() => {
    if (ghReady && readyBackends.length > 0) {
      setSelectedBackends(readyBackends)
      setStep('complete')
      return
    }
    if (readyBackends.length > 0) {
      goToSetupWith(readyBackends)
      return
    }
    goToBackends()
  }, [ghReady, readyBackends, setStep, goToSetupWith, goToBackends])

  const handleComplete = useCallback(async () => {
    // Set the first ready selected backend as the default so the preference
    // isn't left pointing at an uninstalled backend (e.g. 'claude').
    const firstBackend = selectedBackends.find(b => flows[b].ready)
    if (firstBackend && preferences) {
      const magicDefaults = magicDefaultsForBackend(firstBackend)
      // Persist the backend/model pair before closing onboarding. Otherwise a
      // session opened immediately afterwards can be created with Claude's
      // model while the UI has already fallen back to another installed CLI.
      await patchPreferences.mutateAsync({
        default_backend: firstBackend,
        ...(magicDefaults
          ? {
              magic_prompt_models: magicDefaults.models,
              magic_prompt_backends: magicDefaults.backends,
              magic_models_auto_initialized: true,
            }
          : {}),
      })
    }
    // Atomic: onboardingDismissed must flip with onboardingOpen so App.tsx
    // doesn't auto-open the feature tour over whatever comes next.
    useUIStore.setState({
      onboardingOpen: false,
      onboardingStartStep: null,
      onboardingDismissed: true,
    })
  }, [selectedBackends, flows, preferences, patchPreferences])

  const finishThen = useCallback(
    async (next?: () => void) => {
      setCompleting(true)
      try {
        await handleComplete()
        next?.()
      } catch (error) {
        toast.error(`Failed to save preferences: ${error}`)
      } finally {
        setCompleting(false)
      }
    },
    [handleComplete]
  )

  const handleAddProject = useCallback(() => {
    void finishThen(() =>
      useProjectsStore.getState().setAddProjectDialogOpen(true)
    )
  }, [finishThen])

  const handleTour = useCallback(() => {
    void finishThen(() => useUIStore.getState().setFeatureTourOpen(true))
  }, [finishThen])

  const handleAbort = useCallback(() => {
    // Atomic update: onboardingDismissed must be true BEFORE onboardingOpen
    // becomes false, otherwise the App.tsx subscriber sees dismissed=false
    // and incorrectly opens the feature tour dialog.
    useUIStore.setState({
      onboardingOpen: false,
      onboardingStartStep: null,
      onboardingDismissed: true,
    })
    // Safety: Radix Dialog sometimes fails to restore pointer-events on <body>
    setTimeout(() => {
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.removeProperty('pointer-events')
      }
    }, 500)
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return
      if (step === 'complete') void finishThen()
      else handleAbort()
    },
    [step, finishThen, handleAbort]
  )

  // --- Presentation --------------------------------------------------------
  const serverName = remoteTarget
    ? (getRemoteConnections().find(c => c.id === targetServerId)?.name ??
      'the remote server')
    : null

  const header = ((): { title: string; description: string } => {
    switch (step) {
      case 'usage-mode':
        return {
          title: 'Welcome to Jean',
          description: 'Where should Jean run?',
        }
      case 'remote-setup':
        return {
          title: 'Connect a server',
          description: 'Jean installs itself over SSH.',
        }
      case 'wsl-setup':
        return {
          title: 'Welcome to Jean',
          description: 'Choose your development environment.',
        }
      case 'backends':
        return {
          title: 'Pick your AI backends',
          description: serverName
            ? `Installs on ${serverName}.`
            : onboardingManuallyTriggered
              ? 'Add or change backends.'
              : 'Pick at least one.',
        }
      case 'setup':
        return {
          title: 'Setting up',
          description: serverName
            ? `On ${serverName}. GitHub CLI is required.`
            : 'GitHub CLI is required.',
        }
      case 'complete':
        return {
          title: "You're ready",
          description: `Jean is set up${serverName ? ` on ${serverName}` : ''}.`,
        }
    }
  })()

  const showWhere =
    isNativeApp() &&
    (WHERE_STEPS.includes(step) ||
      historyStack.some(s => WHERE_STEPS.includes(s)))
  const progressLabels = showWhere
    ? (['Where', 'Backends', 'Setup'] as const)
    : (['Backends', 'Setup', 'Done'] as const)
  const progressIndex = showWhere
    ? WHERE_STEPS.includes(step)
      ? 0
      : step === 'backends'
        ? 1
        : 2
    : step === 'backends'
      ? 0
      : 1

  const missingPrereqs = prerequisitesMissing(prerequisites)
  const backendsBusy = aiLoading || pendingRemoteCheck
  const canFinish =
    ghReady &&
    (selectedBackends.some(b => flows[b].ready) ||
      (selectedBackends.length === 0 && onboardingManuallyTriggered))
  const canGoBack = historyStack.length > 0 && step !== 'complete'
  const readyClis: CliType[] = [
    ...selectedBackends.filter(b => flows[b].ready),
    ...(ghReady ? (['gh'] as const) : []),
  ]

  const renderPrerequisites = () => {
    if (!prerequisites || !missingPrereqs) return null
    if (installingPrerequisites && prerequisites.automaticInstallCommand) {
      return (
        <AuthLoginState
          key={prerequisiteAttempt}
          cliName="Git and Node.js prerequisites"
          terminalId={terminalIdFor(
            `onboarding-prerequisites-${loginSessionSeed}-${prerequisiteAttempt}`
          )}
          command="/bin/bash"
          commandArgs={['-lc', prerequisites.automaticInstallCommand]}
          action="install"
          onComplete={async () => {
            const status = await refreshPrerequisites()
            if (
              status.gitInstalled &&
              status.nodeInstalled &&
              status.npmInstalled
            ) {
              setInstallingPrerequisites(false)
            } else {
              toast.error(
                'Prerequisites are still missing. Restart Jean after installing Node.js so it can refresh PATH.'
              )
            }
          }}
          onRetry={() => setPrerequisiteAttempt(value => value + 1)}
        />
      )
    }
    return (
      <PrerequisiteSetupState
        status={prerequisites}
        onAutomaticInstall={() => setInstallingPrerequisites(true)}
        onRecheck={() => void refreshPrerequisites()}
      />
    )
  }

  const renderBody = () => {
    switch (step) {
      case 'usage-mode':
        return <UsageModeStep onSelect={handleUsageModeSelect} />
      case 'remote-setup':
        return <RemoteSetupStep onComplete={handleRemoteReady} />
      case 'wsl-setup':
        return <WslSetupStep onComplete={handleWslComplete} />
      case 'backends':
        return (
          <div className="space-y-4">
            {renderPrerequisites()}
            <BackendPicker
              flows={flows}
              selected={selectedBackends}
              onToggle={handleBackendToggle}
              loading={backendsBusy}
            />
          </div>
        )
      case 'setup':
        return (
          <SetupChecklist
            flows={flows}
            backends={selectedBackends}
            onSkip={handleSkipBackend}
            terminalIdFor={terminalIdFor}
            loginSeed={loginSessionSeed}
            cursorServerId={remoteTarget ? targetServerId : undefined}
          />
        )
      case 'complete':
        return (
          <SuccessStep
            readyClis={readyClis}
            busy={completing}
            onAddProject={handleAddProject}
            onTour={handleTour}
          />
        )
    }
  }

  const renderPrimary = () => {
    if (step === 'backends') {
      return (
        <Button
          onClick={handleBackendsContinue}
          disabled={backendsBusy || missingPrereqs}
        >
          {backendsBusy ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Checking backends…
            </>
          ) : (
            'Continue'
          )}
        </Button>
      )
    }
    if (step === 'setup') {
      return (
        <Button onClick={() => setStep('complete')} disabled={!canFinish}>
          Finish
        </Button>
      )
    }
    return null
  }

  return (
    <Dialog open={onboardingOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col"
        preventClose
      >
        {step !== 'complete' && (
          <OnboardingProgress labels={progressLabels} current={progressIndex} />
        )}

        <DialogHeader>
          <DialogTitle className="text-xl">{header.title}</DialogTitle>
          <DialogDescription>{header.description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto py-2">
          <div
            key={step}
            className="animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
          >
            {renderBody()}
          </div>
        </div>

        {step !== 'complete' && (
          <div className="flex items-center justify-between border-t pt-3 mt-auto">
            <Button
              variant="ghost"
              size="sm"
              onClick={goBack}
              disabled={!canGoBack}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            {renderPrimary()}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PrerequisiteSetupState({
  status,
  onAutomaticInstall,
  onRecheck,
}: {
  status: SystemPrerequisites
  onAutomaticInstall: () => void
  onRecheck: () => void
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">Install prerequisites first</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Git: {status.gitVersion ?? 'missing'} · Node.js:{' '}
          {status.nodeVersion ?? 'missing'} · npm:{' '}
          {status.npmVersion ?? 'missing'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {status.automaticInstallSupported && (
          <Button size="sm" onClick={onAutomaticInstall}>
            Install automatically
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => openUrl(status.manualInstallUrl)}
        >
          Node.js help
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openUrl('https://git-scm.com/downloads')}
        >
          Git help
        </Button>
        <Button size="sm" variant="ghost" onClick={onRecheck}>
          Recheck
        </Button>
      </div>
    </div>
  )
}

export default OnboardingDialog
