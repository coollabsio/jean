import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface BackendCliSourceSelectProps {
  value: 'jean' | 'path'
  onValueChange: (value: 'jean' | 'path') => void
  backendName: string
  managedDescription?: string
  path: string | null | undefined
  pathVersion?: string | null
  pathFound: boolean
}

export function BackendCliSourceSelect({
  value,
  onValueChange,
  backendName,
  managedDescription,
  path,
  pathVersion,
  pathFound,
}: BackendCliSourceSelectProps) {
  const managedHint =
    managedDescription ??
    `Jean installs and updates an isolated ${backendName} version.`
  const pathHint = pathFound ? (path ?? undefined) : `No ${backendName} on PATH`

  return (
    <Select
      value={value}
      onValueChange={next => {
        if (next === 'jean' || next === 'path') onValueChange(next)
      }}
    >
      <SelectTrigger
        aria-label={`${backendName} source`}
        title={value === 'jean' ? managedHint : pathHint}
        className="w-full sm:w-80"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="jean" title={managedHint}>
          Jean managed
        </SelectItem>
        <SelectItem value="path" disabled={!pathFound} title={pathHint}>
          System PATH
          {!pathFound ? ' (not found)' : pathVersion ? ` (${pathVersion})` : ''}
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
