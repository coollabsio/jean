interface CliStatus {
  installed: boolean
}

interface CliAuthStatus {
  authenticated: boolean
}

interface StartupOnboardingState {
  /** AI backend CLI install statuses (any length; one entry per backend). */
  aiStatuses: (CliStatus | undefined)[]
  /** Matching auth statuses for each AI backend (same order as aiStatuses). */
  aiAuth: (CliAuthStatus | undefined)[]
  /** GitHub CLI install status. */
  ghStatus: CliStatus | undefined
  /** GitHub CLI auth status. */
  ghAuth: CliAuthStatus | undefined
  onboardingOpen: boolean
  onboardingDismissed: boolean
  onboardingManuallyTriggered: boolean
  /**
   * Local Windows still needs a WSL vs native choice. Must be false for remote
   * connections — WSL only applies to the local desktop shell.
   */
  requiresWslChoice: boolean
}

export type StartupOnboardingAction =
  | 'wait'
  | 'open'
  | 'close'
  | 'ready'
  | 'none'

function isReady(
  status: CliStatus | undefined,
  auth: CliAuthStatus | undefined
): boolean {
  return !!status?.installed && !!auth?.authenticated
}

export function getStartupOnboardingAction({
  aiStatuses,
  aiAuth,
  ghStatus,
  ghAuth,
  onboardingOpen,
  onboardingDismissed,
  onboardingManuallyTriggered,
  requiresWslChoice,
}: StartupOnboardingState): StartupOnboardingAction {
  if (onboardingDismissed || onboardingManuallyTriggered) return 'none'

  // Wait until every status query has resolved (undefined = still loading).
  if (aiStatuses.some(status => status === undefined) || ghStatus === undefined)
    return 'wait'

  // Wait for auth of installed tools only.
  const aiAuthPending = aiStatuses.some(
    (status, index) => status?.installed && aiAuth[index] === undefined
  )
  const ghAuthPending = !!ghStatus?.installed && ghAuth === undefined
  if (aiAuthPending || ghAuthPending) return 'wait'

  // Any authenticated AI backend counts (Claude, Codex, Grok, Pi, …).
  const hasAiBackendReady = aiStatuses.some((status, index) =>
    isReady(status, aiAuth[index])
  )
  const ghReady = isReady(ghStatus, ghAuth)

  // Tools already good: never force the setup wizard (including the "Setup
  // Complete" success screen). WSL choice can wait until the user actually
  // needs local CLI installs.
  if (ghReady && hasAiBackendReady) {
    return onboardingOpen ? 'close' : 'ready'
  }

  if (requiresWslChoice) return 'open'

  return 'open'
}
