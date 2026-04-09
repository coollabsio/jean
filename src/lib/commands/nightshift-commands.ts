import { Moon, History } from 'lucide-react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useNightshiftStore } from '@/store/nightshift-store'
import { useProjectsStore } from '@/store/projects-store'
import type { AppCommand } from './types'

export const nightshiftCommands: AppCommand[] = [
  {
    id: 'nightshift.run-now',
    label: 'Nightshift: Run Maintenance Checks',
    description: 'Run AI maintenance checks on the current project',
    icon: Moon,
    group: 'maintenance',
    keywords: ['nightshift', 'maintenance', 'lint', 'review', 'checks', 'audit'],
    async execute() {
      const projectId = useProjectsStore.getState().selectedProjectId
      if (!projectId) {
        toast.error('No project selected')
        return
      }
      const toastId = toast.loading('Starting Nightshift run...')
      try {
        await invoke('nightshift_start_run', { projectId })
        toast.success('Nightshift run started', { id: toastId })
      } catch (error) {
        toast.error(`Failed to start: ${error}`, { id: toastId })
      }
    },
    isAvailable: (ctx) => ctx.hasSelectedProject(),
  },
  {
    id: 'nightshift.view-runs',
    label: 'Nightshift: View Run History',
    description: 'View past Nightshift maintenance runs and findings',
    icon: History,
    group: 'maintenance',
    keywords: ['nightshift', 'history', 'runs', 'findings'],
    execute() {
      const projectId = useProjectsStore.getState().selectedProjectId
      if (projectId) {
        useNightshiftStore.getState().openRunsModal(projectId)
      }
    },
    isAvailable: (ctx) => ctx.hasSelectedProject(),
  },
]
