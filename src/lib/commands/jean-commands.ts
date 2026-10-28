import { toast } from 'sonner'
import { Github, Heart, Info } from '@/components/icons/reicon'
import { FALLBACK_APP_VERSION } from '@/lib/app-version'
import { isNativeApp } from '@/lib/environment'
import { openExternal } from '@/lib/platform'
import type { AppCommand } from './types'

export const JEAN_GITHUB_URL = 'https://github.com/coollabsio/jean'
export const JEAN_SPONSOR_URL = 'https://jean.build/sponsorships/'

async function appVersion(): Promise<string> {
  if (!isNativeApp()) return FALLBACK_APP_VERSION
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion().catch(() => FALLBACK_APP_VERSION)
}

export const jeanCommands: AppCommand[] = [
  {
    id: 'jean.open-github',
    label: 'Open Jean on GitHub',
    icon: Github,
    group: 'jean',
    keywords: ['github', 'repository', 'source', 'issues', 'jean'],
    execute: () => openExternal(JEAN_GITHUB_URL),
  },
  {
    id: 'jean.sponsor',
    label: 'Sponsor Jean',
    icon: Heart,
    group: 'jean',
    keywords: ['sponsor', 'donate', 'support', 'jean'],
    execute: () => openExternal(JEAN_SPONSOR_URL),
  },
  {
    id: 'jean.show-version',
    label: 'Show Jean Version',
    description: 'Show the app version and open its release notes',
    icon: Info,
    group: 'jean',
    keywords: ['version', 'about', 'release', 'changelog', 'jean'],
    execute: async () => {
      const version = await appVersion()
      toast.info(`Jean v${version}`, {
        action: {
          label: 'Release notes',
          onClick: () =>
            openExternal(`${JEAN_GITHUB_URL}/releases/tag/v${version}`),
        },
      })
    },
  },
]
