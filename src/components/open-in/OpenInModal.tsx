import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import {
  Code,
  Terminal,
  Folder,
  Settings,
  Github,
  GitPullRequest,
  CircleDot,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import {
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInEditor,
  useOpenBranchOnGitHub,
  useProjects,
  useWorktree,
} from '@/services/projects'
import { useLoadedIssueContexts, useLoadedPRContexts } from '@/services/github'
import { usePreferences } from '@/services/preferences'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import { notify } from '@/lib/notifications'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { isServerApp } from '@/lib/environment'

type ModalOption = {
  id: string
  label: string
  icon: typeof Code
  key?: string
  url?: string
}

export function OpenInModal() {
  const { openInModalOpen, setOpenInModalOpen, openPreferencesPane } =
    useUIStore()
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: projects } = useProjects()
  const hasInitializedRef = useRef(false)
  const [selectedOption, setSelectedOption] = useState<string>('editor')

  const { data: worktree } = useWorktree(selectedWorktreeId)
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const openOnGitHub = useOpenBranchOnGitHub()
  const { data: preferences } = usePreferences()
  const activeSessionId = useChatStore(state =>
    selectedWorktreeId ? state.activeSessionIds[selectedWorktreeId] ?? null : null
  )
  const { data: loadedPRs } = useLoadedPRContexts(activeSessionId)
  const { data: loadedIssues } = useLoadedIssueContexts(activeSessionId)

  const isServer = isServerApp()

  // Base options (Editor, Terminal, Finder, GitHub)
  const baseOptions = useMemo(() => {
    const allOptions: ModalOption[] = [
      {
        id: 'editor',
        label: getEditorLabel(preferences?.editor),
        icon: Code,
        key: 'E',
      },
      {
        id: 'terminal',
        label: getTerminalLabel(preferences?.terminal),
        icon: Terminal,
        key: 'T',
      },
      {
        id: 'finder',
        label: 'Finder',
        icon: Folder,
        key: 'F',
      },
      {
        id: 'github',
        label: 'GitHub',
        icon: Github,
        key: 'G',
      },
    ]

    return isServer
      ? allOptions
      : allOptions.filter(opt => opt.id === 'github')
  }, [preferences?.editor, preferences?.terminal, isServer])

  // Context options (loaded PRs + issues, numbered 1-9)
  const contextOptions = useMemo(() => {
    const items: ModalOption[] = []
    let keyIndex = 1

    if (loadedPRs) {
      for (const pr of loadedPRs) {
        items.push({
          id: `pr-${pr.number}`,
          label: `PR #${pr.number}`,
          icon: GitPullRequest,
          key: keyIndex <= 9 ? String(keyIndex) : undefined,
          url: `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`,
        })
        keyIndex++
      }
    }

    if (loadedIssues) {
      for (const issue of loadedIssues) {
        items.push({
          id: `issue-${issue.number}`,
          label: `Issue #${issue.number}`,
          icon: CircleDot,
          key: keyIndex <= 9 ? String(keyIndex) : undefined,
          url: `https://github.com/${issue.repoOwner}/${issue.repoName}/issues/${issue.number}`,
        })
        keyIndex++
      }
    }

    return items
  }, [loadedPRs, loadedIssues])

  const allOptions = useMemo(
    () => [...baseOptions, ...contextOptions],
    [baseOptions, contextOptions]
  )

  const useWideLayout = contextOptions.length > 4

  useEffect(() => {
    if (!openInModalOpen) {
      hasInitializedRef.current = false
    }
  }, [openInModalOpen])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open && !hasInitializedRef.current) {
        setSelectedOption(isServer ? 'editor' : 'github')
        hasInitializedRef.current = true
      }
      setOpenInModalOpen(open)
    },
    [setOpenInModalOpen, isServer]
  )

  const getTargetPath = useCallback(() => {
    if (selectedWorktreeId) {
      const path = useChatStore.getState().getWorktreePath(selectedWorktreeId)
      if (path) return path
    }
    if (selectedProjectId && projects) {
      const project = projects.find(p => p.id === selectedProjectId)
      if (project) return project.path
    }
    return null
  }, [selectedWorktreeId, selectedProjectId, projects])

  const executeAction = useCallback(
    (optionId: string) => {
      // Handle context options (PR/issue URLs)
      const contextOpt = contextOptions.find(o => o.id === optionId)
      if (contextOpt?.url) {
        openExternal(contextOpt.url)
        setOpenInModalOpen(false)
        return
      }

      const targetPath = getTargetPath()
      if (!targetPath) {
        notify('No project or worktree selected', undefined, { type: 'error' })
        setOpenInModalOpen(false)
        return
      }

      switch (optionId) {
        case 'editor':
          openInEditor.mutate({
            worktreePath: targetPath,
            editor: preferences?.editor,
          })
          break
        case 'terminal':
          openInTerminal.mutate({
            worktreePath: targetPath,
            terminal: preferences?.terminal,
          })
          break
        case 'finder':
          openInFinder.mutate(targetPath)
          break
        case 'github': {
          const branch = worktree?.branch
          if (!branch) {
            if (selectedProjectId) {
              invoke('open_project_on_github', { projectId: selectedProjectId })
            } else {
              notify('No project selected', undefined, { type: 'error' })
            }
            break
          }
          openOnGitHub.mutate({ repoPath: targetPath, branch })
          break
        }
      }

      setOpenInModalOpen(false)
    },
    [
      contextOptions,
      getTargetPath,
      openInEditor,
      openInTerminal,
      openInFinder,
      openOnGitHub,
      worktree,
      preferences,
      setOpenInModalOpen,
      selectedProjectId,
    ]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const allIds = allOptions.map(opt => opt.id)

      // Quick select with shortcut keys
      const matchedOption = allOptions.find(
        opt => opt.key && opt.key.toLowerCase() === key
      )
      if (matchedOption) {
        e.preventDefault()
        executeAction(matchedOption.id)
      } else if (key === 'enter') {
        e.preventDefault()
        executeAction(selectedOption)
      } else if (key === 'arrowdown' || key === 'arrowup') {
        e.preventDefault()
        const currentIndex = allIds.indexOf(selectedOption)
        const newIndex =
          key === 'arrowdown'
            ? (currentIndex + 1) % allIds.length
            : (currentIndex - 1 + allIds.length) % allIds.length
        const newOptionId = allIds[newIndex]
        if (newOptionId) {
          setSelectedOption(newOptionId)
        }
      }
    },
    [executeAction, selectedOption, allOptions]
  )

  const handleOpenSettings = useCallback(() => {
    setOpenInModalOpen(false)
    openPreferencesPane('general')
  }, [setOpenInModalOpen, openPreferencesPane])

  const renderOption = (option: ModalOption) => {
    const Icon = option.icon
    const isSelected = selectedOption === option.id

    return (
      <button
        key={option.id}
        onClick={() => executeAction(option.id)}
        onMouseEnter={() => setSelectedOption(option.id)}
        className={cn(
          'w-full flex items-center justify-between px-4 py-2 text-sm transition-colors',
          'hover:bg-accent focus:outline-none',
          isSelected && 'bg-accent'
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate">{option.label}</span>
        </div>
        {option.key && (
          <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded ml-2 shrink-0">
            {option.key}
          </kbd>
        )}
      </button>
    )
  }

  return (
    <Dialog open={openInModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn('p-0', useWideLayout ? 'sm:max-w-[560px]' : 'sm:max-w-[280px]')}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-sm font-medium">Open in...</DialogTitle>
        </DialogHeader>

        <div className="pb-2">
          {baseOptions.map(renderOption)}
        </div>

        {contextOptions.length > 0 && (
          <div className="border-t pb-2">
            <div className="px-4 pt-2 pb-1">
              <span className="text-xs text-muted-foreground">Contexts</span>
            </div>
            {useWideLayout ? (
              <div className="grid grid-cols-2">
                {contextOptions.map(renderOption)}
              </div>
            ) : (
              contextOptions.map(renderOption)
            )}
          </div>
        )}

        <div className="border-t px-4 py-2">
          <button
            onClick={handleOpenSettings}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="h-3 w-3" />
            <span>Change defaults in Settings</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default OpenInModal
