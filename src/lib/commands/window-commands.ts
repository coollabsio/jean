import { Maximize, Minus, Minimize, Square, X } from 'lucide-react'

import type { AppCommand } from './types'

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
      const appWindow = await getAppWindow()
      await appWindow.close()
    },
  },
  {
    id: 'window-minimize',
    label: 'Minimize Window',
    icon: Minus,
    group: 'window',
    execute: async () => {
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
      const appWindow = await getAppWindow()
      await appWindow.toggleMaximize()
    },
  },
]
