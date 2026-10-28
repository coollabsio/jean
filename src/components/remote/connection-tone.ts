import { checkRemoteVersionCompatibility } from '@/lib/remote-version'

export type VersionState =
  | { status: 'loading' }
  | { status: 'ready'; version: string | null }
  | { status: 'error'; message: string }

export type ConnectionTone = 'success' | 'warning' | 'destructive' | 'muted'

export const CONNECTION_TONE_DOT: Record<ConnectionTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
}

export function connectionTone(
  version: VersionState | undefined,
  tunnelStatus?: string
): ConnectionTone {
  if (tunnelStatus === 'failed' || version?.status === 'error') {
    return 'destructive'
  }
  // A cached version must not paint a stopped or reconnecting tunnel green.
  if (
    (tunnelStatus !== undefined && tunnelStatus !== 'ready') ||
    version?.status !== 'ready'
  ) {
    return 'muted'
  }
  return checkRemoteVersionCompatibility(version.version).compatible
    ? 'success'
    : 'warning'
}
