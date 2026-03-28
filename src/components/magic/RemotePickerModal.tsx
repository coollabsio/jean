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

export function RemotePickerModal() {
  const { remotePickerOpen, remotePickerRepoPath, closeRemotePicker } =
    useUIStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const queryClient = useQueryClient()

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
          {remotes.map((remote, i) => (
            <button
              key={remote.name}
              onClick={() => selectRemote(i)}
              onMouseEnter={() => setSelectedIndex(i)}
              className={cn(
                'w-full flex items-center justify-between px-4 py-2 text-sm transition-colors',
                'hover:bg-accent focus:outline-none',
                selectedIndex === i && 'bg-accent'
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate">{remote.name}</span>
              </div>
              <div className="flex items-center gap-1.5 ml-2 shrink-0">
                {remote.name !== 'origin' && selectedIndex === i && (
                  <Delete
                    className="h-3.5 w-3.5 text-muted-foreground/50"
                    aria-label="Press backspace to remove"
                  />
                )}
                {i < 9 && (
                  <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    {i + 1}
                  </kbd>
                )}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
