import { useClaudeCliStatus, useClaudeCliAuth } from '@/services/claude-cli'
import { useCodexCliStatus, useCodexCliAuth } from '@/services/codex-cli'
import {
  useOpencodeCliStatus,
  useOpencodeCliAuth,
} from '@/services/opencode-cli'
import { useCursorCliAuth, useCursorCliStatus } from '@/services/cursor-cli'
import { usePiCliStatus, usePiCliAuth } from '@/services/pi-cli'
import {
  useCommandCodeCliStatus,
  useCommandCodeCliAuth,
} from '@/services/commandcode-cli'
import { useGrokCliStatus, useGrokCliAuth } from '@/services/grok-cli'
import { useKimiCliStatus, useKimiCliAuth } from '@/services/kimi-cli'
import { useGhCliStatus, useGhCliAuth } from '@/services/gh-cli'
import { useUIStore } from '@/store/ui-store'
import { isNativeApp } from '@/lib/environment'
import { useRemoteConnections } from '@/lib/remote-connections'
import { Loader2 } from '@/components/icons/reicon'

function handleCompleteSetup() {
  useUIStore.setState({
    onboardingManuallyTriggered: true,
    onboardingDismissed: false,
    onboardingOpen: true,
  })
}

export function SetupIncompleteBanner() {
  const onboardingDismissed = useUIStore(state => state.onboardingDismissed)
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  const hasRemoteServer = useRemoteConnections().length > 0

  const claudeStatus = useClaudeCliStatus()
  const codexStatus = useCodexCliStatus()
  const opencodeStatus = useOpencodeCliStatus()
  const cursorStatus = useCursorCliStatus()
  const piStatus = usePiCliStatus()
  const commandcodeStatus = useCommandCodeCliStatus()
  const grokStatus = useGrokCliStatus()
  const kimiStatus = useKimiCliStatus()
  const ghStatus = useGhCliStatus()

  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed,
  })
  const codexAuth = useCodexCliAuth({ enabled: !!codexStatus.data?.installed })
  const opencodeAuth = useOpencodeCliAuth({
    enabled: !!opencodeStatus.data?.installed,
  })
  const cursorAuth = useCursorCliAuth({
    enabled: !!cursorStatus.data?.installed,
  })
  const piAuth = usePiCliAuth({ enabled: !!piStatus.data?.installed })
  const commandcodeAuth = useCommandCodeCliAuth({
    enabled: !!commandcodeStatus.data?.installed,
  })
  const grokAuth = useGrokCliAuth({
    enabled: !!grokStatus.data?.installed,
  })
  const kimiAuth = useKimiCliAuth({ enabled: !!kimiStatus.data?.installed })
  const ghAuth = useGhCliAuth({ enabled: !!ghStatus.data?.installed })

  if (!isNativeApp()) return null
  // Only show after user has dismissed onboarding, and while it's not currently open
  if (!onboardingDismissed || onboardingOpen) return null
  // Backends can live on a remote server; local tools are optional then.
  if (hasRemoteServer) return null

  const isLoading =
    claudeStatus.isLoading ||
    codexStatus.isLoading ||
    opencodeStatus.isLoading ||
    cursorStatus.isLoading ||
    piStatus.isLoading ||
    commandcodeStatus.isLoading ||
    (cursorStatus.data?.installed &&
      (cursorAuth.isLoading || cursorAuth.isFetching)) ||
    grokStatus.isLoading ||
    kimiStatus.isLoading ||
    ghStatus.isLoading

  if (isLoading) {
    return (
      <div className="flex w-full shrink-0 items-center justify-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Calling Jean…</span>
      </div>
    )
  }

  const ghReady = !!ghStatus.data?.installed && !!ghAuth.data?.authenticated
  const hasAiBackendReady =
    (!!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated) ||
    (!!codexStatus.data?.installed && !!codexAuth.data?.authenticated) ||
    (!!opencodeStatus.data?.installed && !!opencodeAuth.data?.authenticated) ||
    (!!cursorStatus.data?.installed && !!cursorAuth.data?.authenticated) ||
    (!!piStatus.data?.installed && !!piAuth.data?.authenticated) ||
    (!!commandcodeStatus.data?.installed &&
      !!commandcodeAuth.data?.authenticated) ||
    (!!grokStatus.data?.installed && !!grokAuth.data?.authenticated) ||
    (!!kimiStatus.data?.installed && !!kimiAuth.data?.authenticated)

  // Everything is set up — no banner needed
  if (ghReady && hasAiBackendReady) return null

  return (
    <div className="flex w-full shrink-0 items-center justify-center gap-2 bg-warning/15 px-4 py-1.5 text-xs text-warning">
      <span>
        Setup incomplete — Jean requires GitHub CLI and at least one AI backend.
      </span>
      <button
        type="button"
        onClick={handleCompleteSetup}
        className="rounded-md bg-warning/20 px-2 py-0.5 font-medium text-warning transition-colors hover:bg-warning/30"
      >
        Complete Setup
      </button>
    </div>
  )
}
