import { Bug } from 'lucide-react'
import { toast } from 'sonner'
import type { AppCommand, CommandContext } from './types'
import { notifications } from '@/lib/notifications'
import { useUIStore } from '@/store/ui-store'
import type { AppPreferences } from '@/types/preferences'

function isDebugMode(context: CommandContext): boolean {
  const prefs = context.queryClient.getQueryData<AppPreferences>([
    'preferences',
  ])
  return prefs?.debug_mode_enabled ?? false
}

export const notificationCommands: AppCommand[] = [
  {
    id: 'notification.test-toast',
    label: 'Test Toast Notification',
    description: 'Show a test toast notification',
    icon: Bug,
    group: 'debug',
    keywords: ['test', 'toast', 'notification', 'debug'],
    async execute() {
      await notifications.success('Test Toast', 'This is a test notification')
    },
    isAvailable: context => isDebugMode(context),
  },
  {
    id: 'notification.test-cli-update',
    label: 'Test CLI Update Notification',
    description: 'Show a fake CLI update toast',
    icon: Bug,
    group: 'debug',
    keywords: ['test', 'cli', 'update', 'notification', 'debug', 'claude'],
    execute() {
      const { openCliUpdateModal } = useUIStore.getState()
      const toastId = 'cli-update-claude-test'

      toast.info('Claude CLI update available', {
        id: toastId,
        description: 'v1.0.0 → v2.0.0',
        duration: Infinity,
        action: {
          label: 'Update',
          onClick: () => {
            openCliUpdateModal('claude')
            toast.dismiss(toastId)
          },
        },
        cancel: {
          label: 'Cancel',
          onClick: () => {
            toast.dismiss(toastId)
          },
        },
      })
    },
    isAvailable: context => isDebugMode(context),
  },
]
