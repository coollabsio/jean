import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
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
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { copyToClipboard } from '@/lib/clipboard'
import {
  fetchServerUserSetupScript,
  useSetupServerUser,
  useSshPublicKeys,
  type ServerUserAccess,
} from '@/services/projects'
import type { Project } from '@/types/projects'
import { projectServerId } from '../server-filter'

const ACCESS_OPTIONS: { value: ServerUserAccess; label: string }[] = [
  { value: 'readonly', label: 'Read-only sudo (recommended)' },
  { value: 'none', label: 'No sudo' },
  { value: 'full', label: 'Full sudo (not recommended)' },
]

const ACCESS_HELP: Record<ServerUserAccess, string> = {
  readonly:
    'Log groups (adm, systemd-journal) plus sudo only for read-only commands: systemctl status, docker ps/logs/inspect/stats, docker compose ps/logs, ss -tulpn. Note: docker inspect can show container environment secrets.',
  none: 'Log groups (adm, systemd-journal) only. No sudo.',
  full: 'Passwordless sudo for every command. The AI can change anything; you still approve each command in Supervised mode.',
}

interface ServerUserSetupDialogProps {
  project: Project | null
  onOpenChange: (open: boolean) => void
}

export function ServerUserSetupDialog({
  project,
  onOpenChange,
}: ServerUserSetupDialogProps) {
  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {project && (
          <SetupForm project={project} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SetupForm({
  project,
  onDone,
}: {
  project: Project
  onDone: () => void
}) {
  const serverId = projectServerId(project)
  const keys = useSshPublicKeys(serverId, true)
  const setupUser = useSetupServerUser()
  const currentUser = project.server?.user
  const [form, setForm] = useState({
    rootUser: currentUser && currentUser !== 'jean' ? currentUser : 'root',
    user: 'jean',
    access: 'readonly' as ServerUserAccess,
    keyPath: '',
  })
  const keyList = keys.data ?? []
  const selectedKey =
    keyList.find(key => key.path === form.keyPath) ?? keyList[0]

  const update = (key: keyof typeof form) => (value: string) =>
    setForm(current => ({ ...current, [key]: value }))

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!selectedKey) return
    setupUser.mutate(
      {
        projectId: project.id,
        rootUser: form.rootUser,
        user: form.user,
        publicKey: selectedKey.content,
        access: form.access,
      },
      { onSuccess: onDone }
    )
  }

  const handleCopyScript = async () => {
    if (!selectedKey) return
    try {
      const script = await fetchServerUserSetupScript(serverId, {
        user: form.user,
        publicKey: selectedKey.content,
        access: form.access,
      })
      await copyToClipboard(script)
      toast.success('Setup script copied. Run it as root on the server.')
    } catch (error) {
      toast.error('Failed to create setup script', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Set up a restricted user</DialogTitle>
        <DialogDescription>
          Recommended: do not let the AI use root. Jean connects once as the
          admin user, creates a dedicated user with limited access, and adds the
          selected public key. After that, {project.name} uses the new user.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="setup-root-user">Connect as (root)</Label>
          <Input
            id="setup-root-user"
            value={form.rootUser}
            onChange={event => update('rootUser')(event.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-user">New user</Label>
          <Input
            id="setup-user"
            value={form.user}
            onChange={event => update('user')(event.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-key">Public key to authorize</Label>
        {keys.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading keys…</p>
        ) : keyList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No public key in <code>~/.ssh</code> on the machine that runs Jean
            {project.serverName ? ` (${project.serverName})` : ''}. Create one
            there with <code>ssh-keygen -t ed25519</code>.
          </p>
        ) : (
          <NativeSelect
            id="setup-key"
            className="w-full"
            value={selectedKey?.path}
            onChange={event => update('keyPath')(event.target.value)}
          >
            {keyList.map(key => (
              <NativeSelectOption key={key.path} value={key.path}>
                {key.path.split('/').pop()} · {key.keyType}
                {key.comment ? ` · ${key.comment}` : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <p className="text-xs text-muted-foreground">
          Keys come from the machine that runs <code>ssh</code>
          {project.serverName ? ` (${project.serverName})` : ' (this machine)'}.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-access">Access</Label>
        <NativeSelect
          id="setup-access"
          className="w-full"
          value={form.access}
          onChange={event => update('access')(event.target.value)}
        >
          {ACCESS_OPTIONS.map(option => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          {ACCESS_HELP[form.access]}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        The admin user must accept SSH key auth from this machine. If it does
        not, copy the script and run it as root on the server.
      </p>
      <DialogFooter className="gap-2 sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void handleCopyScript()}
          disabled={!selectedKey}
        >
          Copy script
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!selectedKey || setupUser.isPending}>
            {setupUser.isPending ? 'Setting up…' : 'Set up user'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}
