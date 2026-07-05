/**
 * Onboarding Dialog for CLI Setup
 *
 * Multi-step wizard that handles installation and authentication of at least
 * one AI backend CLI (Claude/Codex/OpenCode) plus mandatory GitHub CLI.
 */

/* eslint-disable no-console */
const dbg = (...args: unknown[]) => console.debug('[ONBOARDING]', ...args)

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useUIStore } from '@/store/ui-store'
import {
  useClaudeCliSetup,
  useClaudeCliAuth,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useCodexCliSetup,
  useCodexCliAuth,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useOpenCodeCliSetup,
  useOpenCodeCliAuth,
  useOpenCodePathDetection,
} from '@/services/opencode-cli'
import {
  usePiCliSetup,
  usePiCliAuth,
  usePiPathDetection,
} from '@/services/pi-cli'
import {
  useCommandCodeCliSetup,
  useCommandCodeCliAuth,
  useCommandCodePathDetection,
} from '@/services/commandcode-cli'
import {
  useGrokCliSetup,
  useGrokCliAuth,
  useGrokPathDetection,
} from '@/services/grok-cli'
import {
  useAntigravityCliSetup,
  useAntigravityCliAuth,
  useAntigravityPathDetection,
} from '@/services/antigravity-cli'
import {
  useGhCliSetup,
  useGhCliAuth,
  useGhPathDetection,
} from '@/services/gh-cli'
import {
  SetupState,
  InstallingState,
  ErrorState,
  AuthCheckingState,
  AuthLoginState,
  CliPathSelector,
} from './CliSetupComponents'
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
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
  type MagicPromptBackends,
  type MagicPromptModels,
} from '@/types/preferences'
import { isServerWindows } from '@/lib/platform'
import { WslSetupStep } from './WslSetupStep'
import { ArrowLeft, Loader2 } from 'lucide-react'

type AIBackend = 'claude' | 'codex' | 'opencode' | 'pi' | 'commandcode' | 'grok' | 'antigravity'
type CliType = AIBackend | 'gh'

const AI_BACKENDS: AIBackend[] = [
  'claude',
  'codex',
  'opencode',
  'pi',
  'commandcode',
  'grok',
  'antigravity',
]

type OnboardingStep =
  | 'wsl-setup'
  | 'backend-select'
  | 'claude-setup'
  | 'claude-installing'
  | 'claude-auth-checking'
  | 'claude-auth-login'
  | 'codex-setup'
  | 'codex-installing'
  | 'codex-auth-checking'
  | 'codex-auth-login'
  | 'opencode-setup'
  | 'opencode-installing'
  | 'opencode-auth-checking'
  | 'opencode-auth-login'
  | 'pi-setup'
  | 'pi-installing'
  | 'pi-auth-checking'
  | 'pi-auth-login'
  | 'commandcode-setup'
  | 'commandcode-installing'
  | 'commandcode-auth-checking'
  | 'commandcode-auth-login'
  | 'grok-setup'
  | 'grok-installing'
  | 'grok-auth-checking'
  | 'grok-auth-login'
  | 'antigravity-setup'
  | 'antigravity-installing'
  | 'antigravity-auth-checking'
  | 'antigravity-auth-login'
  | 'gh-setup'
  | 'gh-installing'
  | 'gh-auth-checking'
  | 'gh-auth-login'
  | 'complete'

/**
 * Steps that represent meaningful user-facing screens. Transitioning AWAY from
 * one of these via setStep() pushes it onto the back-history stack.
 * Transient/auto-advancing steps (*-installing, *-auth-checking) are excluded so
 * they never appear as a Back destination.
 */
const BACK_NAVIGABLE_STEPS: readonly OnboardingStep[] = [
  'wsl-setup',
  'backend-select',
  'claude-setup',
  'codex-setup',
  'opencode-setup',
  'claude-auth-login',
  'codex-auth-login',
  'opencode-auth-login',
  'pi-setup',
  'pi-auth-login',
  'commandcode-setup',
  'commandcode-auth-login',
  'grok-setup',
  'grok-auth-login',
  'antigravity-setup',
  'antigravity-auth-login',
  'gh-setup',
  'gh-auth-login',
] as const

interface VersionOption {
  version: string
  prerelease: boolean
  tagName?: string
  tag_name?: string
  publishedAt?: string
  published_at?: string
}

interface CliSetupData {
  type: CliType
  title: string
  description: string
  versions: VersionOption[]
  isVersionsLoading: boolean
  isVersionsError: boolean
  onRetryVersions: () => void
  isInstalling: boolean
  installError: Error | null
  progress: { stage: string; message: string; percent: number } | null
  install: (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void
  currentVersion: string | null | undefined
}

const backendLabel: Record<CliType, string> = {
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
  pi: 'PI CLI',
  commandcode: 'Command Code CLI',
  grok: 'Grok CLI',
  antigravity: 'Antigravity CLI',
  gh: 'GitHub CLI',
}

const BETA_BACKENDS = new Set<AIBackend>(['pi', 'commandcode', 'grok', 'antigravity'])

function magicDefaultsForBackend(
  backend: AIBackend
): { models: MagicPromptModels; backends: MagicPromptBackends } | null {
  if (backend === 'codex') {
    return {
      models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  if (backend === 'opencode') {
    return {
      models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  if (backend === 'pi') {
    return {
      models: PI_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  if (backend === 'commandcode') {
    return {
      models: COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  if (backend === 'grok') {
    return {
      models: GROK_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  if (backend === 'antigravity') {
    return {
      models: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
    }
  }
  return null
}

function stepToBackend(step: OnboardingStep): AIBackend | null {
  if (step.startsWith('claude-')) return 'claude'
  if (step.startsWith('codex-')) return 'codex'
  if (step.startsWith('opencode-')) return 'opencode'
  if (step.startsWith('pi-')) return 'pi'
  if (step.startsWith('commandcode-')) return 'commandcode'
  if (step.startsWith('grok-')) return 'grok'
  if (step.startsWith('antigravity-')) return 'antigravity'
  return null
}

/**
 * Always mounted so Radix Dialog can properly clean up its portal/overlay
 * when closing. Unmounting while open leaves a stale overlay that blocks clicks.
 */
export function OnboardingDialog() {
  return <OnboardingDialogContent />
}

/**
 * Inner component with all hook logic.
 * Only mounted when dialog is actually open.
 */
function OnboardingDialogContent() {
  const {
    onboardingOpen,
    onboardingStartStep,
    setOnboardingStartStep,
    onboardingManuallyTriggered,
  } = useUIStore()

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const claudeSetup = useClaudeCliSetup()
  const pathDetection = useClaudePathDetection()
  const codexPathDetection = useCodexPathDetection()
  const opencodePathDetection = useOpenCodePathDetection()
  const piPathDetection = usePiPathDetection()
  const commandcodePathDetection = useCommandCodePathDetection()
  const grokPathDetection = useGrokPathDetection()
  const antigravityPathDetection = useAntigravityPathDetection()
  const codexSetup = useCodexCliSetup()
  const opencodeSetup = useOpenCodeCliSetup()
  const piSetup = usePiCliSetup()
  const commandcodeSetup = useCommandCodeCliSetup()
  const grokSetup = useGrokCliSetup()
  const antigravitySetup = useAntigravityCliSetup()
  const ghPathDetection = useGhPathDetection()
  const ghSetup = useGhCliSetup()

  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeSetup.status?.installed,
  })
  const codexAuth = useCodexCliAuth({ enabled: !!codexSetup.status?.installed })
  const opencodeAuth = useOpenCodeCliAuth({
    enabled: !!opencodeSetup.status?.installed,
  })
  const piAuth = usePiCliAuth({ enabled: !!piSetup.status?.installed })
  const commandcodeAuth = useCommandCodeCliAuth({
    enabled: !!commandcodeSetup.status?.installed,
  })
  const grokAuth = useGrokCliAuth({ enabled: !!grokSetup.status?.installed })
  const antigravityAuth = useAntigravityCliAuth({
    enabled: !!antigravitySetup.status?.installed,
  })
  const ghAuth = useGhCliAuth({ enabled: !!ghSetup.status?.installed })

  const [step, _setStepRaw] = useState<OnboardingStep>('backend-select')
  const stepRef = useRef<OnboardingStep>('backend-select')
  const [historyStack, setHistoryStack] = useState<OnboardingStep[]>([])
  const setStep = useCallback(
    (next: OnboardingStep, opts?: { replace?: boolean }) => {
      const current = stepRef.current
      dbg('step:', current, '→', next, opts?.replace ? '(replace)' : '')
      if (
        !opts?.replace &&
        current !== next &&
        BACK_NAVIGABLE_STEPS.includes(current)
      ) {
        setHistoryStack(h =>
          h[h.length - 1] === current ? h : [...h, current]
        )
      }
      stepRef.current = next
      _setStepRaw(next)
    },
    []
  )
  const [selectedBackends, setSelectedBackends] = useState<AIBackend[]>([])
  const [, setActiveBackendIndex] = useState(0)

  const [claudeVersion, setClaudeVersion] = useState<string | null>(null)
  const [codexVersion, setCodexVersion] = useState<string | null>(null)
  const [opencodeVersion, setOpencodeVersion] = useState<string | null>(null)
  const [piVersion, setPiVersion] = useState<string | null>(null)
  const [commandcodeVersion, setCommandcodeVersion] = useState<string | null>(
    null
  )
  const [grokVersion, setGrokVersion] = useState<string | null>(null)
  const [antigravityVersion, setAntigravityVersion] = useState<string | null>(
    null
  )
  const [ghVersion, setGhVersion] = useState<string | null>(null)

  const [claudeInstallFailed, setClaudeInstallFailed] = useState(false)
  const [codexInstallFailed, setCodexInstallFailed] = useState(false)
  const [opencodeInstallFailed, setOpencodeInstallFailed] = useState(false)
  const [piInstallFailed, setPiInstallFailed] = useState(false)
  const [commandcodeInstallFailed, setCommandcodeInstallFailed] =
    useState(false)
  const [grokInstallFailed, setGrokInstallFailed] = useState(false)
  const [antigravityInstallFailed, setAntigravityInstallFailed] =
    useState(false)
  const [ghInstallFailed, setGhInstallFailed] = useState(false)
  const [claudePathSelected, setClaudePathSelected] = useState(false)
  const [codexPathSelected, setCodexPathSelected] = useState(false)
  const [opencodePathSelected, setOpencodePathSelected] = useState(false)
  const [piPathSelected, setPiPathSelected] = useState(false)
  const [commandcodePathSelected, setCommandcodePathSelected] = useState(false)
  const [grokPathSelected, setGrokPathSelected] = useState(false)
  const [antigravityPathSelected, setAntigravityPathSelected] =
    useState(false)
  const [ghPathSelected, setGhPathSelected] = useState(false)
  const [claudeLoginAttempt, setClaudeLoginAttempt] = useState(0)
  const [codexLoginAttempt, setCodexLoginAttempt] = useState(0)
  const [opencodeLoginAttempt, setOpencodeLoginAttempt] = useState(0)
  const [piLoginAttempt, setPiLoginAttempt] = useState(0)
  const [commandcodeLoginAttempt, setCommandcodeLoginAttempt] = useState(0)
  const [grokLoginAttempt, setGrokLoginAttempt] = useState(0)
  const [antigravityLoginAttempt, setAntigravityLoginAttempt] = useState(0)
  const [ghLoginAttempt, setGhLoginAttempt] = useState(0)

  const goBack = useCallback(() => {
    const current = stepRef.current
    // Sub-state back-out: on a *-setup step, the source picker and the
    // version installer are both rendered — "Back" from the installer should
    // first return to the picker, not pop step history.
    if (current === 'claude-setup' && claudePathSelected) {
      dbg('step: BACK (sub-state) claude-setup installer → picker')
      setClaudePathSelected(false)
      setClaudeInstallFailed(false)
      return
    }
    if (current === 'codex-setup' && codexPathSelected) {
      dbg('step: BACK (sub-state) codex-setup installer → picker')
      setCodexPathSelected(false)
      setCodexInstallFailed(false)
      return
    }
    if (current === 'opencode-setup' && opencodePathSelected) {
      dbg('step: BACK (sub-state) opencode-setup installer → picker')
      setOpencodePathSelected(false)
      setOpencodeInstallFailed(false)
      return
    }
    if (current === 'pi-setup' && piPathSelected) {
      dbg('step: BACK (sub-state) pi-setup installer → picker')
      setPiPathSelected(false)
      setPiInstallFailed(false)
      return
    }
    if (current === 'commandcode-setup' && commandcodePathSelected) {
      dbg('step: BACK (sub-state) commandcode-setup installer → picker')
      setCommandcodePathSelected(false)
      setCommandcodeInstallFailed(false)
      return
    }
    if (current === 'grok-setup' && grokPathSelected) {
      dbg('step: BACK (sub-state) grok-setup installer → picker')
      setGrokPathSelected(false)
      setGrokInstallFailed(false)
      return
    }
    if (current === 'antigravity-setup' && antigravityPathSelected) {
      dbg('step: BACK (sub-state) antigravity-setup installer → picker')
      setAntigravityPathSelected(false)
      setAntigravityInstallFailed(false)
      return
    }
    if (current === 'gh-setup' && ghPathSelected) {
      dbg('step: BACK (sub-state) gh-setup installer → picker')
      setGhPathSelected(false)
      setGhInstallFailed(false)
      return
    }

    setHistoryStack(h => {
      const prev = h.at(-1)
      if (!prev) return h
      dbg('step: BACK', stepRef.current, '→', prev)
      // Reset transient per-CLI state so the user lands on a fresh screen
      // (re-shows the path/Jean-managed picker, clears any prior install error).
      if (prev === 'claude-setup') {
        setClaudePathSelected(false)
        setClaudeInstallFailed(false)
      } else if (prev === 'codex-setup') {
        setCodexPathSelected(false)
        setCodexInstallFailed(false)
      } else if (prev === 'opencode-setup') {
        setOpencodePathSelected(false)
        setOpencodeInstallFailed(false)
      } else if (prev === 'pi-setup') {
        setPiPathSelected(false)
        setPiInstallFailed(false)
      } else if (prev === 'commandcode-setup') {
        setCommandcodePathSelected(false)
        setCommandcodeInstallFailed(false)
      } else if (prev === 'grok-setup') {
        setGrokPathSelected(false)
        setGrokInstallFailed(false)
      } else if (prev === 'antigravity-setup') {
        setAntigravityPathSelected(false)
        setAntigravityInstallFailed(false)
      } else if (prev === 'gh-setup') {
        setGhPathSelected(false)
        setGhInstallFailed(false)
      }
      stepRef.current = prev
      _setStepRaw(prev)
      return h.slice(0, -1)
    })
  }, [
    claudePathSelected,
    codexPathSelected,
    opencodePathSelected,
    piPathSelected,
    commandcodePathSelected,
    grokPathSelected,
    antigravityPathSelected,
    ghPathSelected,
  ])

  const isTransientStep =
    step.endsWith('-installing') || step.endsWith('-auth-checking')
  const hasSubStateBack =
    (step === 'claude-setup' && claudePathSelected) ||
    (step === 'codex-setup' && codexPathSelected) ||
    (step === 'opencode-setup' && opencodePathSelected) ||
    (step === 'pi-setup' && piPathSelected) ||
    (step === 'commandcode-setup' && commandcodePathSelected) ||
    (step === 'grok-setup' && grokPathSelected) ||
    (step === 'antigravity-setup' && antigravityPathSelected) ||
    (step === 'gh-setup' && ghPathSelected)
  const canGoBack =
    (historyStack.length > 0 || hasSubStateBack) &&
    step !== 'complete' &&
    !isTransientStep

  const initializedFlowRef = useRef(false)

  // Seed for terminal IDs - each retry increments an attempt counter to force a fresh PTY
  const loginSessionSeed = useMemo(
    // eslint-disable-next-line react-hooks/purity
    () => Date.now(),
    []
  )
  const claudeLoginTerminalId = `onboarding-claude-login-${loginSessionSeed}-${claudeLoginAttempt}`
  const codexLoginTerminalId = `onboarding-codex-login-${loginSessionSeed}-${codexLoginAttempt}`
  const opencodeLoginTerminalId = `onboarding-opencode-login-${loginSessionSeed}-${opencodeLoginAttempt}`
  const piLoginTerminalId = `onboarding-pi-login-${loginSessionSeed}-${piLoginAttempt}`
  const commandcodeLoginTerminalId = `onboarding-commandcode-login-${loginSessionSeed}-${commandcodeLoginAttempt}`
  const grokLoginTerminalId = `onboarding-grok-login-${loginSessionSeed}-${grokLoginAttempt}`
  const ghLoginTerminalId = `onboarding-gh-login-${loginSessionSeed}-${ghLoginAttempt}`
  const antigravityLoginTerminalId = `onboarding-antigravity-login-${loginSessionSeed}-${antigravityLoginAttempt}`

  const stableClaudeVersions = claudeSetup.versions.filter(v => !v.prerelease)
  const stableCodexVersions = codexSetup.versions.filter(v => !v.prerelease)
  const stableOpencodeVersions = opencodeSetup.versions.filter(
    v => !v.prerelease
  )
  const stablePiVersions = piSetup.versions.filter(v => !v.prerelease)
  const stableCommandcodeVersions = commandcodeSetup.versions.filter(
    v => !v.prerelease
  )
  const stableGrokVersions = grokSetup.versions.filter(v => !v.prerelease)
  const stableAntigravityVersions = antigravitySetup.versions.filter(
    v => !v.prerelease
  )
  const stableGhVersions = ghSetup.versions.filter(v => !v.prerelease)

  useEffect(() => {
    if (!claudeVersion && stableClaudeVersions.length > 0) {
      queueMicrotask(() =>
        setClaudeVersion(stableClaudeVersions[0]?.version ?? null)
      )
    }
  }, [claudeVersion, stableClaudeVersions])

  useEffect(() => {
    if (!codexVersion && stableCodexVersions.length > 0) {
      queueMicrotask(() =>
        setCodexVersion(stableCodexVersions[0]?.version ?? null)
      )
    }
  }, [codexVersion, stableCodexVersions])

  useEffect(() => {
    if (!opencodeVersion && stableOpencodeVersions.length > 0) {
      queueMicrotask(() =>
        setOpencodeVersion(stableOpencodeVersions[0]?.version ?? null)
      )
    }
  }, [opencodeVersion, stableOpencodeVersions])

  useEffect(() => {
    if (!piVersion && stablePiVersions.length > 0) {
      queueMicrotask(() => setPiVersion(stablePiVersions[0]?.version ?? null))
    }
  }, [piVersion, stablePiVersions])

  useEffect(() => {
    if (!commandcodeVersion && stableCommandcodeVersions.length > 0) {
      queueMicrotask(() =>
        setCommandcodeVersion(stableCommandcodeVersions[0]?.version ?? null)
      )
    }
  }, [commandcodeVersion, stableCommandcodeVersions])

  useEffect(() => {
    if (!grokVersion && stableGrokVersions.length > 0) {
      queueMicrotask(() =>
        setGrokVersion(stableGrokVersions[0]?.version ?? null)
      )
    }
  }, [grokVersion, stableGrokVersions])

  useEffect(() => {
    if (!antigravityVersion && stableAntigravityVersions.length > 0) {
      queueMicrotask(() =>
        setAntigravityVersion(stableAntigravityVersions[0]?.version ?? null)
      )
    }
  }, [antigravityVersion, stableAntigravityVersions])

  useEffect(() => {
    if (!ghVersion && stableGhVersions.length > 0) {
      queueMicrotask(() => setGhVersion(stableGhVersions[0]?.version ?? null))
    }
  }, [ghVersion, stableGhVersions])

  const isBackendReady = useCallback(
    (backend: AIBackend) => {
      let ready = false
      if (backend === 'claude') {
        ready =
          !!claudeSetup.status?.installed && !!claudeAuth.data?.authenticated
      } else if (backend === 'codex') {
        ready =
          !!codexSetup.status?.installed && !!codexAuth.data?.authenticated
      } else if (backend === 'opencode') {
        ready =
          !!opencodeSetup.status?.installed &&
          !!opencodeAuth.data?.authenticated
      } else if (backend === 'pi') {
        ready = !!piSetup.status?.installed && !!piAuth.data?.authenticated
      } else if (backend === 'commandcode') {
        ready =
          !!commandcodeSetup.status?.installed &&
          !!commandcodeAuth.data?.authenticated
      } else if (backend === 'grok') {
        ready = !!grokSetup.status?.installed && !!grokAuth.data?.authenticated
      } else {
        ready =
          !!antigravitySetup.status?.installed &&
          !!antigravityAuth.data?.authenticated
      }
      dbg('isBackendReady:', backend, '→', ready)
      return ready
    },
    [
      claudeSetup.status?.installed,
      claudeAuth.data?.authenticated,
      codexSetup.status?.installed,
      codexAuth.data?.authenticated,
      opencodeSetup.status?.installed,
      opencodeAuth.data?.authenticated,
      piSetup.status?.installed,
      piAuth.data?.authenticated,
      commandcodeSetup.status?.installed,
      commandcodeAuth.data?.authenticated,
      grokSetup.status?.installed,
      grokAuth.data?.authenticated,
      antigravitySetup.status?.installed,
      antigravityAuth.data?.authenticated,
    ]
  )

  const getNextStepForBackend = useCallback(
    (backend: AIBackend): OnboardingStep => {
      // Always route user through the *-setup step so they can confirm/change
      // the source (Jean-managed vs system PATH) and version. The picker
      // auto-advances to auth-checking when the user picks an already-ready
      // configuration, so this adds no friction for the happy path.
      const result = `${backend}-setup` as OnboardingStep
      dbg('getNextStepForBackend:', backend, '→', result)
      return result
    },
    []
  )

  const getNextStepAfterBackends = useCallback((): OnboardingStep => {
    // Always show gh-setup so the user can confirm source + auth.
    return 'gh-setup'
  }, [])

  const moveToNextBackendOrGh = useCallback(
    (currentBackend: AIBackend) => {
      dbg(
        'moveToNextBackendOrGh:',
        currentBackend,
        'selectedBackends:',
        selectedBackends
      )
      const currentIndex = selectedBackends.indexOf(currentBackend)
      for (let i = currentIndex + 1; i < selectedBackends.length; i += 1) {
        const backend = selectedBackends[i]
        if (!backend) continue
        const nextStep = getNextStepForBackend(backend)
        if (nextStep) {
          dbg(
            'moveToNextBackendOrGh: next backend =',
            backend,
            'step =',
            nextStep
          )
          setActiveBackendIndex(i)
          setStep(nextStep)
          return
        }
      }

      const afterBackends = getNextStepAfterBackends()
      dbg('moveToNextBackendOrGh: all backends done, next =', afterBackends)
      setStep(afterBackends)
    },
    [selectedBackends, getNextStepForBackend, getNextStepAfterBackends]
  )

  const aiBackendsLoading =
    claudeSetup.isStatusLoading ||
    codexSetup.isStatusLoading ||
    opencodeSetup.isStatusLoading ||
    piSetup.isStatusLoading ||
    commandcodeSetup.isStatusLoading ||
    grokSetup.isStatusLoading ||
    antigravitySetup.isStatusLoading ||
    (claudeSetup.status?.installed &&
      (claudeAuth.isLoading || claudeAuth.isFetching)) ||
    (codexSetup.status?.installed &&
      (codexAuth.isLoading || codexAuth.isFetching)) ||
    (opencodeSetup.status?.installed &&
      (opencodeAuth.isLoading || opencodeAuth.isFetching)) ||
    (piSetup.status?.installed && (piAuth.isLoading || piAuth.isFetching)) ||
    (commandcodeSetup.status?.installed &&
      (commandcodeAuth.isLoading || commandcodeAuth.isFetching)) ||
    (grokSetup.status?.installed && (grokAuth.isLoading || grokAuth.isFetching)) ||
    (antigravitySetup.status?.installed &&
      (antigravityAuth.isLoading || antigravityAuth.isFetching))

  const loadingInitialState =
    claudeSetup.isStatusLoading ||
    codexSetup.isStatusLoading ||
    opencodeSetup.isStatusLoading ||
    piSetup.isStatusLoading ||
    commandcodeSetup.isStatusLoading ||
    grokSetup.isStatusLoading ||
    antigravitySetup.isStatusLoading ||
    ghSetup.isStatusLoading ||
    (claudeSetup.status?.installed &&
      (claudeAuth.isLoading || claudeAuth.isFetching)) ||
    (codexSetup.status?.installed &&
      (codexAuth.isLoading || codexAuth.isFetching)) ||
    (opencodeSetup.status?.installed &&
      (opencodeAuth.isLoading || opencodeAuth.isFetching)) ||
    (piSetup.status?.installed && (piAuth.isLoading || piAuth.isFetching)) ||
    (commandcodeSetup.status?.installed &&
      (commandcodeAuth.isLoading || commandcodeAuth.isFetching)) ||
    (grokSetup.status?.installed &&
      (grokAuth.isLoading || grokAuth.isFetching)) ||
    (antigravitySetup.status?.installed &&
      (antigravityAuth.isLoading || antigravityAuth.isFetching)) ||
    (ghSetup.status?.installed && (ghAuth.isLoading || ghAuth.isFetching))

  dbg('loadingInitialState:', loadingInitialState, {
    claudeStatusLoading: claudeSetup.isStatusLoading,
    codexStatusLoading: codexSetup.isStatusLoading,
    opencodeStatusLoading: opencodeSetup.isStatusLoading,
    piStatusLoading: piSetup.isStatusLoading,
    commandcodeStatusLoading: commandcodeSetup.isStatusLoading,
    grokStatusLoading: grokSetup.isStatusLoading,
    antigravityStatusLoading: antigravitySetup.isStatusLoading,
    ghStatusLoading: ghSetup.isStatusLoading,
    claudeInstalled: claudeSetup.status?.installed,
    codexInstalled: codexSetup.status?.installed,
    opencodeInstalled: opencodeSetup.status?.installed,
    piInstalled: piSetup.status?.installed,
    commandcodeInstalled: commandcodeSetup.status?.installed,
    grokInstalled: grokSetup.status?.installed,
    antigravityInstalled: antigravitySetup.status?.installed,
    ghInstalled: ghSetup.status?.installed,
    claudeAuthLoading: claudeAuth.isLoading,
    codexAuthLoading: codexAuth.isLoading,
    opencodeAuthLoading: opencodeAuth.isLoading,
    piAuthLoading: piAuth.isLoading,
    commandcodeAuthLoading: commandcodeAuth.isLoading,
    grokAuthLoading: grokAuth.isLoading,
    antigravityAuthLoading: antigravityAuth.isLoading,
    ghAuthLoading: ghAuth.isLoading,
  })

  useEffect(() => {
    if (!onboardingOpen) {
      initializedFlowRef.current = false
      setHistoryStack([])
      return
    }

    if (loadingInitialState || initializedFlowRef.current || !preferences) {
      dbg(
        'init effect: skipped (loading:',
        loadingInitialState,
        'initialized:',
        initializedFlowRef.current,
        ')'
      )
      return
    }

    dbg('init effect: INITIALIZING FLOW')
    initializedFlowRef.current = true

    queueMicrotask(() => {
      setClaudeInstallFailed(false)
      setCodexInstallFailed(false)
      setOpencodeInstallFailed(false)
      setPiInstallFailed(false)
      setCommandcodeInstallFailed(false)
      setGrokInstallFailed(false)
      setGhInstallFailed(false)
      setClaudePathSelected(false)
      setCodexPathSelected(false)
      setOpencodePathSelected(false)
      setPiPathSelected(false)
      setCommandcodePathSelected(false)
      setGrokPathSelected(false)
      setGhPathSelected(false)
      setClaudeLoginAttempt(0)
      setCodexLoginAttempt(0)
      setOpencodeLoginAttempt(0)
      setPiLoginAttempt(0)
      setCommandcodeLoginAttempt(0)
      setGrokLoginAttempt(0)
      setGhLoginAttempt(0)
    })

    // On Windows, show WSL mode selection first if not yet chosen
    if (
      isServerWindows() &&
      preferences &&
      !preferences.wsl_mode_chosen &&
      !onboardingStartStep
    ) {
      dbg('init effect: Windows + WSL not chosen → wsl-setup')
      queueMicrotask(() => setStep('wsl-setup', { replace: true }))
      return
    }

    if (onboardingStartStep === 'gh') {
      dbg('init effect: startStep=gh → gh-setup')
      queueMicrotask(() => {
        setStep('gh-setup', { replace: true })
        setOnboardingStartStep(null)
      })
      return
    }

    if (onboardingStartStep === 'claude') {
      dbg('init effect: startStep=claude → claude-setup')
      queueMicrotask(() => {
        setSelectedBackends(['claude'])
        setActiveBackendIndex(0)
        setStep('claude-setup', { replace: true })
        setOnboardingStartStep(null)
      })
      return
    }

    const readyBackends = AI_BACKENDS.filter(isBackendReady)
    const ghReady = !!ghSetup.status?.installed && !!ghAuth.data?.authenticated
    dbg(
      'init effect: readyBackends:',
      readyBackends,
      'ghReady:',
      ghReady,
      'manuallyTriggered:',
      onboardingManuallyTriggered
    )

    // When manually triggered, always start at wsl-setup on Windows so users
    // can change their WSL/native choice, then backend-select (via Continue
    // on the WSL step). Non-Windows goes straight to backend-select.
    if (onboardingManuallyTriggered) {
      const firstStep: OnboardingStep = isServerWindows()
        ? 'wsl-setup'
        : 'backend-select'
      dbg('init effect: manual trigger →', firstStep)
      queueMicrotask(() => {
        setSelectedBackends(readyBackends)
        setStep(firstStep, { replace: true })
      })
      return
    }

    if (ghReady && readyBackends.length > 0) {
      dbg('init effect: all ready → complete')
      queueMicrotask(() => setStep('complete', { replace: true }))
      return
    }

    if (readyBackends.length > 0) {
      dbg('init effect: some backends ready → skip to after backends')
      queueMicrotask(() => {
        setSelectedBackends(readyBackends)
        setStep(getNextStepAfterBackends(), { replace: true })
      })
      return
    }

    dbg('init effect: nothing ready → backend-select')
    queueMicrotask(() => setStep('backend-select', { replace: true }))
  }, [
    onboardingOpen,
    onboardingStartStep,
    setOnboardingStartStep,
    onboardingManuallyTriggered,
    loadingInitialState,
    isBackendReady,
    ghSetup.status?.installed,
    ghAuth.data?.authenticated,
    getNextStepAfterBackends,
    preferences,
  ])

  // Handle AI backend auth check steps
  useEffect(() => {
    if (step !== 'claude-auth-checking') return
    dbg('claude-auth-checking effect:', {
      isLoading: claudeAuth.isLoading,
      isFetching: claudeAuth.isFetching,
      status: claudeAuth.status,
      fetchStatus: claudeAuth.fetchStatus,
      authenticated: claudeAuth.data?.authenticated,
      error: claudeAuth.error,
      enabled: !!claudeSetup.status?.installed,
    })
    if (claudeAuth.isLoading || claudeAuth.isFetching) return

    if (claudeAuth.data?.authenticated) {
      dbg('claude auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('claude'))
    } else {
      dbg('claude auth NOT OK → claude-auth-login')
      queueMicrotask(() => setStep('claude-auth-login'))
    }
  }, [
    step,
    claudeAuth.isLoading,
    claudeAuth.isFetching,
    claudeAuth.data?.authenticated,
    claudeAuth.status,
    claudeAuth.fetchStatus,
    claudeAuth.error,
    claudeSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'codex-auth-checking') return
    dbg('codex-auth-checking effect:', {
      isLoading: codexAuth.isLoading,
      isFetching: codexAuth.isFetching,
      status: codexAuth.status,
      fetchStatus: codexAuth.fetchStatus,
      authenticated: codexAuth.data?.authenticated,
      error: codexAuth.error,
      enabled: !!codexSetup.status?.installed,
    })
    if (codexAuth.isLoading || codexAuth.isFetching) return

    if (codexAuth.data?.authenticated) {
      dbg('codex auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('codex'))
    } else {
      dbg('codex auth NOT OK → codex-auth-login')
      queueMicrotask(() => setStep('codex-auth-login'))
    }
  }, [
    step,
    codexAuth.isLoading,
    codexAuth.isFetching,
    codexAuth.data?.authenticated,
    codexAuth.status,
    codexAuth.fetchStatus,
    codexAuth.error,
    codexSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'opencode-auth-checking') return
    dbg('opencode-auth-checking effect:', {
      isLoading: opencodeAuth.isLoading,
      isFetching: opencodeAuth.isFetching,
      status: opencodeAuth.status,
      fetchStatus: opencodeAuth.fetchStatus,
      authenticated: opencodeAuth.data?.authenticated,
      error: opencodeAuth.error,
      enabled: !!opencodeSetup.status?.installed,
    })
    if (opencodeAuth.isLoading || opencodeAuth.isFetching) return

    if (opencodeAuth.data?.authenticated) {
      dbg('opencode auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('opencode'))
    } else {
      dbg('opencode auth NOT OK → opencode-auth-login')
      queueMicrotask(() => setStep('opencode-auth-login'))
    }
  }, [
    step,
    opencodeAuth.isLoading,
    opencodeAuth.isFetching,
    opencodeAuth.data?.authenticated,
    opencodeAuth.status,
    opencodeAuth.fetchStatus,
    opencodeAuth.error,
    opencodeSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'pi-auth-checking') return
    if (piAuth.isLoading || piAuth.isFetching) return

    if (piAuth.data?.authenticated) {
      queueMicrotask(() => moveToNextBackendOrGh('pi'))
    } else {
      queueMicrotask(() => setStep('pi-auth-login'))
    }
  }, [
    step,
    piAuth.isLoading,
    piAuth.isFetching,
    piAuth.data?.authenticated,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'commandcode-auth-checking') return
    if (commandcodeAuth.isLoading || commandcodeAuth.isFetching) return

    if (commandcodeAuth.data?.authenticated) {
      queueMicrotask(() => moveToNextBackendOrGh('commandcode'))
    } else {
      queueMicrotask(() => setStep('commandcode-auth-login'))
    }
  }, [
    step,
    commandcodeAuth.isLoading,
    commandcodeAuth.isFetching,
    commandcodeAuth.data?.authenticated,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'grok-auth-checking') return
    if (grokAuth.isLoading || grokAuth.isFetching) return

    if (grokAuth.data?.authenticated) {
      queueMicrotask(() => moveToNextBackendOrGh('grok'))
    } else {
      queueMicrotask(() => setStep('grok-auth-login'))
    }
  }, [
    step,
    grokAuth.isLoading,
    grokAuth.isFetching,
    grokAuth.data?.authenticated,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'antigravity-auth-checking') return
    dbg('antigravity-auth-checking effect:', {
      isLoading: antigravityAuth.isLoading,
      isFetching: antigravityAuth.isFetching,
      status: antigravityAuth.status,
      fetchStatus: antigravityAuth.fetchStatus,
      authenticated: antigravityAuth.data?.authenticated,
      error: antigravityAuth.error,
      enabled: !!antigravitySetup.status?.installed,
    })
    if (antigravityAuth.isLoading || antigravityAuth.isFetching) return

    if (antigravityAuth.data?.authenticated) {
      dbg('antigravity auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('antigravity'))
    } else {
      dbg('antigravity auth NOT OK → antigravity-auth-login')
      queueMicrotask(() => setStep('antigravity-auth-login'))
    }
  }, [
    step,
    antigravityAuth.isLoading,
    antigravityAuth.isFetching,
    antigravityAuth.data?.authenticated,
    antigravityAuth.status,
    antigravityAuth.fetchStatus,
    antigravityAuth.error,
    antigravitySetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'gh-auth-checking') return
    dbg('gh-auth-checking effect:', {
      isLoading: ghAuth.isLoading,
      isFetching: ghAuth.isFetching,
      status: ghAuth.status,
      fetchStatus: ghAuth.fetchStatus,
      authenticated: ghAuth.data?.authenticated,
      error: ghAuth.error,
      enabled: !!ghSetup.status?.installed,
    })
    if (ghAuth.isLoading || ghAuth.isFetching) return

    if (ghAuth.data?.authenticated) {
      dbg('gh auth OK → complete')
      queueMicrotask(() => setStep('complete'))
    } else {
      dbg('gh auth NOT OK → gh-auth-login')
      queueMicrotask(() => setStep('gh-auth-login'))
    }
  }, [
    step,
    ghAuth.isLoading,
    ghAuth.isFetching,
    ghAuth.data?.authenticated,
    ghAuth.status,
    ghAuth.fetchStatus,
    ghAuth.error,
    ghSetup.status?.installed,
    setStep,
  ])

  const handleBackendToggle = useCallback(
    (backend: AIBackend, checked: boolean) => {
      setSelectedBackends(prev => {
        if (checked) {
          if (prev.includes(backend)) return prev
          return [...prev, backend]
        }
        return prev.filter(b => b !== backend)
      })
    },
    []
  )

  const handleBackendSelectionContinue = useCallback(() => {
    dbg('handleBackendSelectionContinue: selectedBackends =', selectedBackends)
    if (selectedBackends.length === 0 && !onboardingManuallyTriggered) {
      toast.warning('Select at least one AI backend to continue.')
      return
    }

    for (let i = 0; i < selectedBackends.length; i += 1) {
      const backend = selectedBackends[i]
      if (!backend) continue
      const nextStep = getNextStepForBackend(backend)
      if (nextStep) {
        dbg(
          'handleBackendSelectionContinue: first backend =',
          backend,
          'step =',
          nextStep
        )
        setActiveBackendIndex(i)
        setStep(nextStep)
        return
      }
    }

    const afterBackends = getNextStepAfterBackends()
    dbg(
      'handleBackendSelectionContinue: all backends ready, next =',
      afterBackends
    )
    setStep(afterBackends)
  }, [
    selectedBackends,
    onboardingManuallyTriggered,
    getNextStepForBackend,
    getNextStepAfterBackends,
  ])

  const handleClaudeInstall = useCallback(() => {
    dbg('handleClaudeInstall: version =', claudeVersion)
    if (!claudeVersion) return
    setStep('claude-installing')
    claudeSetup.install(claudeVersion, {
      onSuccess: () => {
        dbg('handleClaudeInstall: SUCCESS, moving to auth-checking')
        setStep('claude-auth-checking')
        claudeAuth.refetch()
      },
      onError: () => {
        dbg('handleClaudeInstall: FAILED')
        setClaudeInstallFailed(true)
        setStep('claude-setup')
      },
    })
  }, [claudeVersion, claudeSetup, claudeAuth])

  const handleClaudeJeanSelect = useCallback(() => {
    dbg('handleClaudeJeanSelect: saving claude_cli_source=jean')
    setClaudePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { claude_cli_source: 'jean' },
      {
        onSuccess: () => {
          // If Claude is already installed via Jean, skip the reinstall step
          // and jump straight to authentication.
          if (claudeSetup.status?.installed) {
            setStep('claude-auth-checking')
            claudeAuth.refetch()
          }
          // Otherwise the conditional in the JSX falls through to SetupState
          // (the version installer) since claudePathSelected is now true.
        },
        onError: err => {
          dbg('handleClaudeJeanSelect: FAILED to save preference', err)
          setClaudePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    claudeSetup.status?.installed,
    claudeAuth,
    setStep,
  ])

  const handleClaudePathSelect = useCallback(() => {
    dbg('handleClaudePathSelect: saving claude_cli_source=path')
    setClaudePathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { claude_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleClaudePathSelect: preference saved, refetching auth')
            setStep('claude-auth-checking')
            claudeAuth.refetch()
          },
          onError: err => {
            dbg('handleClaudePathSelect: FAILED to save preference', err)
            setClaudePathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, claudeAuth, setStep])

  const handleCodexJeanSelect = useCallback(() => {
    dbg('handleCodexJeanSelect: saving codex_cli_source=jean')
    setCodexPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { codex_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (codexSetup.status?.installed) {
            setStep('codex-auth-checking')
            codexAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleCodexJeanSelect: FAILED to save preference', err)
          setCodexPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    codexSetup.status?.installed,
    codexAuth,
    setStep,
  ])

  const handleOpencodeJeanSelect = useCallback(() => {
    dbg('handleOpencodeJeanSelect: saving opencode_cli_source=jean')
    setOpencodePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { opencode_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (opencodeSetup.status?.installed) {
            setStep('opencode-auth-checking')
            opencodeAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleOpencodeJeanSelect: FAILED to save preference', err)
          setOpencodePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    opencodeSetup.status?.installed,
    opencodeAuth,
    setStep,
  ])

  const handlePiJeanSelect = useCallback(() => {
    setPiPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { pi_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (piSetup.status?.installed) {
            setStep('pi-auth-checking')
            piAuth.refetch()
          }
        },
        onError: () => {
          setPiPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    piSetup.status?.installed,
    piAuth,
    setStep,
  ])

  const handleCommandcodeJeanSelect = useCallback(() => {
    setCommandcodePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { commandcode_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (commandcodeSetup.status?.installed) {
            setStep('commandcode-auth-checking')
            commandcodeAuth.refetch()
          }
        },
        onError: () => {
          setCommandcodePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    commandcodeSetup.status?.installed,
    commandcodeAuth,
    setStep,
  ])

  const handleGrokJeanSelect = useCallback(() => {
    setGrokPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { grok_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (grokSetup.status?.installed) {
            setStep('grok-auth-checking')
            grokAuth.refetch()
          }
        },
        onError: () => {
          setGrokPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    grokSetup.status?.installed,
    grokAuth,
    setStep,
  ])

  const handleGhJeanSelect = useCallback(() => {
    dbg('handleGhJeanSelect: saving gh_cli_source=jean')
    setGhPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { gh_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (ghSetup.status?.installed) {
            setStep('gh-auth-checking')
            ghAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleGhJeanSelect: FAILED to save preference', err)
          setGhPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    ghSetup.status?.installed,
    ghAuth,
    setStep,
  ])

  const handleCodexPathSelect = useCallback(() => {
    dbg('handleCodexPathSelect: saving codex_cli_source=path')
    setCodexPathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { codex_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleCodexPathSelect: preference saved, refetching auth')
            setStep('codex-auth-checking')
            codexAuth.refetch()
          },
          onError: err => {
            dbg('handleCodexPathSelect: FAILED to save preference', err)
            setCodexPathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, codexAuth, setStep])

  const handleOpencodePathSelect = useCallback(() => {
    dbg('handleOpencodePathSelect: saving opencode_cli_source=path')
    setOpencodePathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { opencode_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleOpencodePathSelect: preference saved, refetching auth')
            setStep('opencode-auth-checking')
            opencodeAuth.refetch()
          },
          onError: err => {
            dbg('handleOpencodePathSelect: FAILED to save preference', err)
            setOpencodePathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, opencodeAuth, setStep])

  const handlePiPathSelect = useCallback(() => {
    setPiPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { pi_cli_source: 'path' },
      {
        onSuccess: () => {
          setStep('pi-auth-checking')
          piAuth.refetch()
        },
        onError: () => {
          setPiPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [preferences, patchPreferences, piAuth, setStep])

  const handleCommandcodePathSelect = useCallback(() => {
    setCommandcodePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { commandcode_cli_source: 'path' },
      {
        onSuccess: () => {
          setStep('commandcode-auth-checking')
          commandcodeAuth.refetch()
        },
        onError: () => {
          setCommandcodePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [preferences, patchPreferences, commandcodeAuth, setStep])

  const handleGrokPathSelect = useCallback(() => {
    setGrokPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { grok_cli_source: 'path' },
      {
        onSuccess: () => {
          setStep('grok-auth-checking')
          grokAuth.refetch()
        },
        onError: () => {
          setGrokPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [preferences, patchPreferences, grokAuth, setStep])

  const handleAntigravityJeanSelect = useCallback(() => {
    dbg('handleAntigravityJeanSelect: saving antigravity_cli_source=jean')
    setAntigravityPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { antigravity_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (antigravitySetup.status?.installed) {
            setStep('antigravity-auth-checking')
            antigravityAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleAntigravityJeanSelect: FAILED to save preference', err)
          setAntigravityPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    antigravitySetup.status?.installed,
    antigravityAuth,
    setStep,
  ])

  const handleAntigravityPathSelect = useCallback(() => {
    dbg('handleAntigravityPathSelect: saving antigravity_cli_source=path')
    setAntigravityPathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { antigravity_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg(
              'handleAntigravityPathSelect: preference saved, refetching auth'
            )
            setStep('antigravity-auth-checking')
            antigravityAuth.refetch()
          },
          onError: err => {
            dbg('handleAntigravityPathSelect: FAILED to save preference', err)
            setAntigravityPathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, antigravityAuth, setStep])

  const handleGhPathSelect = useCallback(() => {
    dbg('handleGhPathSelect: saving gh_cli_source=path')
    setGhPathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { gh_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleGhPathSelect: preference saved, refetching auth')
            setStep('gh-auth-checking')
            ghAuth.refetch()
          },
          onError: err => {
            dbg('handleGhPathSelect: FAILED to save preference', err)
            setGhPathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, ghAuth, setStep])

  const handleCodexInstall = useCallback(() => {
    dbg('handleCodexInstall: version =', codexVersion)
    if (!codexVersion) return
    setStep('codex-installing')
    codexSetup.install(codexVersion, {
      onSuccess: () => {
        dbg('handleCodexInstall: SUCCESS, moving to auth-checking')
        setStep('codex-auth-checking')
        codexAuth.refetch()
      },
      onError: () => {
        dbg('handleCodexInstall: FAILED')
        setCodexInstallFailed(true)
        setStep('codex-setup')
      },
    })
  }, [codexVersion, codexSetup, codexAuth])

  const handleOpencodeInstall = useCallback(() => {
    dbg('handleOpencodeInstall: version =', opencodeVersion)
    if (!opencodeVersion) return
    setStep('opencode-installing')
    opencodeSetup.install(opencodeVersion, {
      onSuccess: () => {
        dbg('handleOpencodeInstall: SUCCESS, moving to auth-checking')
        setStep('opencode-auth-checking')
        opencodeAuth.refetch()
      },
      onError: () => {
        dbg('handleOpencodeInstall: FAILED')
        setOpencodeInstallFailed(true)
        setStep('opencode-setup')
      },
    })
  }, [opencodeVersion, opencodeSetup, opencodeAuth])

  const handlePiInstall = useCallback(() => {
    if (!piVersion) return
    setStep('pi-installing')
    piSetup.install(piVersion, {
      onSuccess: () => {
        setStep('pi-auth-checking')
        piAuth.refetch()
      },
      onError: () => {
        setPiInstallFailed(true)
        setStep('pi-setup')
      },
    })
  }, [piVersion, piSetup, piAuth])

  const handleCommandcodeInstall = useCallback(() => {
    if (!commandcodeVersion) return
    setStep('commandcode-installing')
    commandcodeSetup.install(commandcodeVersion, {
      onSuccess: () => {
        setStep('commandcode-auth-checking')
        commandcodeAuth.refetch()
      },
      onError: () => {
        setCommandcodeInstallFailed(true)
        setStep('commandcode-setup')
      },
    })
  }, [commandcodeVersion, commandcodeSetup, commandcodeAuth])

  const handleGrokInstall = useCallback(() => {
    if (!grokVersion) return
    setStep('grok-installing')
    grokSetup.install(grokVersion, {
      onSuccess: () => {
        setStep('grok-auth-checking')
        grokAuth.refetch()
      },
      onError: () => {
        setGrokInstallFailed(true)
        setStep('grok-setup')
      },
    })
  }, [grokVersion, grokSetup, grokAuth])

  const handleAntigravityInstall = useCallback(() => {
    dbg('handleAntigravityInstall: version =', antigravityVersion)
    if (!antigravityVersion) return
    setStep('antigravity-installing')
    antigravitySetup.install(antigravityVersion, {
      onSuccess: () => {
        dbg('handleAntigravityInstall: SUCCESS, moving to auth-checking')
        setStep('antigravity-auth-checking')
        antigravityAuth.refetch()
      },
      onError: () => {
        dbg('handleAntigravityInstall: FAILED')
        setAntigravityInstallFailed(true)
        setStep('antigravity-setup')
      },
    })
  }, [antigravityVersion, antigravitySetup, antigravityAuth])

  const handleGhInstall = useCallback(() => {
    dbg('handleGhInstall: version =', ghVersion)
    if (!ghVersion) return
    setStep('gh-installing')
    ghSetup.install(ghVersion, {
      onSuccess: () => {
        dbg('handleGhInstall: SUCCESS, moving to auth-checking')
        setStep('gh-auth-checking')
        ghAuth.refetch()
      },
      onError: () => {
        dbg('handleGhInstall: FAILED')
        setGhInstallFailed(true)
        setStep('gh-setup')
      },
    })
  }, [ghVersion, ghSetup, ghAuth])

  const handleClaudeLoginComplete = useCallback(async () => {
    dbg('handleClaudeLoginComplete: refetching auth')
    setStep('claude-auth-checking')
    const result = await claudeAuth.refetch()
    dbg('handleClaudeLoginComplete: refetch result =', result.data)
  }, [claudeAuth, setStep])

  const handleCodexLoginComplete = useCallback(async () => {
    dbg('handleCodexLoginComplete: refetching auth')
    setStep('codex-auth-checking')
    const result = await codexAuth.refetch()
    dbg('handleCodexLoginComplete: refetch result =', result.data)
  }, [codexAuth, setStep])

  const handleOpencodeLoginComplete = useCallback(async () => {
    dbg('handleOpencodeLoginComplete: refetching auth')
    setStep('opencode-auth-checking')
    const result = await opencodeAuth.refetch()
    dbg('handleOpencodeLoginComplete: refetch result =', result.data)
  }, [opencodeAuth, setStep])

  const handlePiLoginComplete = useCallback(async () => {
    setStep('pi-auth-checking')
    await piAuth.refetch()
  }, [piAuth, setStep])

  const handleCommandcodeLoginComplete = useCallback(async () => {
    setStep('commandcode-auth-checking')
    await commandcodeAuth.refetch()
  }, [commandcodeAuth, setStep])

  const handleGrokLoginComplete = useCallback(async () => {
    setStep('grok-auth-checking')
    await grokAuth.refetch()
  }, [grokAuth, setStep])

  const handleAntigravityLoginComplete = useCallback(async () => {
    dbg('handleAntigravityLoginComplete: refetching auth')
    setStep('antigravity-auth-checking')
    const result = await antigravityAuth.refetch()
    dbg('handleAntigravityLoginComplete: refetch result =', result.data)
  }, [antigravityAuth, setStep])

  const handleGhLoginComplete = useCallback(async () => {
    dbg('handleGhLoginComplete: refetching auth')
    setStep('gh-auth-checking')
    const result = await ghAuth.refetch()
    dbg('handleGhLoginComplete: refetch result =', result.data)
  }, [ghAuth, setStep])

  const handleClaudeLoginRetry = useCallback(() => {
    setClaudeLoginAttempt(prev => prev + 1)
  }, [])

  const handleCodexLoginRetry = useCallback(() => {
    setCodexLoginAttempt(prev => prev + 1)
  }, [])

  const handleOpencodeLoginRetry = useCallback(() => {
    setOpencodeLoginAttempt(prev => prev + 1)
  }, [])

  const handlePiLoginRetry = useCallback(() => {
    setPiLoginAttempt(prev => prev + 1)
  }, [])

  const handleCommandcodeLoginRetry = useCallback(() => {
    setCommandcodeLoginAttempt(prev => prev + 1)
  }, [])

  const handleGrokLoginRetry = useCallback(() => {
    setGrokLoginAttempt(prev => prev + 1)
  }, [])

  const handleAntigravityLoginRetry = useCallback(() => {
    setAntigravityLoginAttempt(prev => prev + 1)
  }, [])

  const handleGhLoginRetry = useCallback(() => {
    setGhLoginAttempt(prev => prev + 1)
  }, [])

  const handleComplete = useCallback(() => {
    claudeSetup.refetchStatus()
    codexSetup.refetchStatus()
    opencodeSetup.refetchStatus()
    piSetup.refetchStatus()
    commandcodeSetup.refetchStatus()
    grokSetup.refetchStatus()
    antigravitySetup.refetchStatus()
    ghSetup.refetchStatus()
    // Set the first selected backend as the default so the preference
    // isn't left pointing at an uninstalled backend (e.g. 'claude').
    const [firstBackend] = selectedBackends
    if (firstBackend && preferences) {
      const magicDefaults = magicDefaultsForBackend(firstBackend)
      patchPreferences.mutate({
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
    // Atomically close onboarding and mark as dismissed so it doesn't reappear on reload
    useUIStore.setState({
      onboardingOpen: false,
      onboardingStartStep: null,
      onboardingDismissed: true,
    })
  }, [
    claudeSetup,
    codexSetup,
    opencodeSetup,
    piSetup,
    commandcodeSetup,
    grokSetup,
    antigravitySetup,
    ghSetup,
    selectedBackends,
    preferences,
    patchPreferences,
  ])

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

  const getCliSetupData = (): CliSetupData | null => {
    if (step === 'claude-setup' || step === 'claude-installing') {
      return {
        type: 'claude',
        title: 'Claude CLI',
        description: 'Claude CLI enables Anthropic-backed AI sessions.',
        versions: stableClaudeVersions,
        isVersionsLoading: claudeSetup.isVersionsLoading,
        isVersionsError: claudeSetup.isVersionsError,
        onRetryVersions: claudeSetup.refetchVersions,
        isInstalling: claudeSetup.isInstalling,
        installError: claudeInstallFailed ? claudeSetup.installError : null,
        progress: claudeSetup.progress,
        install: claudeSetup.install,
        currentVersion: claudeSetup.status?.version,
      }
    }

    if (step === 'codex-setup' || step === 'codex-installing') {
      return {
        type: 'codex',
        title: 'Codex CLI',
        description: 'Codex CLI enables OpenAI-backed AI sessions.',
        versions: stableCodexVersions,
        isVersionsLoading: codexSetup.isVersionsLoading,
        isVersionsError: codexSetup.isVersionsError,
        onRetryVersions: codexSetup.refetchVersions,
        isInstalling: codexSetup.isInstalling,
        installError: codexInstallFailed ? codexSetup.installError : null,
        progress: codexSetup.progress,
        install: codexSetup.install,
        currentVersion: codexSetup.status?.version,
      }
    }

    if (step === 'opencode-setup' || step === 'opencode-installing') {
      return {
        type: 'opencode',
        title: 'OpenCode CLI',
        description: 'OpenCode CLI enables OpenCode-backed AI sessions.',
        versions: stableOpencodeVersions,
        isVersionsLoading: opencodeSetup.isVersionsLoading,
        isVersionsError: opencodeSetup.isVersionsError,
        onRetryVersions: opencodeSetup.refetchVersions,
        isInstalling: opencodeSetup.isInstalling,
        installError: opencodeInstallFailed ? opencodeSetup.installError : null,
        progress: opencodeSetup.progress,
        install: opencodeSetup.install,
        currentVersion: opencodeSetup.status?.version,
      }
    }

    if (step === 'pi-setup' || step === 'pi-installing') {
      return {
        type: 'pi',
        title: 'PI CLI',
        description: 'PI CLI enables PI-backed AI sessions.',
        versions: stablePiVersions,
        isVersionsLoading: piSetup.isVersionsLoading,
        isVersionsError: piSetup.isVersionsError,
        onRetryVersions: piSetup.refetchVersions,
        isInstalling: piSetup.isInstalling,
        installError: piInstallFailed ? piSetup.installError : null,
        progress: piSetup.progress,
        install: piSetup.install,
        currentVersion: piSetup.status?.version,
      }
    }

    if (step === 'commandcode-setup' || step === 'commandcode-installing') {
      return {
        type: 'commandcode',
        title: 'Command Code CLI',
        description:
          'Command Code CLI enables Command Code-backed AI sessions.',
        versions: stableCommandcodeVersions,
        isVersionsLoading: commandcodeSetup.isVersionsLoading,
        isVersionsError: commandcodeSetup.isVersionsError,
        onRetryVersions: commandcodeSetup.refetchVersions,
        isInstalling: commandcodeSetup.isInstalling,
        installError: commandcodeInstallFailed
          ? commandcodeSetup.installError
          : null,
        progress: commandcodeSetup.progress,
        install: commandcodeSetup.install,
        currentVersion: commandcodeSetup.status?.version,
      }
    }

    if (step === 'grok-setup' || step === 'grok-installing') {
      return {
        type: 'grok',
        title: 'Grok CLI',
        description: 'Grok CLI enables Grok-backed AI sessions.',
        versions: stableGrokVersions,
        isVersionsLoading: grokSetup.isVersionsLoading,
        isVersionsError: grokSetup.isVersionsError,
        onRetryVersions: grokSetup.refetchVersions,
        isInstalling: grokSetup.isInstalling,
        installError: grokInstallFailed ? grokSetup.installError : null,
        progress: grokSetup.progress,
        install: grokSetup.install,
        currentVersion: grokSetup.status?.version,
      }
    }

    if (step === 'antigravity-setup' || step === 'antigravity-installing') {
      return {
        type: 'antigravity',
        title: 'Antigravity CLI',
        description: 'Antigravity CLI enables Antigravity-backed AI sessions.',
        versions: stableAntigravityVersions,
        isVersionsLoading: antigravitySetup.isVersionsLoading,
        isVersionsError: antigravitySetup.isVersionsError,
        onRetryVersions: antigravitySetup.refetchVersions,
        isInstalling: antigravitySetup.isInstalling,
        installError: antigravityInstallFailed
          ? antigravitySetup.installError
          : null,
        progress: antigravitySetup.progress,
        install: antigravitySetup.install,
        currentVersion: antigravitySetup.status?.version,
      }
    }

    if (step === 'gh-setup' || step === 'gh-installing') {
      return {
        type: 'gh',
        title: 'GitHub CLI',
        description: 'GitHub CLI is required for GitHub integration.',
        versions: stableGhVersions,
        isVersionsLoading: ghSetup.isVersionsLoading,
        isVersionsError: ghSetup.isVersionsError,
        onRetryVersions: ghSetup.refetchVersions,
        isInstalling: ghSetup.isInstalling,
        installError: ghInstallFailed ? ghSetup.installError : null,
        progress: ghSetup.progress,
        install: ghSetup.install,
        currentVersion: ghSetup.status?.version,
      }
    }

    return null
  }

  const cliData = getCliSetupData()

  const isClaudeReinstall =
    claudeSetup.status?.installed && step === 'claude-setup'
  const isCodexReinstall =
    codexSetup.status?.installed && step === 'codex-setup'
  const isOpencodeReinstall =
    opencodeSetup.status?.installed && step === 'opencode-setup'
  const isPiReinstall = piSetup.status?.installed && step === 'pi-setup'
  const isCommandcodeReinstall =
    commandcodeSetup.status?.installed && step === 'commandcode-setup'
  const isGrokReinstall = grokSetup.status?.installed && step === 'grok-setup'
  const isAntigravityReinstall =
    antigravitySetup.status?.installed && step === 'antigravity-setup'
  const isGhReinstall = ghSetup.status?.installed && step === 'gh-setup'

  // When CLI source is 'path', use the path detection result for login command
  // (the Jean-managed status.path may be empty if Jean hasn't installed the CLI)
  const claudeLoginCommand =
    claudePathSelected && pathDetection.data?.path
      ? pathDetection.data.path
      : (claudeSetup.status?.path ?? '')
  const claudeLoginArgs = claudeSetup.status?.supports_auth_command
    ? ['auth', 'login']
    : ['login']
  const codexLoginCommand =
    codexPathSelected && codexPathDetection.data?.path
      ? codexPathDetection.data.path
      : (codexSetup.status?.path ?? '')
  const codexLoginArgs = ['login']
  const opencodeLoginCommand =
    opencodePathSelected && opencodePathDetection.data?.path
      ? opencodePathDetection.data.path
      : (opencodeSetup.status?.path ?? '')
  const opencodeLoginArgs = ['auth', 'login']
  const piLoginCommand =
    piPathSelected && piPathDetection.data?.path
      ? piPathDetection.data.path
      : (piSetup.status?.path ?? '')
  const piLoginArgs: string[] = []
  const commandcodeLoginCommand =
    commandcodePathSelected && commandcodePathDetection.data?.path
      ? commandcodePathDetection.data.path
      : (commandcodeSetup.status?.path ?? '')
  const commandcodeLoginArgs = ['login']
  const grokLoginCommand =
    grokPathSelected && grokPathDetection.data?.path
      ? grokPathDetection.data.path
      : (grokSetup.status?.path ?? '')
  const grokLoginArgs = ['login']
  const antigravityLoginCommand =
    antigravityPathSelected && antigravityPathDetection.data?.path
      ? antigravityPathDetection.data.path
      : (antigravitySetup.status?.path ?? '')
  const antigravityLoginArgs = ['login']
  const ghLoginCommand =
    ghPathSelected && ghPathDetection.data?.path
      ? ghPathDetection.data.path
      : (ghSetup.status?.path ?? '')
  const ghLoginArgs = ['auth', 'login']

  dbg('login commands:', {
    claude: {
      cmd: claudeLoginCommand,
      args: claudeLoginArgs,
      path: claudeSetup.status?.path,
      pathSelected: claudePathSelected,
      detectedPath: pathDetection.data?.path,
    },
    codex: {
      cmd: codexLoginCommand,
      args: codexLoginArgs,
      path: codexSetup.status?.path,
      pathSelected: codexPathSelected,
      detectedPath: codexPathDetection.data?.path,
    },
    opencode: {
      cmd: opencodeLoginCommand,
      args: opencodeLoginArgs,
      path: opencodeSetup.status?.path,
      pathSelected: opencodePathSelected,
      detectedPath: opencodePathDetection.data?.path,
    },
    pi: {
      cmd: piLoginCommand,
      args: piLoginArgs,
      path: piSetup.status?.path,
      pathSelected: piPathSelected,
      detectedPath: piPathDetection.data?.path,
    },
    commandcode: {
      cmd: commandcodeLoginCommand,
      args: commandcodeLoginArgs,
      path: commandcodeSetup.status?.path,
      pathSelected: commandcodePathSelected,
      detectedPath: commandcodePathDetection.data?.path,
    },
    grok: {
      cmd: grokLoginCommand,
      args: grokLoginArgs,
      path: grokSetup.status?.path,
      pathSelected: grokPathSelected,
      detectedPath: grokPathDetection.data?.path,
    },
    antigravity: {
      cmd: antigravityLoginCommand,
      args: antigravityLoginArgs,
      path: antigravitySetup.status?.path,
      pathSelected: antigravityPathSelected,
      detectedPath: antigravityPathDetection.data?.path,
    },
    gh: {
      cmd: ghLoginCommand,
      args: ghLoginArgs,
      path: ghSetup.status?.path,
      pathSelected: ghPathSelected,
      detectedPath: ghPathDetection.data?.path,
    },
  })

  const getDialogContent = () => {
    const dialogStep = step as OnboardingStep
    if (dialogStep === 'wsl-setup') {
      return {
        title: 'Welcome to Jean',
        description: 'Choose your development environment.',
      }
    }

    if (dialogStep === 'backend-select') {
      return {
        title: onboardingManuallyTriggered
          ? 'Install AI Backends'
          : 'Welcome to Jean',
        description: onboardingManuallyTriggered
          ? 'Select additional AI backends to install.'
          : 'Select at least one AI backend to install. GitHub CLI setup is required next.',
      }
    }

    if (dialogStep === 'complete') {
      return {
        title: 'Setup Complete',
        description:
          'All required tools have been installed and authenticated.',
      }
    }

    if (dialogStep === 'gh-setup' || dialogStep === 'gh-installing') {
      const hasPathCli = ghPathDetection.data?.found
      return {
        title: isGhReinstall ? 'Change GitHub CLI Version' : 'Setup GitHub CLI',
        description: isGhReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system GitHub CLI or install with Jean.'
            : 'GitHub CLI is required for GitHub integration.',
      }
    }

    if (dialogStep === 'gh-auth-checking' || dialogStep === 'gh-auth-login') {
      return {
        title: 'Authenticate GitHub CLI',
        description: 'GitHub CLI authentication is required to continue.',
      }
    }

    const currentBackend = stepToBackend(dialogStep)
    const backendName = currentBackend
      ? backendLabel[currentBackend]
      : 'AI Backend'

    if (dialogStep === 'claude-setup' || dialogStep === 'claude-installing') {
      const isReinstall = isClaudeReinstall

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : pathDetection.data?.found
            ? 'Choose to use your system Claude or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (dialogStep === 'codex-setup' || dialogStep === 'codex-installing') {
      const isReinstall = isCodexReinstall
      const hasPathCli = codexPathDetection.data?.found

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system Codex or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (
      dialogStep === 'opencode-setup' ||
      dialogStep === 'opencode-installing'
    ) {
      const isReinstall = isOpencodeReinstall
      const hasPathCli = opencodePathDetection.data?.found

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system OpenCode or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (dialogStep === 'pi-setup' || dialogStep === 'pi-installing') {
      return {
        title: isPiReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isPiReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : piPathDetection.data?.found
            ? 'Choose to use your system PI or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (
      dialogStep === 'commandcode-setup' ||
      dialogStep === 'commandcode-installing'
    ) {
      return {
        title: isCommandcodeReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isCommandcodeReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : commandcodePathDetection.data?.found
            ? 'Choose to use your system Command Code or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (dialogStep === 'grok-setup' || dialogStep === 'grok-installing') {
      return {
        title: isGrokReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isGrokReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : grokPathDetection.data?.found
            ? 'Choose to use your system Grok or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (
      dialogStep === 'claude-auth-checking' ||
      dialogStep === 'claude-auth-login' ||
      dialogStep === 'codex-auth-checking' ||
      dialogStep === 'codex-auth-login' ||
      dialogStep === 'opencode-auth-checking' ||
      dialogStep === 'opencode-auth-login' ||
      dialogStep === 'pi-auth-checking' ||
      dialogStep === 'pi-auth-login' ||
      dialogStep === 'commandcode-auth-checking' ||
      dialogStep === 'commandcode-auth-login' ||
      dialogStep === 'grok-auth-checking' ||
      dialogStep === 'grok-auth-login'
    ) {
      return {
        title: `Authenticate ${backendName}`,
        description: `${backendName} requires authentication to function.`,
      }
    }

    return { title: 'Setup', description: '' }
  }

  const dialogContent = getDialogContent()

  const renderStepIndicator = () => {
    const isBackendSelection = step === 'backend-select'
    const isBackendStep =
      step.startsWith('claude-') ||
      step.startsWith('codex-') ||
      step.startsWith('opencode-') ||
      step.startsWith('pi-') ||
      step.startsWith('commandcode-') ||
      step.startsWith('grok-')
    const isGhStep = step.startsWith('gh-')

    const backendComplete = !isBackendSelection && !isBackendStep
    const ghComplete = step === 'complete'

    return (
      <div className="flex items-center justify-center gap-2 mb-4">
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            isBackendSelection || isBackendStep
              ? 'bg-primary text-primary-foreground'
              : backendComplete
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">1</span>
          <span>AI Backend(s)</span>
        </div>
        <div className="w-4 h-px bg-border" />
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            isGhStep
              ? 'bg-primary text-primary-foreground'
              : ghComplete
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">2</span>
          <span>GitHub CLI</span>
        </div>
        <div className="w-4 h-px bg-border" />
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            step === 'complete'
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">3</span>
          <span>Done</span>
        </div>
      </div>
    )
  }

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (step === 'complete') {
          handleComplete()
        } else {
          handleAbort()
        }
      }
    },
    [step, handleComplete, handleAbort]
  )

  return (
    <Dialog open={onboardingOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col"
        preventClose
      >
        <DialogHeader>
          <DialogTitle className="text-xl">{dialogContent.title}</DialogTitle>
          <DialogDescription>{dialogContent.description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto py-4 flex flex-col">
          {step !== 'wsl-setup' && renderStepIndicator()}

          <div className="w-full">
            {step === 'wsl-setup' ? (
              <WslSetupStep
                onComplete={() => {
                  dbg('WSL setup complete → backend-select')
                  setStep('backend-select')
                }}
              />
            ) : step === 'backend-select' ? (
              <BackendSelectionState
                selectedBackends={selectedBackends}
                onToggle={handleBackendToggle}
                onContinue={handleBackendSelectionContinue}
                readyBackends={
                  onboardingManuallyTriggered
                    ? AI_BACKENDS.filter(isBackendReady)
                    : []
                }
                isLoading={!!aiBackendsLoading}
              />
            ) : step === 'complete' ? (
              <SuccessState
                claudeVersion={claudeSetup.status?.version}
                codexVersion={codexSetup.status?.version}
                opencodeVersion={opencodeSetup.status?.version}
                piVersion={piSetup.status?.version}
                commandcodeVersion={commandcodeSetup.status?.version}
                grokVersion={grokSetup.status?.version}
                ghVersion={ghSetup.status?.version}
                onContinue={handleComplete}
              />
            ) : step === 'claude-installing' && cliData ? (
              <InstallingState
                cliName="Claude CLI"
                progress={cliData.progress}
              />
            ) : step === 'codex-installing' && cliData ? (
              <InstallingState
                cliName="Codex CLI"
                progress={cliData.progress}
              />
            ) : step === 'opencode-installing' && cliData ? (
              <InstallingState
                cliName="OpenCode CLI"
                progress={cliData.progress}
              />
            ) : step === 'pi-installing' && cliData ? (
              <InstallingState cliName="PI CLI" progress={cliData.progress} />
            ) : step === 'commandcode-installing' && cliData ? (
              <InstallingState
                cliName="Command Code CLI"
                progress={cliData.progress}
              />
            ) : step === 'grok-installing' && cliData ? (
              <InstallingState cliName="Grok CLI" progress={cliData.progress} />
            ) : step === 'antigravity-installing' && cliData ? (
              <InstallingState
                cliName="Antigravity CLI"
                progress={cliData.progress}
              />
            ) : step === 'gh-installing' && cliData ? (
              <InstallingState
                cliName="GitHub CLI"
                progress={cliData.progress}
              />
            ) : step === 'claude-auth-checking' ? (
              <AuthCheckingState cliName="Claude CLI" />
            ) : step === 'codex-auth-checking' ? (
              <AuthCheckingState cliName="Codex CLI" />
            ) : step === 'opencode-auth-checking' ? (
              <AuthCheckingState cliName="OpenCode CLI" />
            ) : step === 'pi-auth-checking' ? (
              <AuthCheckingState cliName="PI CLI" />
            ) : step === 'commandcode-auth-checking' ? (
              <AuthCheckingState cliName="Command Code CLI" />
            ) : step === 'grok-auth-checking' ? (
              <AuthCheckingState cliName="Grok CLI" />
            ) : step === 'antigravity-auth-checking' ? (
              <AuthCheckingState cliName="Antigravity CLI" />
            ) : step === 'gh-auth-checking' ? (
              <AuthCheckingState cliName="GitHub CLI" />
            ) : step === 'claude-setup' && !claudePathSelected ? (
              <CliPathSelector
                cliName="Claude CLI"
                pathFound={!!pathDetection.data?.found}
                pathVersion={pathDetection.data?.version ?? null}
                pathPath={pathDetection.data?.path ?? null}
                isLoading={claudePathSelected}
                currentSource={preferences?.claude_cli_source ?? null}
                jeanInstalled={!!claudeSetup.status?.installed}
                onSelectPath={handleClaudePathSelect}
                onSelectJean={handleClaudeJeanSelect}
              />
            ) : step === 'codex-setup' && !codexPathSelected ? (
              <CliPathSelector
                cliName="Codex CLI"
                pathFound={!!codexPathDetection.data?.found}
                pathVersion={codexPathDetection.data?.version ?? null}
                pathPath={codexPathDetection.data?.path ?? null}
                isLoading={codexPathSelected}
                currentSource={preferences?.codex_cli_source ?? null}
                jeanInstalled={!!codexSetup.status?.installed}
                onSelectPath={handleCodexPathSelect}
                onSelectJean={handleCodexJeanSelect}
              />
            ) : step === 'opencode-setup' && !opencodePathSelected ? (
              <CliPathSelector
                cliName="OpenCode CLI"
                pathFound={!!opencodePathDetection.data?.found}
                pathVersion={opencodePathDetection.data?.version ?? null}
                pathPath={opencodePathDetection.data?.path ?? null}
                isLoading={opencodePathSelected}
                currentSource={preferences?.opencode_cli_source ?? null}
                jeanInstalled={!!opencodeSetup.status?.installed}
                onSelectPath={handleOpencodePathSelect}
                onSelectJean={handleOpencodeJeanSelect}
              />
            ) : step === 'pi-setup' && !piPathSelected ? (
              <CliPathSelector
                cliName="PI CLI"
                pathFound={!!piPathDetection.data?.found}
                pathVersion={piPathDetection.data?.version ?? null}
                pathPath={piPathDetection.data?.path ?? null}
                isLoading={piPathSelected}
                currentSource={preferences?.pi_cli_source ?? null}
                jeanInstalled={!!piSetup.status?.installed}
                onSelectPath={handlePiPathSelect}
                onSelectJean={handlePiJeanSelect}
              />
            ) : step === 'commandcode-setup' && !commandcodePathSelected ? (
              <CliPathSelector
                cliName="Command Code CLI"
                pathFound={!!commandcodePathDetection.data?.found}
                pathVersion={commandcodePathDetection.data?.version ?? null}
                pathPath={commandcodePathDetection.data?.path ?? null}
                isLoading={commandcodePathSelected}
                currentSource={preferences?.commandcode_cli_source ?? null}
                jeanInstalled={!!commandcodeSetup.status?.installed}
                onSelectPath={handleCommandcodePathSelect}
                onSelectJean={handleCommandcodeJeanSelect}
              />
            ) : step === 'grok-setup' && !grokPathSelected ? (
              <CliPathSelector
                cliName="Grok CLI"
                pathFound={!!grokPathDetection.data?.found}
                pathVersion={grokPathDetection.data?.version ?? null}
                pathPath={grokPathDetection.data?.path ?? null}
                isLoading={grokPathSelected}
                currentSource={preferences?.grok_cli_source ?? null}
                jeanInstalled={!!grokSetup.status?.installed}
                onSelectPath={handleGrokPathSelect}
                onSelectJean={handleGrokJeanSelect}
              />
            ) : step === 'antigravity-setup' && !antigravityPathSelected ? (
              <CliPathSelector
                cliName="Antigravity CLI"
                pathFound={!!antigravityPathDetection.data?.found}
                pathVersion={antigravityPathDetection.data?.version ?? null}
                pathPath={antigravityPathDetection.data?.path ?? null}
                isLoading={antigravityPathSelected}
                currentSource={preferences?.antigravity_cli_source ?? null}
                jeanInstalled={!!antigravitySetup.status?.installed}
                onSelectPath={handleAntigravityPathSelect}
                onSelectJean={handleAntigravityJeanSelect}
              />
            ) : step === 'claude-auth-login' ? (
              claudeLoginCommand ? (
                <AuthLoginState
                  key={claudeLoginTerminalId}
                  cliName="Claude CLI"
                  terminalId={claudeLoginTerminalId}
                  command={claudeLoginCommand}
                  commandArgs={claudeLoginArgs}
                  onComplete={handleClaudeLoginComplete}
                  onRetry={handleClaudeLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Claude CLI" />
              )
            ) : step === 'codex-auth-login' ? (
              codexLoginCommand ? (
                <AuthLoginState
                  key={codexLoginTerminalId}
                  cliName="Codex CLI"
                  terminalId={codexLoginTerminalId}
                  command={codexLoginCommand}
                  commandArgs={codexLoginArgs}
                  onComplete={handleCodexLoginComplete}
                  onRetry={handleCodexLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Codex CLI" />
              )
            ) : step === 'opencode-auth-login' ? (
              opencodeLoginCommand ? (
                <AuthLoginState
                  key={opencodeLoginTerminalId}
                  cliName="OpenCode CLI"
                  terminalId={opencodeLoginTerminalId}
                  command={opencodeLoginCommand}
                  commandArgs={opencodeLoginArgs}
                  onComplete={handleOpencodeLoginComplete}
                  onRetry={handleOpencodeLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="OpenCode CLI" />
              )
            ) : step === 'pi-auth-login' ? (
              piLoginCommand ? (
                <AuthLoginState
                  key={piLoginTerminalId}
                  cliName="PI CLI"
                  terminalId={piLoginTerminalId}
                  command={piLoginCommand}
                  commandArgs={piLoginArgs}
                  onComplete={handlePiLoginComplete}
                  onRetry={handlePiLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="PI CLI" />
              )
            ) : step === 'commandcode-auth-login' ? (
              commandcodeLoginCommand ? (
                <AuthLoginState
                  key={commandcodeLoginTerminalId}
                  cliName="Command Code CLI"
                  terminalId={commandcodeLoginTerminalId}
                  command={commandcodeLoginCommand}
                  commandArgs={commandcodeLoginArgs}
                  onComplete={handleCommandcodeLoginComplete}
                  onRetry={handleCommandcodeLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Command Code CLI" />
              )
            ) : step === 'grok-auth-login' ? (
              grokLoginCommand ? (
                <AuthLoginState
                  key={grokLoginTerminalId}
                  cliName="Grok CLI"
                  terminalId={grokLoginTerminalId}
                  command={grokLoginCommand}
                  commandArgs={grokLoginArgs}
                  onComplete={handleGrokLoginComplete}
                  onRetry={handleGrokLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Grok CLI" />
              )
            ) : step === 'antigravity-auth-login' ? (
              antigravityLoginCommand ? (
                <AuthLoginState
                  key={antigravityLoginTerminalId}
                  cliName="Antigravity CLI"
                  terminalId={antigravityLoginTerminalId}
                  command={antigravityLoginCommand}
                  commandArgs={antigravityLoginArgs}
                  onComplete={handleAntigravityLoginComplete}
                  onRetry={handleAntigravityLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Antigravity CLI" />
              )
            ) : step === 'gh-setup' && !ghPathSelected ? (
              <CliPathSelector
                cliName="GitHub CLI"
                pathFound={!!ghPathDetection.data?.found}
                pathVersion={ghPathDetection.data?.version ?? null}
                pathPath={ghPathDetection.data?.path ?? null}
                isLoading={ghPathSelected}
                currentSource={preferences?.gh_cli_source ?? null}
                jeanInstalled={!!ghSetup.status?.installed}
                onSelectPath={handleGhPathSelect}
                onSelectJean={handleGhJeanSelect}
              />
            ) : step === 'gh-auth-login' ? (
              ghLoginCommand ? (
                <AuthLoginState
                  key={ghLoginTerminalId}
                  cliName="GitHub CLI"
                  terminalId={ghLoginTerminalId}
                  command={ghLoginCommand}
                  commandArgs={ghLoginArgs}
                  onComplete={handleGhLoginComplete}
                  onRetry={handleGhLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="GitHub CLI" />
              )
            ) : cliData ? (
              cliData.installError ? (
                <ErrorState
                  cliName={backendLabel[cliData.type]}
                  error={cliData.installError}
                  onRetry={
                    cliData.type === 'claude'
                      ? handleClaudeInstall
                      : cliData.type === 'codex'
                        ? handleCodexInstall
                        : cliData.type === 'opencode'
                          ? handleOpencodeInstall
                          : cliData.type === 'pi'
                            ? handlePiInstall
                            : cliData.type === 'commandcode'
                              ? handleCommandcodeInstall
                              : cliData.type === 'grok'
                                ? handleGrokInstall
                                : cliData.type === 'antigravity'
                                  ? handleAntigravityInstall
                                  : handleGhInstall
                  }
                />
              ) : (
                <SetupState
                  cliName={backendLabel[cliData.type]}
                  versions={cliData.versions}
                  selectedVersion={
                    cliData.type === 'claude'
                      ? claudeVersion
                      : cliData.type === 'codex'
                        ? codexVersion
                        : cliData.type === 'opencode'
                          ? opencodeVersion
                          : cliData.type === 'pi'
                            ? piVersion
                            : cliData.type === 'commandcode'
                              ? commandcodeVersion
                              : cliData.type === 'grok'
                                ? grokVersion
                                : cliData.type === 'antigravity'
                                  ? antigravityVersion
                                  : ghVersion
                  }
                  currentVersion={
                    (cliData.type === 'claude' && isClaudeReinstall) ||
                    (cliData.type === 'codex' && isCodexReinstall) ||
                    (cliData.type === 'opencode' && isOpencodeReinstall) ||
                    (cliData.type === 'pi' && isPiReinstall) ||
                    (cliData.type === 'commandcode' &&
                      isCommandcodeReinstall) ||
                    (cliData.type === 'grok' && isGrokReinstall) ||
                    (cliData.type === 'antigravity' && isAntigravityReinstall) ||
                    (cliData.type === 'gh' && isGhReinstall)
                      ? cliData.currentVersion
                      : null
                  }
                  isLoading={cliData.isVersionsLoading}
                  isError={cliData.isVersionsError}
                  onRetry={cliData.onRetryVersions}
                  onVersionChange={
                    cliData.type === 'claude'
                      ? setClaudeVersion
                      : cliData.type === 'codex'
                        ? setCodexVersion
                        : cliData.type === 'opencode'
                          ? setOpencodeVersion
                          : cliData.type === 'pi'
                            ? setPiVersion
                            : cliData.type === 'commandcode'
                              ? setCommandcodeVersion
                              : cliData.type === 'grok'
                                ? setGrokVersion
                                : cliData.type === 'antigravity'
                                  ? setAntigravityVersion
                                  : setGhVersion
                  }
                  onInstall={
                    cliData.type === 'claude'
                      ? handleClaudeInstall
                      : cliData.type === 'codex'
                        ? handleCodexInstall
                        : cliData.type === 'opencode'
                          ? handleOpencodeInstall
                          : cliData.type === 'pi'
                            ? handlePiInstall
                            : cliData.type === 'commandcode'
                              ? handleCommandcodeInstall
                              : cliData.type === 'grok'
                                ? handleGrokInstall
                                : cliData.type === 'antigravity'
                                  ? handleAntigravityInstall
                                  : handleGhInstall
                  }
                />
              )
            ) : (
              <BackendSelectionState
                selectedBackends={selectedBackends}
                onToggle={handleBackendToggle}
                onContinue={handleBackendSelectionContinue}
                isLoading={!!aiBackendsLoading}
              />
            )}
          </div>
        </div>

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
          <span className="text-xs text-muted-foreground">
            {isTransientStep ? 'Working...' : ''}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface BackendSelectionStateProps {
  selectedBackends: AIBackend[]
  onToggle: (backend: AIBackend, checked: boolean) => void
  onContinue: () => void
  readyBackends?: AIBackend[]
  isLoading?: boolean
}

function BackendSelectionState({
  selectedBackends,
  onToggle,
  onContinue,
  readyBackends = [],
  isLoading = false,
}: BackendSelectionStateProps) {
  return (
    <div className="space-y-6">
      {isLoading && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking installed backends...
        </div>
      )}

      <div className="space-y-3">
        {AI_BACKENDS.map(backend => {
          const id = `backend-${backend}`
          const checked = selectedBackends.includes(backend)
          const label = backendLabel[backend]
          const isReady = readyBackends.includes(backend)

          return (
            <label
              key={backend}
              htmlFor={id}
              className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-accent/40"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={value => onToggle(backend, value === true)}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{label}</p>
                  {BETA_BACKENDS.has(backend) && (
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      beta
                    </span>
                  )}
                  {isReady && (
                    <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                      installed
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isReady
                    ? `Reconfigure ${label}.`
                    : `Install and authenticate ${label}.`}
                </p>
              </div>
            </label>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        You must have at least one AI backend installed. Selecting an installed
        backend lets you switch between Jean-managed and system PATH or change
        versions.
      </p>

      <Button
        onClick={onContinue}
        className="w-full"
        size="lg"
        disabled={isLoading}
      >
        {isLoading ? 'Checking backends...' : 'Continue'}
      </Button>
    </div>
  )
}

interface SuccessStateProps {
  claudeVersion: string | null | undefined
  codexVersion: string | null | undefined
  opencodeVersion: string | null | undefined
  piVersion: string | null | undefined
  commandcodeVersion: string | null | undefined
  grokVersion: string | null | undefined
  ghVersion: string | null | undefined
  onContinue: () => void
}

function SuccessState({
  claudeVersion,
  codexVersion,
  opencodeVersion,
  piVersion,
  commandcodeVersion,
  grokVersion,
  ghVersion,
  onContinue,
}: SuccessStateProps) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="font-medium">All Tools Ready</p>
        <div className="text-sm text-muted-foreground mt-2 space-y-1">
          {claudeVersion && <p>Claude CLI: v{claudeVersion}</p>}
          {codexVersion && <p>Codex CLI: v{codexVersion}</p>}
          {opencodeVersion && <p>OpenCode CLI: v{opencodeVersion}</p>}
          {piVersion && <p>PI CLI: v{piVersion}</p>}
          {commandcodeVersion && <p>Command Code CLI: v{commandcodeVersion}</p>}
          {grokVersion && <p>Grok CLI: v{grokVersion}</p>}
          {ghVersion && <p>GitHub CLI: v{ghVersion}</p>}
          {!claudeVersion &&
            !codexVersion &&
            !opencodeVersion &&
            !piVersion &&
            !commandcodeVersion &&
            !grokVersion &&
            !ghVersion && <p>Setup complete</p>}
        </div>
      </div>

      <Button onClick={onContinue} className="w-full" size="lg">
        Continue to Jean
      </Button>
    </div>
  )
}

export default OnboardingDialog
