/**
 * App auto-update lifecycle helpers.
 *
 * States:
 * - available / deferred: user postponed install (`pendingUpdateVersion` badge)
 * - installing: download+install in progress
 * - ready: package installed, app must relaunch to apply
 *
 * After a successful install the running binary is still the old version, so
 * `check()` continues to report an update. Without the ready/installing guards
 * the UI re-offers "Update available" and can re-download in a loop (#507).
 */

export interface AppUpdateGuardState {
  pendingUpdateVersion: string | null
  updateReadyVersion: string | null
  isUpdateInstalling: boolean
}

/** Whether auto / menu update checks should surface a new offer. */
export function shouldOfferUpdateCheck(state: AppUpdateGuardState): boolean {
  if (state.isUpdateInstalling) return false
  if (state.updateReadyVersion) return false
  if (state.pendingUpdateVersion) return false
  return true
}

export type InstallPendingAction = 'relaunch' | 'install' | 'noop'

/**
 * Resolve what clicking the title-bar badge / "Update Now" should do.
 * Prefer relaunch once the package is already installed.
 */
export function resolveInstallPendingAction(state: {
  updateReadyVersion: string | null
  isUpdateInstalling: boolean
  hasPendingUpdateObject: boolean
}): InstallPendingAction {
  if (state.isUpdateInstalling) return 'noop'
  if (state.updateReadyVersion) return 'relaunch'
  if (state.hasPendingUpdateObject) return 'install'
  return 'noop'
}
