import type { PortEntry, TerminalPortInfo } from '@/services/projects'

/**
 * A jean.json port or a terminal listen port the embedded browser can open.
 * Configured ports stay in jean.json order. Listening ports follow, and a
 * listen port is omitted when that port number is already configured.
 */
export interface BrowserPortChoice {
  id: string
  label: string
  url: string
  port: number
  source: 'configured' | 'listening'
}

export type BrowserListeningPort = Pick<
  TerminalPortInfo,
  'port' | 'processName' | 'localAddress'
>

export type PortOpenAction =
  | { type: 'focus'; tabId: string }
  | { type: 'navigate' }
  | { type: 'add-tab' }
  | { type: 'noop' }

const WILDCARD_HOSTS = new Set(['*', '0.0.0.0', '::', '[::]', '[::0]'])

function isSelectablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

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
 * Extra tabs use {@link resolveNewTabUrl}; this stays the first-tab default.
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

/**
 * Mirrors `url_from_listen_address` in jean-core so a listened socket opens
 * on the same host the run environment already reports.
 */
export function urlFromListenAddress(
  localAddress: string,
  port: number
): string {
  return formatPortHttpUrl(hostFromListenAddress(localAddress), port)
}

function hostFromListenAddress(localAddress: string): string {
  const address = localAddress.trim()
  if (!address) return '127.0.0.1'

  let host: string
  if (address.startsWith('[')) {
    const end = address.indexOf(']')
    host = end === -1 ? address : address.slice(1, end)
  } else {
    const colon = address.lastIndexOf(':')
    host = colon === -1 ? address : address.slice(0, colon)
  }

  return WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host
}

function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return 'localhost'
  }
  return host
}

/** Loopback aliases share an identity so a redirect does not look like a new port. */
function portIdentity(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.port) return null
    return `${canonicalHost(parsed.hostname)}:${parsed.port}`
  } catch {
    return null
  }
}

function isBlankBrowserUrl(url: string): boolean {
  // Same rule as isBlankTabUrl in the browser store (about:blank and the
  // opaque new-tab data: URL). Kept local so port selection stays pure.
  return !url || url === 'about:blank' || url.startsWith('data:')
}

function configuredLabel(port: PortEntry, url: string): string {
  const where = displayLocation(url)
  const name = port.label.trim()
  return name ? `${name} (${where})` : where
}

function displayLocation(url: string): string {
  const parsed = new URL(url)
  const host = parsed.hostname.includes(':')
    ? `[${parsed.hostname}]`
    : parsed.hostname
  return `${host}:${parsed.port}`
}

function listeningLabel(processName: string, url: string): string {
  const where = displayLocation(url)
  const name = processName.trim()
  return name ? `${name} (${where})` : where
}

export function listBrowserPortChoices(
  ports: PortEntry[] | undefined,
  listening?: readonly BrowserListeningPort[],
  serverDefaultHost?: string | null
): BrowserPortChoice[] {
  const choices: BrowserPortChoice[] = []
  const seenUrls = new Set<string>()
  const configuredPortNumbers = new Set<number>()

  for (const port of ports ?? []) {
    if (!isSelectablePort(port.port)) continue
    const url = resolvePortUrl(port, serverDefaultHost)
    if (seenUrls.has(url) || !portIdentity(url)) continue
    seenUrls.add(url)
    configuredPortNumbers.add(port.port)
    choices.push({
      id: `configured:${url}`,
      label: configuredLabel(port, url),
      url,
      port: port.port,
      source: 'configured',
    })
  }

  const seenListeningPorts = new Set(configuredPortNumbers)
  for (const entry of listening ?? []) {
    if (!isSelectablePort(entry.port) || seenListeningPorts.has(entry.port)) {
      continue
    }
    const url = urlFromListenAddress(entry.localAddress ?? '', entry.port)
    if (seenUrls.has(url) || !portIdentity(url)) continue
    seenListeningPorts.add(entry.port)
    seenUrls.add(url)
    choices.push({
      id: `listening:${url}`,
      label: listeningLabel(entry.processName ?? '', url),
      url,
      port: entry.port,
      source: 'listening',
    })
  }

  return choices
}

/**
 * URL for a tab the user adds after the pane is already open.
 *
 * One configured port stays a one-click blank tab; the port button opens
 * that port directly. Several jean.json ports return the first one that is
 * not already open, so an extra tab is not stuck on a blank page. Listening
 * ports are picker-only — they come and go with the terminal.
 * `serverDefaultHost` is the same preview hostname the first tab uses.
 * Undefined means the new tab should stay blank.
 */
export function resolveNewTabUrl(
  ports: PortEntry[] | undefined,
  openUrls: readonly string[],
  serverDefaultHost?: string | null
): string | undefined {
  const choices = listBrowserPortChoices(
    ports,
    undefined,
    serverDefaultHost
  ).filter(choice => choice.source === 'configured')
  if (choices.length <= 1) return undefined

  const open = new Set<string>()
  for (const url of openUrls) {
    const identity = portIdentity(url)
    if (identity) open.add(identity)
  }

  return choices.find(choice => {
    const identity = portIdentity(choice.url)
    return identity !== null && !open.has(identity)
  })?.url
}

/**
 * Port picker action. An open tab for that port is focused. A blank tab
 * navigates in place. Anything else becomes a new tab so the current page
 * stays put.
 */
export function resolvePortOpenAction(
  url: string,
  tabs: readonly { id: string; url: string }[],
  activeTabId: string | null
): PortOpenAction {
  const identity = portIdentity(url)
  if (identity) {
    const existing = tabs.find(tab => portIdentity(tab.url) === identity)
    if (existing) {
      if (existing.id === activeTabId) return { type: 'noop' }
      return { type: 'focus', tabId: existing.id }
    }
  }

  const active = tabs.find(tab => tab.id === activeTabId)
  if (active && isBlankBrowserUrl(active.url)) return { type: 'navigate' }
  return { type: 'add-tab' }
}
