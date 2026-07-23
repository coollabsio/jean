/**
 * Remote Jean version probing and compatibility checks.
 *
 * Native desktop clients keep their bundled React UI while talking to a
 * remote headless/Web Access backend. When versions diverge we surface a
 * warning (picker label + toast) but still allow the connection so users
 * are not locked out.
 */

import { toast } from 'sonner'
import { FALLBACK_APP_VERSION } from './app-version'
import { compareVersions } from './version-utils'
import { logger } from './logger'

export interface RemoteServerInfo {
  ok: boolean
  appVersion: string | null
  webBuildId: string | null
}

export type VersionCompatibility =
  | { compatible: true; localVersion: string; remoteVersion: string | null }
  | {
      compatible: false
      localVersion: string
      remoteVersion: string
      message: string
    }

/**
 * Local desktop/UI version. Uses package.json (same source as Cargo package
 * versions in this repo) so native remotes can compare without Vite build
 * globals.
 */
export function getLocalJeanVersion(): string {
  return FALLBACK_APP_VERSION
}

export function buildRemoteAuthUrl(url: string, token: string): string {
  const base = `${url.replace(/\/+$/, '')}/`
  const authUrl = new URL('api/auth', base)
  if (token) authUrl.searchParams.set('token', token)
  return authUrl.toString()
}

export function formatJeanVersionLabel(
  version: string | null | undefined
): string {
  if (!version) return 'version unknown'
  const cleaned = version.startsWith('v') ? version.slice(1) : version
  return `v${cleaned}`
}

/**
 * Compare local desktop client version against a remote Jean appVersion.
 * Missing remote version (older servers) is treated as compatible so we do
 * not spam warnings for pre-version-reporting installs.
 */
export function checkRemoteVersionCompatibility(
  remoteVersion: string | null | undefined,
  localVersion: string = getLocalJeanVersion()
): VersionCompatibility {
  if (!remoteVersion) {
    return { compatible: true, localVersion, remoteVersion: null }
  }

  if (compareVersions(localVersion, remoteVersion) === 0) {
    return { compatible: true, localVersion, remoteVersion }
  }

  const localIsOlder = compareVersions(localVersion, remoteVersion) < 0
  const localLabel = formatJeanVersionLabel(localVersion)
  const remoteLabel = formatJeanVersionLabel(remoteVersion)
  const message = localIsOlder
    ? `This Jean app is ${localLabel}, but the remote server is ${remoteLabel}. Consider updating this app for the best experience.`
    : `This Jean app is ${localLabel}, but the remote server is ${remoteLabel}. Consider updating the remote Jean server (or using a matching app version).`

  return {
    compatible: false,
    localVersion,
    remoteVersion,
    message,
  }
}

export async function fetchRemoteServerInfo(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteServerInfo> {
  const authUrl = buildRemoteAuthUrl(url, token)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  try {
    const res = await fetchImpl(authUrl, { signal: controller.signal })
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Invalid access token for this Jean server.')
      }
      throw new Error(`Jean server returned HTTP ${res.status}.`)
    }

    const body = (await res.json()) as {
      ok?: boolean
      appVersion?: string | null
      webBuildId?: string | null
    }

    return {
      ok: body.ok !== false,
      appVersion: body.appVersion ?? null,
      webBuildId: body.webBuildId ?? null,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Timed out reaching the Jean server.')
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out reaching the Jean server.')
    }
    if (error instanceof Error) throw error
    throw new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Probe a remote and return its version plus an optional mismatch warning.
 * Does not throw on version mismatch — only on network/auth failures.
 */
export async function probeRemoteConnectionVersion(
  connection: { url: string; token: string },
  options?: {
    fetchImpl?: typeof fetch
    localVersion?: string
  }
): Promise<{
  appVersion: string | null
  warning: string | null
  check: VersionCompatibility
}> {
  const info = await fetchRemoteServerInfo(
    connection.url,
    connection.token,
    options?.fetchImpl ?? fetch
  )
  const check = checkRemoteVersionCompatibility(
    info.appVersion,
    options?.localVersion ?? getLocalJeanVersion()
  )
  return {
    appVersion: info.appVersion,
    warning: check.compatible ? null : check.message,
    check,
  }
}

let notifiedMismatchKey: string | null = null

/**
 * Show a non-blocking toast when the remote Jean version differs from this
 * client. Deduped per local+remote version pair until the page reloads.
 */
export function warnRemoteVersionMismatch(
  remoteVersion: string | null | undefined,
  localVersion: string = getLocalJeanVersion()
): boolean {
  const check = checkRemoteVersionCompatibility(remoteVersion, localVersion)
  if (check.compatible) return false

  const key = `${check.localVersion}|${check.remoteVersion}`
  if (notifiedMismatchKey === key) return true
  notifiedMismatchKey = key

  logger.warn('Remote Jean version mismatch', {
    localVersion: check.localVersion,
    remoteVersion: check.remoteVersion,
  })

  toast.warning('Jean version mismatch', {
    id: 'remote-version-mismatch',
    description: check.message,
    duration: 12_000,
  })

  return true
}

/** Test helper — reset toast dedupe state. */
export function resetRemoteVersionMismatchNotification(): void {
  notifiedMismatchKey = null
}
