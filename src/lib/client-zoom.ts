/**
 * Client-local zoom settings.
 *
 * Zoom is a display concern (DPI, monitor, remote vs local shell) and must not
 * live in shared server preferences — otherwise native Jean and remote Jean
 * clients overwrite each other (issue #622).
 *
 * Server `zoom_level` / `mobile_zoom_level` / `sync_zoom_levels` remain only as
 * a one-time seed for clients that have never stored a local value.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ZOOM_LEVEL_DEFAULT } from '@/types/preferences'

export const CLIENT_ZOOM_STORAGE_KEY = 'jean-client-zoom'
export const CLIENT_ZOOM_CHANGED_EVENT = 'jean-client-zoom-changed'

export const ZOOM_LEVEL_MIN = 50
export const ZOOM_LEVEL_MAX = 200

export interface ClientZoomSettings {
  zoom_level: number
  mobile_zoom_level: number
  sync_zoom_levels: boolean
}

export interface ClientZoomSeed {
  zoom_level?: number
  mobile_zoom_level?: number
  sync_zoom_levels?: boolean
}

/** In-memory cache so updates work even if localStorage is unavailable/mocked. */
let memoryCache: ClientZoomSettings | null = null

export function clampZoomLevel(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_LEVEL_DEFAULT
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, Math.round(value)))
}

export function defaultClientZoomSettings(): ClientZoomSettings {
  return {
    zoom_level: ZOOM_LEVEL_DEFAULT,
    mobile_zoom_level: ZOOM_LEVEL_DEFAULT,
    sync_zoom_levels: true,
  }
}

function normalizeSettings(input: ClientZoomSeed): ClientZoomSettings {
  const defaults = defaultClientZoomSettings()
  const zoom = clampZoomLevel(input.zoom_level ?? defaults.zoom_level)
  return {
    zoom_level: zoom,
    mobile_zoom_level: clampZoomLevel(
      input.mobile_zoom_level ?? input.zoom_level ?? defaults.mobile_zoom_level
    ),
    sync_zoom_levels: input.sync_zoom_levels ?? defaults.sync_zoom_levels,
  }
}

function parseStored(raw: string | null): ClientZoomSettings | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ClientZoomSeed
    if (typeof parsed !== 'object' || parsed == null) return null
    return normalizeSettings(parsed)
  } catch {
    return null
  }
}

function readStorage(): ClientZoomSettings | null {
  if (typeof window === 'undefined') return null
  try {
    return parseStored(window.localStorage.getItem(CLIENT_ZOOM_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeStorage(settings: ClientZoomSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      CLIENT_ZOOM_STORAGE_KEY,
      JSON.stringify(settings)
    )
  } catch {
    // Quota / private mode — memory cache still works for the session.
  }
}

function notifyChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CLIENT_ZOOM_CHANGED_EVENT))
}

/** Read client zoom (memory first, then localStorage). */
export function readClientZoom(): ClientZoomSettings | null {
  if (memoryCache) return memoryCache
  const stored = readStorage()
  if (stored) {
    memoryCache = stored
    return stored
  }
  return null
}

/**
 * Persist a partial zoom update on this client only (never the shared backend).
 */
export function writeClientZoom(
  patch: Partial<ClientZoomSettings>
): ClientZoomSettings {
  const current = readClientZoom() ?? defaultClientZoomSettings()
  const next = normalizeSettings({ ...current, ...patch })
  memoryCache = next
  writeStorage(next)
  notifyChanged()
  return next
}

/**
 * Resolve zoom for this client. Prefer existing client storage; otherwise seed
 * from server preferences once and persist so later preference broadcasts do
 * not overwrite an independent remote/local zoom.
 */
export function resolveClientZoom(seed?: ClientZoomSeed | null): ClientZoomSettings {
  const existing = readClientZoom()
  if (existing) return existing

  const resolved = normalizeSettings(seed ?? defaultClientZoomSettings())
  memoryCache = resolved
  writeStorage(resolved)
  // Do not notify on first seed — callers already hold the resolved value.
  return resolved
}

/** Test helper: clear memory + storage. */
export function clearClientZoomForTests(): void {
  memoryCache = null
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CLIENT_ZOOM_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * React hook for client-local zoom. Seeds from server preferences once when
 * this client has no stored zoom yet.
 */
export function useClientZoom(seed?: ClientZoomSeed | null) {
  const [settings, setSettings] = useState<ClientZoomSettings>(() => {
    const existing = readClientZoom()
    if (existing) return existing
    // If preferences already hydrated on first render (common in tests and
    // warm caches), seed immediately so we do not flash default 100% zoom.
    if (seed != null) return resolveClientZoom(seed)
    return defaultClientZoomSettings()
  })
  const seededRef = useRef(readClientZoom() !== null)

  // Seed once from server preferences when local storage is empty.
  useEffect(() => {
    if (seededRef.current) return
    // Wait until seed is available so we don't lock in defaults before prefs load.
    if (seed == null) return
    const resolved = resolveClientZoom(seed)
    seededRef.current = true
    setSettings(resolved)
  }, [seed])

  // Sync across components (and tabs when localStorage works).
  useEffect(() => {
    const syncFromStore = () => {
      const next = readClientZoom()
      if (next) setSettings(next)
    }
    window.addEventListener(CLIENT_ZOOM_CHANGED_EVENT, syncFromStore)
    window.addEventListener('storage', syncFromStore)
    return () => {
      window.removeEventListener(CLIENT_ZOOM_CHANGED_EVENT, syncFromStore)
      window.removeEventListener('storage', syncFromStore)
    }
  }, [])

  const updateZoom = useCallback((patch: Partial<ClientZoomSettings>) => {
    const next = writeClientZoom(patch)
    setSettings(next)
    return next
  }, [])

  return {
    zoom_level: settings.zoom_level,
    mobile_zoom_level: settings.mobile_zoom_level,
    sync_zoom_levels: settings.sync_zoom_levels,
    updateZoom,
  }
}
