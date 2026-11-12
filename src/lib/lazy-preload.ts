import { lazy, type ComponentType } from 'react'
import { scheduleIdleWork } from './idle'

type Loader = () => Promise<unknown>

/**
 * React.lazy with a `preload()` that fetches the chunk before first render.
 * Preload and render share one import promise; a failed load is retried.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithPreload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>
) {
  let pending: Promise<{ default: T }> | undefined
  const preload = () =>
    (pending ??= load().catch((error: unknown) => {
      pending = undefined
      throw error
    }))
  return Object.assign(lazy(preload), { preload })
}

/**
 * Run loaders one at a time, each in its own idle slot, so preloading does
 * not compete with startup work. Returns a cancel function.
 */
export function preloadWhenIdle(loaders: Loader[], timeout = 3000) {
  let index = 0
  let cancelIdle = () => {
    /* noop */
  }
  const next = () => {
    const loader = loaders[index++]
    if (!loader) return
    cancelIdle = scheduleIdleWork(() => {
      // A failed preload is not fatal: React.lazy loads again on first render.
      void loader()
        .catch(() => undefined)
        .finally(next)
    }, timeout)
  }
  next()
  return () => {
    index = loaders.length
    cancelIdle()
  }
}
