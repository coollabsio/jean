import { isNativeApp } from '@/lib/environment'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {writable.map(snapshot => (
            <SelectItem key={snapshot.serverId} value={snapshot.serverId}>
              {snapshot.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
