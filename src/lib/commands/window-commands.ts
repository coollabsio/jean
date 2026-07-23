import { Maximize, Minus, Minimize, Square, X } from 'lucide-react'

import type { AppCommand } from './types'
import { isNativeApp } from '@/lib/environment'
import { requestAppQuit } from '@/lib/window-close'

const getAppWindow = async () => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

export const windowCommands: AppCommand[] = [
  {
    id: 'window-close',
    label: 'Close Window',
    icon: X,
    group: 'window',
    execute: async () => {
      if (!isNativeApp()) return
      // Use destroy-based quit so Windows doesn't silently ignore close() when
      // an async onCloseRequested handler is registered (loading or otherwise).
      await requestAppQuit()
    },
  },
  {
    id: 'window-minimize',
    label: 'Minimize Window',
    icon: Minus,
    group: 'window',
    execute: async () => {
      if (!isNativeApp()) return
      const appWindow = await getAppWindow()
      await appWindow.minimize()
    },
  },
  {
    id: 'window-fullscreen',
    label: 'Enter Fullscreen',
    icon: Maximize,
    group: 'window',
    execute: async () => {
      if (!isNativeApp()) return
      const appWindow = await getAppWindow()
      await appWindow.setFullscreen(true)
    },
  },
  {
    id: 'window-exit-fullscreen',
    label: 'Exit Fullscreen',
    icon: Minimize,
    group: 'window',
    execute: async () => {
      if (!isNativeApp()) return
      const appWindow = await getAppWindow()
      await appWindow.setFullscreen(false)
    },
  },
  {
    id: 'window-toggle-maximize',
    label: 'Toggle Maximize',
    icon: Square,
    group: 'window',
    execute: async () => {
      if (!isNativeApp()) return
      const appWindow = await getAppWindow()
      await appWindow.toggleMaximize()
    },
  },
]
