import { useMemo, useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getBackendIcon } from '@/components/ui/backend-label'
import { useBackendModelSections } from '@/components/chat/toolbar/useBackendModelSections'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { usePreferences } from '@/services/preferences'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import {
  MAX_PROMPT_MODELS,
  MIN_PROMPT_MODELS,
  buildPromptModelGroups,
  togglePromptModel,
  type PromptModelRow,
} from './multi-model-prompt'

type PromptExecutionMode = 'plan' | 'build' | 'yolo'

const EXECUTION_MODES: { value: PromptExecutionMode; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'build', label: 'Build' },
  { value: 'yolo', label: 'Yolo' },
]
const EMPTY_KEYS: string[] = []

interface MultiModelPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}

export function MultiModelPromptDialog({
  open,
  onOpenChange,
  projectId,
}: MultiModelPromptDialogProps) {
  const { data: preferences } = usePreferences()
  const { installedBackends } = useInstalledBackends()
  const sections = useBackendModelSections({
    selectedBackend: installedBackends[0] ?? 'claude',
    selectedProvider: null,
    selectedModel: '',
    installedBackends,
    customCliProfiles: preferences?.custom_cli_profiles ?? [],
  })
  const favoriteKeys = preferences?.favorite_models ?? EMPTY_KEYS
  const groups = useMemo(
    () => buildPromptModelGroups(sections, favoriteKeys),
    [sections, favoriteKeys]
  )
  const rowsByKey = useMemo(
    () =>
      new Map<string, PromptModelRow>(
        groups.flatMap(group => group.rows.map(row => [row.key, row]))
      ),
    [groups]
  )

  const defaultMode = preferences?.default_execution_mode
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<PromptExecutionMode | null>(null)
  const executionMode: PromptExecutionMode =
    mode ??
    (defaultMode === 'plan' || defaultMode === 'yolo' ? defaultMode : 'build')

  const targets = selected.flatMap(key => {
    const row = rowsByKey.get(key)
    return row ? [{ backend: row.backend, model: row.model }] : []
  })
  const canStart =
    prompt.trim().length > 0 && targets.length >= MIN_PROMPT_MODELS
  const atLimit = selected.length >= MAX_PROMPT_MODELS

  const handleStart = () => {
    if (!canStart) return
    const toastId = toast.loading(`Starting ${targets.length} worktrees...`)
    onOpenChange(false)
    useUIStore.getState().setNewWorktreeModalOpen(false)
    setPrompt('')
    setSelected([])
    invoke<{ worktreeIds: string[] }>('start_prompt_on_models', {
      projectId,
      prompt,
      targets,
      executionMode,
    })
      .then(result =>
        toast.success(`Started ${result.worktreeIds.length} worktrees`, {
          id: toastId,
        })
      )
      .catch(error =>
        toast.error(`Failed to prompt multiple models: ${error}`, {
          id: toastId,
        })
      )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-none !rounded-none sm:!w-full sm:!max-w-lg sm:!h-auto sm:!max-h-[85vh] sm:!rounded-lg flex flex-col overflow-hidden"
        // Keep keys away from the New Session modal's quick-action shortcuts.
        onKeyDown={event => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Prompt multiple models</DialogTitle>
          <DialogDescription>
            Each model gets its own new worktree and session with this prompt.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          placeholder="What should the models work on?"
          aria-label="Prompt"
          className="min-h-24 shrink-0"
          autoFocus
        />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Models ({selected.length}/{MAX_PROMPT_MODELS})
          </span>
          <Select
            value={executionMode}
            onValueChange={value => setMode(value as PromptExecutionMode)}
          >
            <SelectTrigger size="sm" aria-label="Execution mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXECUTION_MODES.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border">
          {groups.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">
              No installed backends found.
            </p>
          )}
          {groups.map(group => (
            <div key={group.id}>
              <div className="sticky top-0 bg-muted px-3 py-1 text-2xs uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
              {group.rows.map(row => {
                const checked = selected.includes(row.key)
                const BackendIcon = getBackendIcon(row.backend)
                return (
                  <label
                    key={row.key}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!checked && atLimit}
                      onCheckedChange={() =>
                        setSelected(prev => togglePromptModel(prev, row.key))
                      }
                    />
                    <BackendIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{row.label}</span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={!canStart}>
            Start {targets.length > 0 ? targets.length : ''} worktrees
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
