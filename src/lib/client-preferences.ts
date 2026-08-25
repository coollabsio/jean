import {
  CLIENT_PREFERENCE_KEYS,
  type ClientPreferences,
} from '@/types/client-preferences'
import {
  defaultPreferences,
  type AppPreferences,
} from '@/types/preferences'

export const CLIENT_PREFERENCES_STORAGE_KEY = 'jean-client-preferences-v1'
export const CLIENT_PREFERENCES_CHANGED_EVENT =
  'jean-client-preferences-changed'

const listeners = new Set<(preferences: ClientPreferences) => void>()
let memoryCache: ClientPreferences | null = null
let storageListenerInstalled = false

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)))

const finiteNumber = (value: unknown, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function defaultClientPreferences(): ClientPreferences {
  const preferences = { schema_version: 1 } as ClientPreferences
  for (const key of CLIENT_PREFERENCE_KEYS) {
    Object.assign(preferences, { [key]: defaultPreferences[key] })
  }
  return preferences
}

function normalize(
  input: Partial<ClientPreferences> | null | undefined
): ClientPreferences {
  const next: ClientPreferences = {
    ...defaultClientPreferences(),
    ...input,
    schema_version: 1,
  }
  next.zoom_level = clamp(finiteNumber(next.zoom_level, 100), 50, 200)
  next.mobile_zoom_level = clamp(
    finiteNumber(next.mobile_zoom_level, next.zoom_level),
    50,
    200
  )
  next.terminal_font_size = clamp(
    finiteNumber(next.terminal_font_size, 13),
    10,
    24
  )
  next.ui_font_size = clamp(finiteNumber(next.ui_font_size, 14), 10, 24)
  next.chat_font_size = clamp(finiteNumber(next.chat_font_size, 14), 10, 24)
  return next
}

function parse(raw: string | null): ClientPreferences | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ClientPreferences>
    return value && typeof value === 'object' ? normalize(value) : null
  } catch {
    return null
  }
}

function readStored(): ClientPreferences | null {
  if (typeof window === 'undefined') return null
  try {
    return parse(window.localStorage.getItem(CLIENT_PREFERENCES_STORAGE_KEY))
  } catch {
    return null
  }
}

function persist(preferences: ClientPreferences) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      CLIENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    )
  } catch {
    // Memory storage still works when browser persistence is unavailable.
  }
}

function fromLegacy(legacy: Partial<AppPreferences>): ClientPreferences {
  const seed: Partial<ClientPreferences> = {}
  for (const key of CLIENT_PREFERENCE_KEYS) {
    if (legacy[key] !== undefined) Object.assign(seed, { [key]: legacy[key] })
  }
  if (typeof window !== 'undefined') {
    try {
      const zoom = JSON.parse(
        window.localStorage.getItem('jean-client-zoom') ?? 'null'
      ) as Partial<ClientPreferences> | null
      if (zoom) Object.assign(seed, zoom)
    } catch {
      // Ignore malformed legacy zoom storage.
    }
  }
  return normalize(seed)
}

function notify(preferences: ClientPreferences) {
  for (const listener of listeners) listener(preferences)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CLIENT_PREFERENCES_CHANGED_EVENT))
  }
}

function installStorageListener() {
  if (storageListenerInstalled || typeof window === 'undefined') return
  window.addEventListener('storage', event => {
    if (event.key !== CLIENT_PREFERENCES_STORAGE_KEY) return
    const preferences = parse(event.newValue) ?? defaultClientPreferences()
    memoryCache = preferences
    notify(preferences)
  })
  storageListenerInstalled = true
}

export function readClientPreferences(
  legacy?: Partial<AppPreferences> | null
): ClientPreferences {
  installStorageListener()
  if (memoryCache) return memoryCache
  const stored = readStored()
  if (stored) return (memoryCache = stored)

  const preferences = legacy ? fromLegacy(legacy) : defaultClientPreferences()
  memoryCache = preferences
  persist(preferences)
  return preferences
}

export function updateClientPreferences(
  patch: Partial<ClientPreferences>
): ClientPreferences {
  const preferences = normalize({ ...readClientPreferences(), ...patch })
  memoryCache = preferences
  persist(preferences)
  notify(preferences)
  return preferences
}

export function subscribeToClientPreferences(
  listener: (preferences: ClientPreferences) => void
): () => void {
  installStorageListener()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const clientPreferenceKeySet = new Set<string>(CLIENT_PREFERENCE_KEYS)

export function splitClientPreferencePatch(
  patch: Partial<AppPreferences>
): [Partial<ClientPreferences>, Partial<AppPreferences>] {
  const client: Partial<ClientPreferences> = {}
  const server: Partial<AppPreferences> = {}
  for (const [key, value] of Object.entries(patch)) {
    Object.assign(clientPreferenceKeySet.has(key) ? client : server, {
      [key]: value,
    })
  }
  return [client, server]
}

export function clearClientPreferencesForTests() {
  memoryCache = null
  listeners.clear()
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CLIENT_PREFERENCES_STORAGE_KEY)
  } catch {
    // Ignore unavailable test storage.
  }
}
