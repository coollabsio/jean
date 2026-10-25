import type { PortEntry } from '@/services/projects'

export const LOCALHOST_BROWSER_HOST = 'localhost'

const HOSTNAME_LABEL =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

export type BrowserDefaultHostResult =
  | { ok: true; host: string | null }
  | { ok: false; error: string }

/**
 * Canonical server preview hostname.
 * Blank means unset (`null`), which callers treat as localhost.
 * Loopback names stay loopback so remote preview forwarding can still apply.
 * Any other hostname is kept as written.
 */
export function normalizeBrowserDefaultHost(
  value: string | null | undefined
): BrowserDefaultHostResult {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return { ok: true, host: null }
  if (trimmed.length > 253) {
    return { ok: false, error: 'Browser default hostname is too long' }
  }
  if (
    trimmed.includes('://') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('@') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    /\s/.test(trimmed)
  ) {
    return {
      ok: false,
      error: 'Enter a hostname or IP address, without a scheme, port, or path',
    }
  }

  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed
  if (!unbracketed) {
    return { ok: false, error: 'Enter a hostname or IP address' }
  }

  if (unbracketed.includes(':')) {
    const ipv6 = canonicalIpv6(unbracketed)
    if (!ipv6) {
      return {
        ok: false,
        error: 'Enter a hostname or IP address, without a port',
      }
    }
    return { ok: true, host: ipv6 }
  }

  const ipv4 = canonicalIpv4(unbracketed)
  if (ipv4) return { ok: true, host: ipv4 }

  const hostname = unbracketed.toLowerCase()
  if (!HOSTNAME_LABEL.test(hostname) || hostname.length > 253) {
    return { ok: false, error: 'Enter a hostname or IP address' }
  }
  return { ok: true, host: hostname }
}

function canonicalIpv4(host: string): string | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map(part => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    return Number(part)
  })
  if (numbers.some(number => !Number.isInteger(number) || number > 255)) {
    return null
  }
  return numbers.join('.')
}

function canonicalIpv6(host: string): string | null {
  try {
    const hostname = new URL(`http://[${host}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null
    return hostname.slice(1, -1)
  } catch {
    return null
  }
}

function formatPortHttpUrl(host: string, port: number): string {
  const trimmed = host.trim()
  const bare =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed
  const formatted = bare.includes(':') ? `[${bare}]` : bare
  return `http://${formatted}:${port}`
}

/**
 * Host for a configured port.
 * Order: jean.json `ports[].host`, then the server setting, then localhost.
 * A non-loopback host is returned unchanged. Loopback stays loopback.
 */
export function resolvePortHost(
  port: Pick<PortEntry, 'host'>,
  serverDefaultHost?: string | null
): string {
  const configured = port.host?.trim()
  if (configured) return configured
  const normalized = normalizeBrowserDefaultHost(serverDefaultHost)
  if (normalized.ok && normalized.host) return normalized.host
  return LOCALHOST_BROWSER_HOST
}

/**
 * Resolve the URL a freshly opened browser tab or port button should load.
 * Prefers the first jean.json-configured port (`http://<host>:<port>`)
 * so the embedded browser auto-points at the worktree's dev server.
 * Falls back to about:blank when no port is configured.
 * Remote desktop sessions rewrite loopback targets in
 * `resolveEmbeddedPreviewUrl` when the webview opens.
 */
export function resolvePortUrl(
  port: PortEntry,
  serverDefaultHost?: string | null
): string {
  return formatPortHttpUrl(resolvePortHost(port, serverDefaultHost), port.port)
}

export function resolveDefaultTabUrl(
  ports: PortEntry[] | undefined,
  serverDefaultHost?: string | null
): string {
  const first = ports?.[0]
  if (!first) return 'about:blank'
  return resolvePortUrl(first, serverDefaultHost)
}
