import { ChevronsUpDown, Zap } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  getModelFastInfo,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableCursorModels } from '@/services/cursor-cli'
import { useAvailablePiModels } from '@/services/pi-cli'
import { useAvailableCommandCodeModels } from '@/services/commandcode-cli'
import { useAvailableGrokModels } from '@/services/grok-cli'
import { useAvailableKimiModels } from '@/services/kimi-cli'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { BackendLabel } from '@/components/ui/backend-label'
import { BackendModelPickerContent } from '@/components/chat/toolbar/BackendModelPickerContent'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
  formatPiModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'
import { useToolbarDropdownShortcuts } from '@/components/chat/toolbar/useToolbarDropdownShortcuts'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'

interface DesktopBackendModelPickerProps {
  disabled?: boolean
  sessionHasMessages?: boolean
  providerLocked?: boolean
  triggerClassName?: string
  selectedBackend: CliBackend
  selectedModel: string
  selectedProvider: string | null
  installedBackends: CliBackend[]
  customCliProfiles: CustomCliProfile[]
  onModelChange: (model: string) => void
  onBackendModelChange: (backend: CliBackend, model: string) => void
}

export function DesktopBackendModelPicker({
  disabled = false,
  sessionHasMessages,
  providerLocked,
  triggerClassName,
  selectedBackend,
  selectedModel,
  selectedProvider,
  installedBackends,
  customCliProfiles,
  onModelChange,
  onBackendModelChange,
}: DesktopBackendModelPickerProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  // Keyboard-only affordances (Tab shortcut hint + handler) are native-desktop only
  const keyboardShortcutsEnabled = isNativeApp() && !isMobile

  useToolbarDropdownShortcuts({
    setModelDropdownOpen: setOpen,
    enabled: keyboardShortcutsEnabled,
  })

  const { data: availableOpencodeModels, isError: opencodeModelsError } =
    useAvailableOpencodeModels({
      enabled: installedBackends.includes('opencode'),
    })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: installedBackends.includes('cursor'),
  })
  const { data: availablePiModels } = useAvailablePiModels({
    enabled: installedBackends.includes('pi'),
  })
  const { data: availableCommandCodeModels } = useAvailableCommandCodeModels({
    enabled: installedBackends.includes('commandcode'),
  })
  const { data: availableGrokModels } = useAvailableGrokModels({
    enabled: installedBackends.includes('grok'),
  })
  const { data: availableKimiModels } = useAvailableKimiModels({
    enabled: installedBackends.includes('kimi'),
  })

  const opencodeModelOptions = useMemo(() => {
    if (opencodeModelsError) return []
    return availableOpencodeModels?.map(model => ({
      value: model,
      label: formatOpencodeModelLabel(model),
    }))
  }, [availableOpencodeModels, opencodeModelsError])
  const cursorModelOptions = useMemo(
    () =>
      availableCursorModels?.length
        ? availableCursorModels.map(model => ({
            value: `cursor/${model.id}`,
            label: model.label || formatCursorModelLabel(model.id),
          }))
        : undefined,
    [availableCursorModels]
  )
  const piModelOptions = useMemo(
    () =>
      availablePiModels?.map(model => ({
        value: `pi/${model.id}`,
        label: model.label || formatPiModelLabel(model.id),
        is_default: model.is_default,
      })),
    [availablePiModels]
  )
  const commandcodeModelOptions = useMemo(
    () =>
      availableCommandCodeModels?.map(model => ({
        value: `commandcode/${model.id}`,
        label: model.label,
      })),
    [availableCommandCodeModels]
  )
  const grokModelOptions = useMemo(
    () =>
      availableGrokModels?.map(model => ({
        value: `grok/${model.id}`,
        label: model.label,
      })),
    [availableGrokModels]
  )
  const kimiModelOptions = useMemo(
    () =>
      availableKimiModels?.map(model => ({
        value: `kimi/${model.id}`,
        label: model.label,
      })),
    [availableKimiModels]
  )

  const { backendModelSections, selectedModelLabel } = useToolbarDerivedState({
    selectedBackend,
    selectedProvider,
    selectedModel,
    opencodeModelOptions,
    cursorModelOptions,
    piModelOptions,
    commandcodeModelOptions,
    grokModelOptions,
    kimiModelOptions,
    customCliProfiles,
    installedBackends,
  })

  const selectableChoiceCount = useMemo(
    () =>
      backendModelSections
        .filter(section => installedBackends.includes(section.backend))
        .reduce((count, section) => count + section.options.length, 0),
    [backendModelSections, installedBackends]
  )
  const hasMultipleChoices = selectableChoiceCount > 1

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Choose backend and model"
              className={cn(
                'hidden @xl:flex h-8 max-w-[22rem] shrink-0 items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                triggerClassName
              )}
            >
              <span className="min-w-0 flex items-center gap-1.5">
                <BackendLabel
                  backend={selectedBackend}
                  className="shrink-0"
                  badgeClassName="text-[9px] leading-3"
                />
                <span className="truncate">· {selectedModelLabel}</span>
                {getModelFastInfo(selectedBackend, selectedModel).isFast && (
                  <Zap
                    className="h-3 w-3 shrink-0 fill-current text-yellow-500"
                    aria-label="Fast mode"
                  />
                )}
              </span>
              {keyboardShortcutsEnabled && installedBackends.length > 1 && (
                <Kbd className="ml-1 hidden 2xl:inline-flex text-[10px]">
                  Tab
                </Kbd>
              )}
              {hasMultipleChoices && (
                <ChevronsUpDown
                  className="h-3.5 w-3.5 shrink-0 opacity-50"
                  data-testid="backend-model-picker-chevron"
                />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {keyboardShortcutsEnabled
            ? installedBackends.length > 1
              ? 'Backend + model (⌘⇧M) · Tab cycles backend'
              : 'Backend + model (⌘⇧M)'
            : 'Backend + model'}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[min(36rem,calc(100vw-4rem))] p-0"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
          }
        }}
      >
        <BackendModelPickerContent
          open={open}
          selectedBackend={selectedBackend}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          installedBackends={installedBackends}
          customCliProfiles={customCliProfiles}
          sessionHasMessages={sessionHasMessages}
          providerLocked={providerLocked}
          onModelChange={onModelChange}
          onBackendModelChange={onBackendModelChange}
          onRequestClose={() => handleOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
