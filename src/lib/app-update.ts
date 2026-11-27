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

/** Update notes as shown to the user: trimmed markdown, or null when empty. */
export function normalizeReleaseNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const notes = raw.trim()
  return notes ? notes : null
}

/**
 * The release CI builds `latest.json` before the GitHub release notes are
 * published into it, so its `notes` field is often empty. Fall back to the
 * body of the GitHub release for that version.
 */
export async function fetchGitHubReleaseNotes(
  version: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const tag = `v${version.replace(/^v/, '')}`
  const response = await fetchImpl(
    `https://api.github.com/repos/coollabsio/jean/releases/tags/${encodeURIComponent(tag)}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  )
  if (!response.ok) return null
  const release = (await response.json()) as { body?: unknown }
  return normalizeReleaseNotes(release.body)
}
