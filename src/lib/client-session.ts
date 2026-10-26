import { isNativeApp } from '@/lib/environment'
import { invoke } from '@/lib/transport'
import { generateId } from '@/lib/uuid'

/** Stable id for a browser profile. Desktop windows use this installation's id. */
export const BROWSER_CLIENT_ID_KEY = 'jean-client-id'

const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
}

export function getOrCreateBrowserClientId(): string {
  if (typeof localStorage === 'undefined') return generateId()
  try {
    const existing = localStorage.getItem(BROWSER_CLIENT_ID_KEY)
    if (existing && isClientId(existing)) return existing
    const created = generateId()
    localStorage.setItem(BROWSER_CLIENT_ID_KEY, created)
    return created
  } catch {
    return generateId()
  }
}

let clientIdPromise: Promise<string> | null = null

/**
 * Id of this UI client. A desktop window uses this installation's native id,
 * including while it is connected to a remote Jean server, so it does not
 * claim that server's migrated snapshot. Browsers keep an id in local storage.
 */
export function getClientId(): Promise<string> {
  if (!clientIdPromise) {
    clientIdPromise = resolveClientId()
  }
  return clientIdPromise
}

async function resolveClientId(): Promise<string> {
  if (isNativeApp()) {
    try {
      const id = await invoke<string>('get_native_client_id')
      if (typeof id === 'string' && isClientId(id)) return id
    } catch {
      // Web access and tests keep a browser id when the desktop command is absent.
    }
  }
  return getOrCreateBrowserClientId()
}

export function resetClientIdForTests(): void {
  clientIdPromise = null
}
