import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

interface BackendCliSourceCardsProps {
  value: 'jean' | 'path'
  onValueChange: (value: 'jean' | 'path') => void
  backendName: string
  managedDescription?: string
  path: string | null | undefined
  pathVersion?: string | null
  pathFound: boolean
}

export function BackendCliSourceCards({
  value,
  onValueChange,
  backendName,
  managedDescription,
  path,
  pathVersion,
  pathFound,
}: BackendCliSourceCardsProps) {
  const sourceId = backendName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return (
    <RadioGroup
      value={value}
      onValueChange={next => {
        if (next === 'jean' || next === 'path') onValueChange(next)
      }}
      className="w-full gap-3"
    >
      <Label
        htmlFor={`${sourceId}-source-jean`}
        className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
      >
        <RadioGroupItem id={`${sourceId}-source-jean`} value="jean" />
        <span>
          <span className="block text-sm font-medium">Jean managed</span>
          <span className="block text-xs leading-relaxed text-muted-foreground">
            {managedDescription ??
              `Jean installs and updates an isolated ${backendName} version.`}
          </span>
        </span>
      </Label>
      <Label
        htmlFor={`${sourceId}-source-path`}
        className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
      >
        <RadioGroupItem
          id={`${sourceId}-source-path`}
          value="path"
          disabled={!pathFound}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">System PATH</span>
          <span className="block break-all text-xs leading-relaxed text-muted-foreground">
            {pathFound
              ? `${path ?? `${backendName} on PATH`}${pathVersion ? ` · ${pathVersion}` : ''}`
              : `No ${backendName} was found on PATH.`}
          </span>
        </span>
      </Label>
    </RadioGroup>
  )
}
