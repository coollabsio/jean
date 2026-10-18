import { Checkbox } from '@/components/ui/checkbox'
import { Check } from '@/components/icons/reicon'
import { BackendLabel, getBackendIcon } from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import { AI_BACKENDS, type AIBackend, type CliFlow } from './cli-setup-flows'

export type BackendDetection = 'ready' | 'found' | null

/** Ready = installed and signed in; Found = on this machine, not signed in. */
export function detectBackend(flow: CliFlow): BackendDetection {
  if (flow.ready) return 'ready'
  if (flow.installed || flow.pathFound) return 'found'
  return null
}

/** Preselect every detected backend; fall back to Claude. */
export function preselectBackends(
  flows: Record<AIBackend, CliFlow>
): AIBackend[] {
  const detected = AI_BACKENDS.filter(b => detectBackend(flows[b]) !== null)
  return detected.length > 0 ? detected : ['claude']
}

interface BackendPickerProps {
  flows: Record<AIBackend, CliFlow>
  selected: AIBackend[]
  onToggle: (backend: AIBackend, checked: boolean) => void
  loading: boolean
}

export function BackendPicker({
  flows,
  selected,
  onToggle,
  loading,
}: BackendPickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {AI_BACKENDS.map(backend => {
        const id = `backend-${backend}`
        const checked = selected.includes(backend)
        const Icon = getBackendIcon(backend)
        const detection = loading ? null : detectBackend(flows[backend])

        return (
          <label
            key={backend}
            htmlFor={id}
            className={cn(
              'relative flex cursor-pointer items-center gap-2.5 rounded-lg border p-3 transition-colors',
              checked
                ? 'border-primary bg-primary/5'
                : 'hover:border-muted-foreground/40 hover:bg-accent/40'
            )}
          >
            <Checkbox
              id={id}
              checked={checked}
              onCheckedChange={value => onToggle(backend, value === true)}
              className="sr-only"
            />
            <Icon className="size-5 shrink-0" />
            <BackendLabel
              backend={backend}
              className="min-w-0 truncate text-sm font-medium"
            />
            {detection === 'ready' && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-success">
                <Check className="size-3.5" />
                Ready
              </span>
            )}
            {detection === 'found' && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                Found
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}
