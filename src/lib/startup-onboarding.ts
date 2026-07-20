interface CliStatus {
  installed: boolean
}

interface CliAuthStatus {
  authenticated: boolean
}

interface StartupOnboardingState {
  statuses: [
    CliStatus | undefined,
    CliStatus | undefined,
    CliStatus | undefined,
    CliStatus | undefined,
  ]
  auth: [
    CliAuthStatus | undefined,
    CliAuthStatus | undefined,
    CliAuthStatus | undefined,
    CliAuthStatus | undefined,
  ]
  onboardingOpen: boolean
  onboardingDismissed: boolean
  onboardingManuallyTriggered: boolean
  requiresWslChoice: boolean
}

export type StartupOnboardingAction =
  | 'wait'
  | 'open'
  | 'close'
  | 'ready'
  | 'none'

export function getStartupOnboardingAction({
  statuses,
  auth,
  onboardingOpen,
  onboardingDismissed,
  onboardingManuallyTriggered,
  requiresWslChoice,
}: StartupOnboardingState): StartupOnboardingAction {
  if (onboardingDismissed || onboardingManuallyTriggered) return 'none'
  if (statuses.some(status => !status)) return 'wait'

  const authPending = statuses.some(
    (status, index) => status?.installed && !auth[index]
  )
  if (authPending) return 'wait'

  if (requiresWslChoice) return 'open'

  const ghReady = statuses[3]?.installed && auth[3]?.authenticated
  const hasAiBackendReady = statuses
    .slice(0, 3)
    .some((status, index) => status?.installed && auth[index]?.authenticated)

  if (ghReady && hasAiBackendReady) {
    return onboardingOpen ? 'close' : 'ready'
  }

  return 'open'
}
