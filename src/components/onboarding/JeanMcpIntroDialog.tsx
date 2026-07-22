import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { invoke } from '@/lib/transport'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useUIStore } from '@/store/ui-store'
import { invalidateAllMcpServers } from '@/services/mcp'
import {
  preferencesQueryKeys,
  usePatchPreferences,
  usePreferences,
} from '@/services/preferences'
import type { AppPreferences, CliBackend } from '@/types/preferences'

interface JeanMcpInstallResult {
  backend: CliBackend
  status: 'installed' | 'error'
  path: string | null
  backupPath: string | null
  serverName: string
  mode: 'dev' | 'prod'
  message: string
}

const INSTALLABLE_BACKENDS: CliBackend[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'kimi',
]

export function JeanMcpIntroDialog() {
  return <JeanMcpIntroDialogContent />
}

function JeanMcpIntroDialogContent() {
  const open = useUIStore(state => state.jeanMcpIntroOpen)
  const setOpen = useUIStore(state => state.setJeanMcpIntroOpen)
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const queryClient = useQueryClient()
  const { installedBackends, isLoading: installedBackendsLoading } =
    useInstalledBackends({ enabled: open })
  const [installing, setInstalling] = useState(false)

  const enabled = preferences?.jean_mcp_enabled ?? true
  const installableBackends = useMemo(
    () =>
      installedBackends.filter(backend =>
        INSTALLABLE_BACKENDS.includes(backend)
      ),
    [installedBackends]
  )

  const markSeenAndClose = useCallback(
    (extraPatch: Partial<AppPreferences> = {}) => {
      const patch = {
        ...extraPatch,
        has_seen_jean_mcp_intro: true,
      }

      // Optimistically update the cache before closing. Otherwise the App-level
      // startup gate can see stale preferences for a tick and reopen this dialog
      // while the patch mutation/refetch is still in flight.
      queryClient.setQueryData<AppPreferences>(
        preferencesQueryKeys.preferences(),
        current => (current ? { ...current, ...patch } : current)
      )
      patchPreferences.mutate(patch)
      setOpen(false)
    },
    [patchPreferences, queryClient, setOpen]
  )

  const handleEnabledChange = useCallback(
    (checked: boolean) => {
      patchPreferences.mutate({ jean_mcp_enabled: checked })
    },
    [patchPreferences]
  )

  const handleInstall = useCallback(async () => {
    if (installableBackends.length === 0) {
      toast.error(
        'Install Claude, Codex, Cursor, Grok, Kimi, or OpenCode first'
      )
      return
    }

    setInstalling(true)
    try {
      const results = await invoke<JeanMcpInstallResult[]>(
        'install_jean_mcp_config',
        {
          backends: installableBackends,
          mode: 'current',
        }
      )
      const successes = results.filter(r => r.status === 'installed')
      const failures = results.filter(r => r.status === 'error')
      invalidateAllMcpServers(undefined, installableBackends)
      markSeenAndClose({ jean_mcp_enabled: true })

      if (failures.length > 0) {
        toast.warning(
          `Jean MCP added to ${successes.length}/${results.length} CLI config${
            results.length === 1 ? '' : 's'
          }`
        )
      } else {
        toast.success('Jean MCP added to your CLI configs')
      }
    } catch (error) {
      console.error('Failed to add Jean MCP config', error)
      toast.error('Failed to add Jean MCP automatically')
    } finally {
      setInstalling(false)
    }
  }, [installableBackends, markSeenAndClose])

  const handleManual = useCallback(() => {
    markSeenAndClose()
    openPreferencesPane('mcp-servers')
  }, [markSeenAndClose, openPreferencesPane])

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (next) setOpen(true)
        else markSeenAndClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New: Jean MCP Server</DialogTitle>
          <DialogDescription>
            Jean can expose its own tools to your local AI CLIs through MCP, so
            they can call back into Jean to create worktrees, inspect project
            context, and start background investigations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3 rounded-md border px-4 py-3">
            <Switch
              id="jean-mcp-intro-enabled"
              checked={enabled}
              onCheckedChange={handleEnabledChange}
            />
            <div className="space-y-1">
              <Label
                htmlFor="jean-mcp-intro-enabled"
                className="cursor-pointer"
              >
                Enable Jean MCP server
              </Label>
              <p className="text-xs text-muted-foreground">
                You can disable this now or later in Settings → MCP Servers.
              </p>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Jean will not change your CLI configs unless you choose automatic
            setup. Manual setup snippets are available in Settings.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={handleManual}
            disabled={installing}
          >
            I’ll set it up manually
          </Button>
          <Button
            onClick={handleInstall}
            disabled={
              installing ||
              !enabled ||
              installedBackendsLoading ||
              installableBackends.length === 0
            }
          >
            {installing && <Loader2 className="mr-2 size-4 animate-spin" />}
            Add automatically
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default JeanMcpIntroDialog
