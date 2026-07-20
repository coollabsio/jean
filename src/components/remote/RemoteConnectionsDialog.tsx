import { useEffect, useState, type FormEvent } from 'react'
import { Check, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  LOCAL_CONNECTION_ID,
  addRemoteConnection,
  getActiveConnectionId,
  markConnectionSwitch,
  removeRemoteConnection,
  selectConnection,
  updateRemoteConnection,
  useRemoteConnections,
  type RemoteConnection,
} from '@/lib/remote-connections'

const EMPTY_FORM = { name: '', url: '', token: '' }

export function RemoteConnectionsDialog({
  reloadApp = () => window.location.reload(),
}: {
  reloadApp?: () => void
}) {
  const connections = useRemoteConnections()
  const activeId = getActiveConnectionId()
  const remoteActive = activeId !== LOCAL_CONNECTION_ID
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleOpen = (event: Event) => {
      setOpen(true)
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      const connection = connections.find(item => item.id === id)
      if (connection) {
        setEditingId(connection.id)
        setForm({
          name: connection.name,
          url: connection.url,
          token: connection.token,
        })
        setError(null)
      }
    }
    window.addEventListener('open-remote-connections', handleOpen)
    return () =>
      window.removeEventListener('open-remote-connections', handleOpen)
  }, [connections])

  const beginAdd = () => {
    setEditingId('new')
    setForm(EMPTY_FORM)
    setError(null)
  }

  const beginEdit = (connection: RemoteConnection) => {
    setEditingId(connection.id)
    setForm({
      name: connection.name,
      url: connection.url,
      token: connection.token,
    })
    setError(null)
  }

  const switchTo = (id: string) => {
    if (id === activeId) return
    markConnectionSwitch()
    selectConnection(id)
    reloadApp()
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    try {
      if (editingId === 'new') {
        const connection = addRemoteConnection(form)
        markConnectionSwitch()
        selectConnection(connection.id)
        reloadApp()
        return
      }
      if (editingId) {
        updateRemoteConnection(editingId, form)
        if (editingId === activeId) {
          markConnectionSwitch()
          reloadApp()
        }
        setEditingId(null)
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError)
      )
    }
  }

  const handleDelete = (id: string) => {
    const wasActive = id === activeId
    removeRemoteConnection(id)
    if (wasActive) {
      markConnectionSwitch()
      reloadApp()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          aria-label="Jean connections"
          title="Jean connections"
          variant="ghost"
          size="icon"
          className="relative h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
        >
          <Server className="size-3.5" />
          {remoteActive && (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-green-500" />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Jean connections</DialogTitle>
          <DialogDescription>
            Switch this client between Local and a remote Jean Web Access
            server.
          </DialogDescription>
        </DialogHeader>

        {editingId ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="remote-name">Name</Label>
              <Input
                id="remote-name"
                value={form.name}
                onChange={event =>
                  setForm(current => ({ ...current, name: event.target.value }))
                }
                placeholder="Build server"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remote-url">Web Access URL</Label>
              <Input
                id="remote-url"
                value={form.url}
                onChange={event =>
                  setForm(current => ({ ...current, url: event.target.value }))
                }
                placeholder="https://jean.example.com/?token=..."
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remote-token">Access token</Label>
              <Input
                id="remote-token"
                type="password"
                value={form.token}
                onChange={event =>
                  setForm(current => ({
                    ...current,
                    token: event.target.value,
                  }))
                }
                placeholder="Optional when included in the URL"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingId(null)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {editingId === 'new' ? 'Save & Connect' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-2">
            <ConnectionRow
              name="Local"
              detail="This computer"
              active={activeId === LOCAL_CONNECTION_ID}
              onSelect={() => switchTo(LOCAL_CONNECTION_ID)}
            />
            {connections.map(connection => (
              <ConnectionRow
                key={connection.id}
                name={connection.name}
                detail={connection.url}
                active={activeId === connection.id}
                onSelect={() => switchTo(connection.id)}
                onEdit={() => beginEdit(connection)}
                onDelete={() => handleDelete(connection.id)}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              className="mt-2 w-full"
              onClick={beginAdd}
            >
              <Plus className="mr-2 size-4" />
              Add remote
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConnectionRow({
  name,
  detail,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  name: string
  detail: string
  active: boolean
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            className={`size-2 rounded-full ${active ? 'bg-green-500' : 'bg-muted-foreground/35'}`}
          />
          {name}
          {active && <Check className="size-3.5 text-green-500" />}
        </span>
        <span className="ml-4 block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      </button>
      {onEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Edit ${name}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          aria-label={`Delete ${name}`}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
