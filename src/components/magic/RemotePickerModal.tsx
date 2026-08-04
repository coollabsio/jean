import { useCallback, useState, useRef } from 'react'
import { GitBranch, Delete } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore, getRemotePickerCallback } from '@/store/ui-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getGitRemotes, removeGitRemote } from '@/services/git-status'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'

export function RemotePickerModal() {
  const { remotePickerOpen, remotePickerRepoPath, closeRemotePicker } =
    useUIStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()

  const { data: remotes = [] } = useQuery({
    queryKey: ['git-remotes', remotePickerRepoPath],
    queryFn: async () => {
      if (!remotePickerRepoPath) return []
      const orderedRemotes = await getGitRemotes(remotePickerRepoPath)
      setSelectedIndex(0)
      return orderedRemotes
    },
    enabled: remotePickerOpen && remotePickerRepoPath !== null,
    staleTime: 10_000,
  })

  const selectRemote = useCallback(
    (index: number) => {
      const remote = remotes[index]
      const callback = getRemotePickerCallback()
      if (!remote || !callback) return
      closeRemotePicker()
      callback(remote.name)
    },
    [remotes, closeRemotePicker]
  )

  const handleRemoveRemote = useCallback(
    async (index: number) => {
      const remote = remotes[index]
      if (!remote || !remotePickerRepoPath || remote.name === 'origin') return

      await removeGitRemote(remotePickerRepoPath, remote.name)
      await queryClient.invalidateQueries({
        queryKey: ['git-remotes', remotePickerRepoPath],
      })

      // Adjust selection if we removed the last item
      setSelectedIndex(i => Math.min(i, remotes.length - 2))
    },
    [remotes, remotePickerRepoPath, queryClient]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key

      // Number keys 1-9
      const num = parseInt(key, 10)
      if (!isNaN(num) && num >= 1 && num <= remotes.length) {
        e.preventDefault()
        e.stopPropagation()
        selectRemote(num - 1)
        return
      }

      if (key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        handleRemoveRemote(selectedIndex)
      } else if (key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        selectRemote(selectedIndex)
      } else if (key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % remotes.length)
      } else if (key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + remotes.length) % remotes.length)
      }
    },
    [remotes.length, selectedIndex, selectRemote, handleRemoveRemote]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeRemotePicker()
    },
    [closeRemotePicker]
  )

  return (
    <Dialog open={remotePickerOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="p-0 outline-none sm:max-w-[280px]"
        onOpenAutoFocus={e => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 pt-5 pb-2">
          <DialogTitle className="text-sm font-medium">
            Pick a remote
          </DialogTitle>
        </DialogHeader>

        <div className="pb-2">
          {remotes.map((remote, i) => {
            const canRemove = remote.name !== 'origin'
            const showRemove = canRemove && (isMobile || selectedIndex === i)

            return (
              <div
                key={remote.name}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  'flex items-center transition-colors hover:bg-accent',
                  selectedIndex === i && 'bg-accent'
                )}
              >
                <button
                  type="button"
                  onClick={() => selectRemote(i)}
                  className="flex min-w-0 flex-1 items-center justify-between px-4 py-2 text-sm focus:outline-none"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{remote.name}</span>
                  </div>
                  {i < 9 && (
                    <kbd className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {i + 1}
                    </kbd>
                  )}
                </button>
                {showRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${remote.name} remote`}
                    onClick={e => {
                      e.stopPropagation()
                      handleRemoveRemote(i)
                    }}
                    className="mr-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <Delete className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
