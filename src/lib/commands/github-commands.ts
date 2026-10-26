import { CircleDot, GitPullRequest, Activity } from '@/components/icons/reicon'
import type { AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { projectsQueryKeys } from '@/services/projects'
import {
  gitProviderQueryKeys,
  type GitProviderInfo,
} from '@/services/git-provider'
import type { Project } from '@/types/projects'

export const githubCommands: AppCommand[] = [
  {
    id: 'open-github-issues',
    label: 'Open GitHub Issues',
    description: 'View issues for current project',
    icon: CircleDot,
    group: 'github',
    keywords: ['github', 'issues', 'bugs', 'tickets'],

    execute: () => {
      const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
        useUIStore.getState()
      setNewWorktreeModalDefaultTab('issues')
      setNewWorktreeModalOpen(true)
    },
    isAvailable: context => context.hasSelectedProject(),
  },

  {
    id: 'open-github-pull-requests',
    label: 'Open GitHub Pull Requests',
    description: 'View pull requests for current project',
    icon: GitPullRequest,
    group: 'github',
    keywords: ['github', 'pull', 'requests', 'pr', 'merge'],

    execute: () => {
      const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
        useUIStore.getState()
      setNewWorktreeModalDefaultTab('prs')
      setNewWorktreeModalOpen(true)
    },
    isAvailable: context => context.hasSelectedProject(),
  },

  {
    id: 'open-github-workflows',
    label: 'Open GitHub Workflows',
    description: 'View workflow runs for current project',
    icon: Activity,
    group: 'github',
    keywords: [
      'github',
      'workflows',
      'actions',
      'ci',
      'cd',
      'pipelines',
      'runs',
    ],

    execute: context => {
      const { selectedProjectId } = useProjectsStore.getState()
      if (!selectedProjectId) return

      const projects = context.queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.id === selectedProjectId)
      if (!project) return

      const { setWorkflowRunsModalOpen } = useUIStore.getState()
      setWorkflowRunsModalOpen(true, project.path)
    },
    isAvailable: context => {
      if (!context.hasSelectedProject()) return false
      const { selectedProjectId } = useProjectsStore.getState()
      const projects = context.queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.id === selectedProjectId)
      if (!project?.path) return true
      const provider = context.queryClient.getQueryData<GitProviderInfo>(
        gitProviderQueryKeys.forPath(project.path)
      )
      return provider?.provider !== 'gitlab'
    },
  },
]
