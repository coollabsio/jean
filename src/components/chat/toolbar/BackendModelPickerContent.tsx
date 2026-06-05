import { Check, Star, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/kbd'
import {
  getModelFastInfo,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableCursorModels } from '@/services/cursor-cli'
import { cn } from '@/lib/utils'
import {
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
  getProviderDisplayName,
} from '@/components/chat/toolbar/toolbar-utils'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'
import { useIsMobile } from '@/hooks/use-mobile'

interface BackendModelPickerContentProps {
  open: boolean
  selectedBackend: CliBackend
  selectedModel: string
  selectedProvider: string | null
  installedBackends: CliBackend[]
  customCliProfiles: CustomCliProfile[]
  sessionHasMessages?: boolean
  providerLocked?: boolean
  onModelChange: (model: string) => void
  onBackendModelChange: (backend: CliBackend, model: string) => void
  onRequestClose: () => void
  searchPlaceholder?: string
  className?: string
  commandListClassName?: string
}

export function BackendModelPickerContent({
  open,
  selectedBackend,
  selectedModel,
  selectedProvider,
  installedBackends,
  customCliProfiles,
  providerLocked,
  onModelChange,
  onBackendModelChange,
  onRequestClose,
  searchPlaceholder,
  className,
  commandListClassName,
}: BackendModelPickerContentProps) {
  const [search, setSearch] = useState('')
  const [activeBackend, setActiveBackend] =
    useState<CliBackend>(selectedBackend)
  const [highlightedValue, setHighlightedValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useIsMobile()
  const isApplePlatform =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  const fastShortcutLabel = isApplePlatform ? '⌘F' : 'Ctrl F'

  const isLocked = false

  const { data: prefs } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const favoriteModels = useMemo(
    () => prefs?.favorite_models ?? [],
    [prefs?.favorite_models]
  )
  const favoriteSet = useMemo(() => new Set(favoriteModels), [favoriteModels])
  const favKey = useCallback(
    (backend: CliBackend, model: string) => `${backend}:${model}`,
    []
  )
  const handleToggleFavorite = useCallback(
    (backend: CliBackend, model: string) => {
      const key = favKey(backend, model)
      const next = favoriteSet.has(key)
        ? favoriteModels.filter(k => k !== key)
        : [...favoriteModels, key]
      patchPreferences.mutate({ favorite_models: next })
    },
    [favKey, favoriteSet, favoriteModels, patchPreferences]
  )

  const fastModels = useMemo(
    () => prefs?.fast_mode_models ?? [],
    [prefs?.fast_mode_models]
  )
  const fastSet = useMemo(() => new Set(fastModels), [fastModels])
  const isFastRemembered = useCallback(
    (backend: CliBackend, baseModel: string) =>
      fastSet.has(favKey(backend, baseModel)),
    [fastSet, favKey]
  )
  const setFastRemembered = useCallback(
    (backend: CliBackend, baseModel: string, on: boolean) => {
      const key = favKey(backend, baseModel)
      if (on === fastSet.has(key)) return
      const next = on ? [...fastModels, key] : fastModels.filter(k => k !== key)
      patchPreferences.mutate({ fast_mode_models: next })
    },
    [favKey, fastSet, fastModels, patchPreferences]
  )

  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: installedBackends.includes('opencode'),
  })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: installedBackends.includes('cursor'),
  })

  const opencodeModelOptions = useMemo(
    () =>
      availableOpencodeModels?.map(model => ({
        value: model,
        label: formatOpencodeModelLabel(model),
      })),
    [availableOpencodeModels]
  )
  const cursorModelOptions = useMemo(
    () =>
      availableCursorModels?.map(model => ({
        value: `cursor/${model.id}`,
        label: model.label || formatCursorModelLabel(model.id),
      })),
    [availableCursorModels]
  )

  const { backendModelSections } = useToolbarDerivedState({
    selectedBackend,
    selectedProvider,
    selectedModel,
    opencodeModelOptions,
    cursorModelOptions,
    customCliProfiles,
    installedBackends,
  })

  const sidebarBackends = useMemo(
    () =>
      backendModelSections
        .filter(section => installedBackends.includes(section.backend))
        .map(section => section.backend),
    [backendModelSections, installedBackends]
  )

  const showSidebar = sidebarBackends.length > 1

  // Sync active backend when picker opens
  useEffect(() => {
    if (!open) return
    setActiveBackend(prev =>
      sidebarBackends.includes(prev) ? prev : selectedBackend
    )
  }, [open, selectedBackend, sidebarBackends])

  // Reset search whenever active backend changes or picker opens
  useEffect(() => {
    setSearch('')
  }, [activeBackend, open])

  const activeSection = useMemo(
    () =>
      backendModelSections.find(section => section.backend === activeBackend),
    [backendModelSections, activeBackend]
  )

  const filteredOptions = useMemo(() => {
    if (!activeSection) return []
    const query = search.trim().toLowerCase()
    const filtered = !query
      ? activeSection.options
      : activeSection.options.filter(option =>
          `${option.label} ${option.value}`.toLowerCase().includes(query)
        )
    const favs: typeof filtered = []
    const rest: typeof filtered = []
    for (const opt of filtered) {
      if (favoriteSet.has(favKey(activeBackend, opt.value))) favs.push(opt)
      else rest.push(opt)
    }
    return [...favs, ...rest]
  }, [activeBackend, activeSection, favKey, favoriteSet, search])

  const getOptionCommandValue = useCallback(
    (backend: CliBackend, model: string) => `${backend}:${model}`,
    []
  )

  useEffect(() => {
    if (!open) return
    setHighlightedValue(current => {
      const currentStillVisible = filteredOptions.some(
        option => getOptionCommandValue(activeBackend, option.value) === current
      )
      if (currentStillVisible) return current

      const firstOption = filteredOptions[0]
      return firstOption
        ? getOptionCommandValue(activeBackend, firstOption.value)
        : ''
    })
  }, [activeBackend, filteredOptions, getOptionCommandValue, open])

  const highlightedOption = useMemo(
    () =>
      filteredOptions.find(
        option =>
          getOptionCommandValue(activeBackend, option.value) ===
          highlightedValue
      ) ?? filteredOptions[0],
    [activeBackend, filteredOptions, getOptionCommandValue, highlightedValue]
  )

  useEffect(() => {
    if (!open) return
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [open])

  const handleSelect = useCallback(
    (backend: CliBackend, model: string) => {
      // Resolve to fast variant if user previously enabled fast for this base model.
      const info = getModelFastInfo(backend, model)
      const resolved =
        info.supportsFast &&
        !info.isFast &&
        info.fastModel &&
        isFastRemembered(backend, info.baseModel)
          ? info.fastModel
          : model
      if (backend === selectedBackend) {
        onModelChange(resolved)
      } else {
        onBackendModelChange(backend, resolved)
      }
      onRequestClose()
    },
    [
      isFastRemembered,
      onBackendModelChange,
      onModelChange,
      onRequestClose,
      selectedBackend,
    ]
  )

  const handleBackendButtonClick = useCallback(
    (backend: CliBackend) => {
      setActiveBackend(backend)
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    },
    []
  )

  const handleUseHighlightedFastMode = useCallback(() => {
    if (!highlightedOption) return false

    const fastInfo = getModelFastInfo(activeBackend, highlightedOption.value)
    if (!fastInfo.supportsFast || !fastInfo.fastModel) return false

    setFastRemembered(activeBackend, fastInfo.baseModel, true)
    if (selectedBackend === activeBackend) {
      onModelChange(fastInfo.fastModel)
    } else {
      onBackendModelChange(activeBackend, fastInfo.fastModel)
    }
    onRequestClose()
    return true
  }, [
    activeBackend,
    highlightedOption,
    onBackendModelChange,
    onModelChange,
    onRequestClose,
    selectedBackend,
    setFastRemembered,
  ])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return

      event.preventDefault()
      event.stopPropagation()
      handleUseHighlightedFastMode()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleUseHighlightedFastMode, open])

  useEffect(() => {
    if (!open || sidebarBackends.length <= 1) return
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.altKey || event.shiftKey) return
      const match = event.code.match(/^Digit([1-9])$/)
      if (!match) return
      const idx = Number(match[1]) - 1
      const backend = sidebarBackends[idx]
      if (!backend) return
      event.preventDefault()
      event.stopPropagation()
      handleBackendButtonClick(backend)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, sidebarBackends, handleBackendButtonClick])

  const showProviderHint =
    Boolean(providerLocked) &&
    isLocked &&
    activeBackend === 'claude' &&
    customCliProfiles.length > 0

  const placeholder =
    searchPlaceholder ??
    `Search ${getBackendPlainLabel(activeBackend)} models...`

  const sidebar = showSidebar ? (
    <SidebarBackends
      orientation={isMobile ? 'horizontal' : 'vertical'}
      backends={sidebarBackends}
      activeBackend={activeBackend}
      selectedBackend={selectedBackend}
      isLocked={isLocked}
      onSelect={handleBackendButtonClick}
    />
  ) : null

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {isMobile && sidebar}
      <div className="flex min-h-0 flex-1">
        {!isMobile && sidebar}
        <Command
          shouldFilter={false}
          value={highlightedValue}
          onValueChange={setHighlightedValue}
          className="flex h-full min-w-0 flex-1 flex-col"
        >
          <div className="border-b p-2">
            <Input
              ref={searchInputRef}
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onRequestClose()
                }
              }}
              placeholder={placeholder}
              className="h-9 text-base md:text-sm"
            />
          </div>

          {showProviderHint && (
            <div className="px-4 pt-2 text-xs text-muted-foreground">
              Provider: {getProviderDisplayName(selectedProvider)}
            </div>
          )}

          <CommandList
            className={cn(
              'max-h-[24rem]',
              showProviderHint && 'pt-1',
              commandListClassName
            )}
          >
            {filteredOptions.length === 0 && (
              <CommandEmpty>No models found.</CommandEmpty>
            )}

            {filteredOptions.map(option => {
              const fastInfo = getModelFastInfo(activeBackend, option.value)
              const supportsFast = Boolean(
                fastInfo.supportsFast && fastInfo.fastModel
              )
              const isSelectedBase =
                selectedBackend === activeBackend &&
                selectedModel === option.value
              const isSelectedFast =
                supportsFast &&
                selectedBackend === activeBackend &&
                selectedModel === fastInfo.fastModel
              const isRowSelected = isSelectedBase || isSelectedFast
              const isFavorite = favoriteSet.has(
                favKey(activeBackend, option.value)
              )

              return (
                <CommandItem
                  key={`${activeBackend}-${option.value}`}
                  value={getOptionCommandValue(activeBackend, option.value)}
                  onSelect={() => handleSelect(activeBackend, option.value)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{option.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {option.value}
                    </div>
                  </div>
                  <div
                    className="ml-2 grid shrink-0 grid-cols-[5.75rem_1.5rem_1rem] items-center gap-2"
                    data-testid={`model-actions-${activeBackend}-${option.value}`}
                  >
                    <div className="flex w-[5.75rem] justify-end">
                      {supportsFast && fastInfo.fastModel && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isSelectedFast}
                              aria-label={
                                isSelectedFast
                                  ? `Disable fast mode for ${option.label}`
                                  : `Enable fast mode for ${option.label}`
                              }
                              onMouseDown={event => event.preventDefault()}
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.preventDefault()
                                event.stopPropagation()
                                const next = isSelectedFast
                                  ? fastInfo.baseModel
                                  : fastInfo.fastModel
                                if (!next) return
                                setFastRemembered(
                                  activeBackend,
                                  fastInfo.baseModel,
                                  !isSelectedFast
                                )
                                if (selectedBackend === activeBackend) {
                                  onModelChange(next)
                                } else {
                                  onBackendModelChange(activeBackend, next)
                                }
                              }}
                              className={cn(
                                'flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                'hover:bg-muted/80 hover:text-foreground'
                              )}
                            >
                              <Zap
                                className={cn(
                                  'h-3 w-3',
                                  isSelectedFast &&
                                    'fill-yellow-500 text-yellow-500'
                                )}
                              />
                              <span>Fast</span>
                              <Kbd className="ml-0.5 h-4 min-w-0 bg-background/70 px-1 text-[9px] normal-case tracking-normal">
                                {fastShortcutLabel}
                              </Kbd>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isSelectedFast
                              ? 'Fast tier on — click to disable'
                              : `Enable fast tier (priority queue) · ${fastShortcutLabel}`}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isFavorite}
                          aria-label={
                            isFavorite
                              ? `Unfavorite ${option.label}`
                              : `Favorite ${option.label}`
                          }
                          onMouseDown={event => event.preventDefault()}
                          onPointerDown={event => event.stopPropagation()}
                          onClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            handleToggleFavorite(activeBackend, option.value)
                          }}
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            'hover:bg-muted/80 hover:text-foreground'
                          )}
                        >
                          <Star
                            className={cn(
                              'h-3.5 w-3.5',
                              isFavorite && 'fill-yellow-500 text-yellow-500'
                            )}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isFavorite
                          ? 'Remove from favourites'
                          : 'Add to favourites'}
                      </TooltipContent>
                    </Tooltip>
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isRowSelected ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </div>
    </div>
  )
}

function SidebarBackends({
  orientation,
  backends,
  activeBackend,
  selectedBackend,
  isLocked,
  onSelect,
}: {
  orientation: 'vertical' | 'horizontal'
  backends: CliBackend[]
  activeBackend: CliBackend
  selectedBackend: CliBackend
  isLocked: boolean
  onSelect: (backend: CliBackend) => void
}) {
  const isVertical = orientation === 'vertical'
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  const modKey = isMac ? '⌘' : '⌃'
  const showHints = isVertical && backends.length > 1

  return (
    <div
      className={cn(
        'flex shrink-0 gap-1 bg-muted/30',
        isVertical ? 'w-12 flex-col border-r p-1.5' : 'flex-row border-b p-1.5'
      )}
      role="tablist"
      aria-orientation={orientation}
    >
      {backends.map((backend, index) => {
        const Icon = getBackendIcon(backend)
        const isActive = backend === activeBackend
        const isDisabled = isLocked && backend !== selectedBackend
        const label = getBackendPlainLabel(backend)
        const showHint = showHints && index < 9

        return (
          <Tooltip key={backend}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={label}
                disabled={isDisabled}
                onClick={() => onSelect(backend)}
                className={cn(
                  'group relative flex w-9 shrink-0 flex-col items-center justify-center rounded-md text-muted-foreground transition-colors',
                  showHint ? 'h-auto gap-0.5 py-1' : 'h-9',
                  'hover:bg-background hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive &&
                    'bg-background text-foreground shadow-sm ring-1 ring-border',
                  isDisabled &&
                    'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {showHint && (
                  <span
                    aria-hidden
                    className={cn(
                      'text-[9px] leading-none tabular-nums',
                      isActive
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/60'
                    )}
                  >
                    {modKey}
                    {index + 1}
                  </span>
                )}
                {backend === 'cursor' && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-yellow-500"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side={isVertical ? 'right' : 'bottom'}>
              {isDisabled ? `${label} (locked)` : label}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
