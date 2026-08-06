import { Sun, Moon, Monitor, Minimize2, Maximize2 } from 'lucide-react'
import type { AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'

export const appearanceCommands: AppCommand[] = [
  {
    id: 'zen-mode.toggle',
    label: 'Toggle Zen Mode',
    icon: Maximize2,
    group: 'appearance',
    keywords: [
      'zen',
      'focus',
      'fullscreen',
      'distraction',
      'session',
      'chrome',
    ],

    execute: () => {
      useUIStore.getState().toggleZenMode()
    },
    isAvailable: () => !useUIStore.getState().zenMode,
  },
  {
    id: 'zen-mode.exit',
    label: 'Exit Zen Mode',
    icon: Minimize2,
    group: 'appearance',
    keywords: ['zen', 'focus', 'exit', 'leave', 'fullscreen'],

    execute: () => {
      useUIStore.getState().setZenMode(false)
    },
    isAvailable: () => useUIStore.getState().zenMode,
  },
  {
    id: 'theme.light',
    label: 'Switch to Light Mode',
    icon: Sun,
    group: 'appearance',
    keywords: ['theme', 'light', 'bright', 'appearance', 'mode'],

    execute: context => {
      context.setTheme('light')
    },
    isAvailable: context => context.getCurrentTheme() !== 'light',
  },

  {
    id: 'theme.dark',
    label: 'Switch to Dark Mode',
    icon: Moon,
    group: 'appearance',
    keywords: ['theme', 'dark', 'night', 'appearance', 'mode'],

    execute: context => {
      context.setTheme('dark')
    },
    isAvailable: context => context.getCurrentTheme() !== 'dark',
  },

  {
    id: 'theme.system',
    label: 'Switch to System Theme',
    icon: Monitor,
    group: 'appearance',
    keywords: ['theme', 'system', 'auto', 'appearance', 'mode', 'default'],

    execute: context => {
      context.setTheme('system')
    },
    isAvailable: context => context.getCurrentTheme() !== 'system',
  },
]
