import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import type { AppCommand } from './types'
import type { AppPreferences } from '@/types/preferences'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
  deleted_contexts: number
}

export const maintenanceCommands: AppCommand[] = [
  {
    id: 'maintenance.cleanup-orphaned-sessions',
    label: 'Clean Up Orphaned Session Data',
    description: 'Remove session data not linked to any worktree',
    icon: Trash2,
    group: 'settings',
    keywords: [
      'cleanup',
      'orphan',
      'session',
      'maintenance',
      'storage',
      'disk',
    ],
    async execute(context) {
      const toastId = toast.loading('Cleaning up orphaned session data...')

      try {
        const prefs = context.queryClient.getQueryData<AppPreferences>([
          'preferences',
        ])
        const retentionDays = prefs?.archive_retention_days ?? 30

        const [result, combinedDeleted] = await Promise.all([
          invoke<CleanupResult>('cleanup_old_archives', { retentionDays }),
          invoke<number>('cleanup_combined_contexts'),
        ])

        const total =
          result.deleted_worktrees +
          result.deleted_sessions +
          (result.deleted_contexts ?? 0) +
          combinedDeleted

        if (total > 0) {
          const parts: string[] = []
          if (result.deleted_worktrees > 0) {
            parts.push(
              `${result.deleted_worktrees} worktree${result.deleted_worktrees === 1 ? '' : 's'}`
            )
          }
          if (result.deleted_sessions > 0) {
            parts.push(
              `${result.deleted_sessions} session${result.deleted_sessions === 1 ? '' : 's'}`
            )
          }
          if (result.deleted_contexts > 0) {
            parts.push(
              `${result.deleted_contexts} context${result.deleted_contexts === 1 ? '' : 's'}`
            )
          }
          if (combinedDeleted > 0) {
            parts.push(
              `${combinedDeleted} combined-context file${combinedDeleted === 1 ? '' : 's'}`
            )
          }

          context.queryClient.invalidateQueries({
            queryKey: ['archived-worktrees'],
          })
          context.queryClient.invalidateQueries({
            queryKey: ['all-archived-sessions'],
          })

          toast.success(`Cleaned up ${parts.join(' and ')}`, { id: toastId })
        } else {
          toast.info('No orphaned data found', { id: toastId })
        }
      } catch (error) {
        toast.error(`Cleanup failed: ${error}`, { id: toastId })
      }
    },
  },
]
