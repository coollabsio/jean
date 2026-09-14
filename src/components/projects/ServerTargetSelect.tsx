import { isNativeApp } from '@/lib/environment'
import { useServerConnectionSnapshots } from '@/lib/server-connections'

interface ServerTargetSelectProps {
  value: string
  onChange: (serverId: string) => void
  disabled?: boolean
  id?: string
}

export function ServerTargetSelect({
  value,
  onChange,
  disabled,
  id = 'project-target-server',
}: ServerTargetSelectProps) {
  const snapshots = useServerConnectionSnapshots()
  const writable = [...snapshots.values()].filter(snapshot =>
    ['local', 'online'].includes(snapshot.status)
  )

  if (!isNativeApp() || writable.length < 2) return null

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        Jean server
      </label>
      <select
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        {writable.map(snapshot => (
          <option key={snapshot.serverId} value={snapshot.serverId}>
            {snapshot.name}
          </option>
        ))}
      </select>
    </div>
  )
}
