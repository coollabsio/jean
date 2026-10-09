import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { isNativeApp } from '@/lib/environment'
import { parseOptionalSshPort } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { useSaveServerProject, useSshPublicKeys } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import type { Project } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { projectServerId } from '../server-filter'

interface ServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Server to edit (undefined = add a new server) */
  project?: Project
}

export function ServerDialog({
  open,
  onOpenChange,
  project,
}: ServerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <ServerForm project={project} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Add/edit server dialog driven by the projects store. Mounted in MainWindow,
 * outside the sidebar, so it stays open when the mobile drawer closes.
 */
export function GlobalServerDialog() {
  const serverDialog = useProjectsStore(state => state.serverDialog)
  return (
    <ServerDialog
      open={serverDialog !== null}
      onOpenChange={open =>
        !open && useProjectsStore.getState().setServerDialog(null)
      }
      project={serverDialog?.project}
    />
  )
}

function ServerForm({
  project,
  onDone,
}: {
  project?: Project
  onDone: () => void
}) {
  const saveServer = useSaveServerProject()
  const snapshots = useServerConnectionSnapshots()
  // The Jean that stores a new server runs its sessions with its own backends.
  const jeans = [...snapshots.values()].filter(
    snapshot => snapshot.status === 'local' || snapshot.status === 'online'
  )
  const showRunFrom = !project && isNativeApp() && jeans.length > 1
  const [form, setForm] = useState({
    name: project?.name ?? '',
    user: project?.server?.user ?? '',
    host: project?.server?.host ?? '',
    port: project?.server?.port ? String(project.server.port) : '',
    identityFile: project?.server?.identity_file ?? '',
    runFrom: LOCAL_SERVER_ID as string,
    systemPrompt: project?.custom_system_prompt ?? '',
  })
  // The built-in local entry has no SSH settings: only name and prompt.
  const isLocal = !!project?.server?.local
  // Keys of the Jean that runs ssh for this server.
  const keys = useSshPublicKeys(
    project ? projectServerId(project) : form.runFrom,
    !isLocal
  )
  const keyOptions = (keys.data ?? []).map(key => ({
    path: key.path.replace(/\.pub$/, ''),
    label: `${key.path
      .split('/')
      .pop()
      ?.replace(/\.pub$/, '')} · ${key.keyType}${
      key.comment ? ` · ${key.comment}` : ''
    }`,
  }))
  // Keep a saved key that is not in the list (for example, no .pub file).
  if (
    form.identityFile &&
    !keyOptions.some(option => option.path === form.identityFile)
  ) {
    keyOptions.push({ path: form.identityFile, label: form.identityFile })
  }
  const [error, setError] = useState<string | null>(null)

  const update = (key: keyof typeof form) => (value: string) =>
    setForm(current => ({ ...current, [key]: value }))

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    let port: number | undefined
    try {
      port = parseOptionalSshPort(form.port)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    saveServer.mutate(
      {
        projectId: project?.id,
        name: form.name,
        server: project?.server?.local
          ? project.server
          : {
              host: form.host.trim(),
              user: form.user.trim() || null,
              port: port ?? null,
              identity_file: form.identityFile || null,
            },
        serverId: form.runFrom,
        systemPrompt: form.systemPrompt,
      },
      { onSuccess: onDone }
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{project ? 'Edit server' : 'Add server'}</DialogTitle>
        <DialogDescription>
          {isLocal ? (
            'This machine. No SSH. You approve each command.'
          ) : (
            <>Connects with SSH key auth. You approve each command.</>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="server-name">Name</Label>
        <Input
          id="server-name"
          value={form.name}
          onChange={event => update('name')(event.target.value)}
          placeholder="Production"
        />
      </div>
      {!isLocal && (
        <>
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Tip: use a non-root user. After you add the server, click the shield
            button to create one.
          </p>
          <div className="grid grid-cols-[1fr_1.5fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="server-user">SSH user</Label>
              <Input
                id="server-user"
                value={form.user}
                onChange={event => update('user')(event.target.value)}
                placeholder="root"
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-host">Host / IP</Label>
              <Input
                id="server-host"
                value={form.host}
                onChange={event => update('host')(event.target.value)}
                placeholder="192.168.1.50"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_1.5fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="server-port">SSH port</Label>
              <Input
                id="server-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={event => update('port')(event.target.value)}
                placeholder="22"
              />
            </div>
            {showRunFrom && (
              <div className="space-y-1.5">
                <Label htmlFor="server-run-from">Run from</Label>
                <NativeSelect
                  id="server-run-from"
                  className="w-full"
                  value={form.runFrom}
                  onChange={event => update('runFrom')(event.target.value)}
                >
                  {jeans.map(snapshot => (
                    <NativeSelectOption
                      key={snapshot.serverId}
                      value={snapshot.serverId}
                    >
                      {snapshot.serverId === LOCAL_SERVER_ID
                        ? 'This computer'
                        : snapshot.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>
          {showRunFrom && (
            <p className="text-xs text-muted-foreground">
              This Jean uses its own SSH keys and AI backends.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="server-identity-file">SSH key</Label>
            <NativeSelect
              id="server-identity-file"
              className="w-full"
              value={form.identityFile}
              onChange={event => update('identityFile')(event.target.value)}
            >
              <NativeSelectOption value="">
                Default (SSH config / agent)
              </NativeSelectOption>
              {keyOptions.map(option => (
                <NativeSelectOption key={option.path} value={option.path}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              {keys.isLoading ? (
                'Loading keys…'
              ) : keys.isError ? (
                'Could not load keys.'
              ) : (
                <>
                  Keys from <code>~/.ssh</code> on the machine that runs{' '}
                  <code>ssh</code>.
                </>
              )}
            </p>
          </div>
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="server-system-prompt">System prompt</Label>
        <Textarea
          id="server-system-prompt"
          value={form.systemPrompt}
          onChange={event => update('systemPrompt')(event.target.value)}
          placeholder="e.g. This host runs Coolify. Apps live in /data/coolify. Never restart the proxy."
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Added to every session on this server.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saveServer.isPending || (!isLocal && !form.host)}
        >
          {project ? 'Save' : 'Add server'}
        </Button>
      </DialogFooter>
    </form>
  )
}
