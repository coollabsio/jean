import { Sun, Moon, Monitor } from 'lucide-react'
import type { AppCommand } from './types'

export const appearanceCommands: AppCommand[] = [
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
