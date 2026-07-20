import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CliBackend, CustomCliProfile } from '@/types/preferences'
import { usePreferences } from '@/services/preferences'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableCursorModels } from '@/services/cursor-cli'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import {
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { Input } from '@/components/ui/input'
import { buildBackendModelSections } from '@/components/chat/toolbar/useToolbarDerivedState'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

export interface ApprovalModelOverride {
  backend: CliBackend
  model: string
}

interface ApprovalModelSubmenuProps {
  onSelect: (override: ApprovalModelOverride) => void
  label?: string
  disabled?: boolean
}

interface ApprovalActionGroupProps {
  title: string
  defaultModelLabel?: string | null
  shortcut?: string
  disabled?: boolean
  separatorBefore?: boolean
  onDefaultSelect: () => void
  onModelSelect: (override: ApprovalModelOverride) => void
}

interface ApprovalActionMenuProps {
  buildDefaultModelLabel?: string | null
  yoloDefaultModelLabel?: string | null
  buildShortcut?: string
  yoloShortcut?: string
  clearContextShortcut?: string
  clearContextBuildShortcut?: string
  worktreeBuildShortcut?: string
  worktreeYoloShortcut?: string
  disabled?: boolean
  onApprove?: () => void
  onApproveYolo?: () => void
  onClearContextApprove?: (override?: ApprovalModelOverride) => void
  onClearContextBuildApprove?: (override?: ApprovalModelOverride) => void
  onWorktreeBuildApprove?: (override?: ApprovalModelOverride) => void
  onWorktreeYoloApprove?: (override?: ApprovalModelOverride) => void
}

function getClaudeModelOptions(
  selectedProvider: string | null | undefined,
  customCliProfiles: CustomCliProfile[]
): { value: string; label: string }[] {
  if (!selectedProvider || selectedProvider === '__anthropic__') {
    return MODEL_OPTIONS
  }

  const profile = customCliProfiles.find(p => p.name === selectedProvider)
  let opusModel: string | undefined
  let sonnetModel: string | undefined
  let haikuModel: string | undefined
  if (profile?.settings_json) {
    try {
      const settings = JSON.parse(profile.settings_json)
      const env = settings?.env
      if (env) {
        opusModel = env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL
        sonnetModel = env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
        haikuModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
      }
    } catch {
      // Ignore invalid profile JSON; fall back to short labels.
    }
  }

  const suffix = (model?: string) => (model ? ` (${model})` : '')
  return [
    { value: 'opus', label: `Opus${suffix(opusModel)}` },
    { value: 'sonnet', label: `Sonnet${suffix(sonnetModel)}` },
    { value: 'haiku', label: `Haiku${suffix(haikuModel)}` },
  ]
}

export function ApprovalModelSubmenu({
  onSelect,
  label = 'Other model…',
  disabled,
}: ApprovalModelSubmenuProps) {
  const { data: preferences } = usePreferences()
  const { installedBackends } = useInstalledBackends()
  const isMobile = useIsMobile()
  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: installedBackends.includes('opencode'),
  })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: installedBackends.includes('cursor'),
  })

  const selectedProvider = preferences?.default_provider ?? null
  const customCliProfiles = preferences?.custom_cli_profiles ?? []
  const claudeModelOptions = useMemo(
    () => getClaudeModelOptions(selectedProvider, customCliProfiles),
    [selectedProvider, customCliProfiles]
  )
  const opencodeModelOptions = useMemo(
    () =>
      availableOpencodeModels?.map(model => ({
        value: model,
        label: formatOpencodeModelLabel(model),
      })) ?? OPENCODE_MODEL_OPTIONS,
    [availableOpencodeModels]
  )
  const cursorModelOptions = useMemo(
    () =>
      availableCursorModels?.length
        ? availableCursorModels.map(model => ({
            value: `cursor/${model.id}`,
            label: model.label || formatCursorModelLabel(model.id),
          }))
        : CURSOR_MODEL_OPTIONS,
    [availableCursorModels]
  )

  const [search, setSearch] = useState('')
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false)
  const sections = useMemo(
    () =>
      buildBackendModelSections({
        installedBackends,
        claudeModelOptions,
        codexModelOptions: CODEX_MODEL_OPTIONS,
        opencodeModelOptions,
        cursorModelOptions,
      }).filter(section => section.options.length > 0),
    [
      installedBackends,
      claudeModelOptions,
      opencodeModelOptions,
      cursorModelOptions,
    ]
  )

  const filteredSections = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sections

    return sections
      .map(section => ({
        ...section,
        options: section.options.filter(option =>
          `${section.label} ${option.label} ${option.value}`
            .toLowerCase()
            .includes(query)
        ),
      }))
      .filter(section => section.options.length > 0)
  }, [search, sections])

  if (sections.length === 0) return null

  if (isMobile) {
    return (
      <>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={event => {
            event.preventDefault()
            setSearch('')
            setMobilePickerOpen(true)
          }}
        >
          {label}
          <ChevronRight className="ml-auto size-4" />
        </DropdownMenuItem>
        <Sheet open={mobilePickerOpen} onOpenChange={setMobilePickerOpen}>
          <SheetContent
            side="bottom"
            className="flex h-[75svh] max-h-[75svh] min-h-0 overflow-hidden rounded-t-xl p-0"
            showCloseButton={false}
          >
            <SheetHeader className="shrink-0 border-b px-4 py-3">
              <SheetTitle className="text-base">
                Select Backend &amp; Model
              </SheetTitle>
              <SheetDescription className="sr-only">
                Search and select the backend and model for this action.
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b p-2">
                <Input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search models..."
                  className="h-9 text-base"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
                {filteredSections.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No models found.
                  </div>
                ) : (
                  filteredSections.map(section => (
                    <section key={section.backend} className="py-1">
                      <h3 className="px-4 py-2 text-xs font-medium text-muted-foreground">
                        {section.label}
                      </h3>
                      <div className="px-2">
                        {section.options.map(option => (
                          <button
                            key={`${section.backend}:${option.value}`}
                            type="button"
                            className="flex min-h-12 w-full items-center rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                            onClick={() => {
                              setMobilePickerOpen(false)
                              onSelect({
                                backend: section.backend,
                                model: option.value,
                              })
                            }}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{option.label}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {option.value}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="max-h-[28rem] min-w-[20rem] overflow-y-auto"
        onFocusOutside={event => event.preventDefault()}
      >
        <div
          className="sticky top-0 z-10 border-b bg-popover p-2"
          onKeyDown={event => event.stopPropagation()}
        >
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search models..."
            className="h-8 text-sm"
          />
        </div>
        {filteredSections.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            No models found.
          </div>
        ) : (
          filteredSections.map((section, sectionIndex) => (
            <div key={section.backend}>
              {sectionIndex > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{section.label}</DropdownMenuLabel>
              {section.options.map(option => (
                <DropdownMenuItem
                  key={`${section.backend}:${option.value}`}
                  onClick={() =>
                    onSelect({ backend: section.backend, model: option.value })
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {option.value}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function ApprovalActionGroup({
  title,
  defaultModelLabel,
  shortcut,
  disabled,
  separatorBefore,
  onDefaultSelect,
  onModelSelect,
}: ApprovalActionGroupProps) {
  return (
    <>
      {separatorBefore && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        {title}
      </DropdownMenuLabel>
      <DropdownMenuItem onClick={onDefaultSelect} disabled={disabled}>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            {defaultModelLabel ?? 'Current default'}
          </span>
          <span className="text-[10px] text-muted-foreground">
            (use default)
          </span>
        </span>
        {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
      </DropdownMenuItem>
      <ApprovalModelSubmenu
        label="Other model…"
        disabled={disabled}
        onSelect={onModelSelect}
      />
    </>
  )
}

function CurrentSessionAction({
  shortcut,
  disabled,
  onSelect,
}: {
  shortcut?: string
  disabled?: boolean
  onSelect?: () => void
}) {
  if (!onSelect) return null

  return (
    <DropdownMenuItem onClick={onSelect} disabled={disabled}>
      Current Session
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
}

export function ApprovalActionMenu({
  buildDefaultModelLabel,
  yoloDefaultModelLabel,
  buildShortcut,
  yoloShortcut,
  clearContextShortcut,
  clearContextBuildShortcut,
  worktreeBuildShortcut,
  worktreeYoloShortcut,
  disabled,
  onApprove,
  onApproveYolo,
  onClearContextApprove,
  onClearContextBuildApprove,
  onWorktreeBuildApprove,
  onWorktreeYoloApprove,
}: ApprovalActionMenuProps) {
  const hasYoloActions =
    !!onApproveYolo || !!onClearContextApprove || !!onWorktreeYoloApprove
  const hasBuildActions =
    !!onApprove || !!onClearContextBuildApprove || !!onWorktreeBuildApprove

  if (!hasYoloActions && !hasBuildActions) return null

  return (
    <>
      {hasYoloActions && (
        <>
          <CurrentSessionAction
            shortcut={yoloShortcut}
            disabled={disabled}
            onSelect={onApproveYolo}
          />
          {onClearContextApprove && (
            <ApprovalActionGroup
              title="New Session"
              defaultModelLabel={yoloDefaultModelLabel}
              shortcut={clearContextShortcut}
              disabled={disabled}
              onDefaultSelect={() => onClearContextApprove()}
              onModelSelect={onClearContextApprove}
            />
          )}
          {onWorktreeYoloApprove && (
            <ApprovalActionGroup
              title="New Worktree"
              defaultModelLabel={yoloDefaultModelLabel}
              separatorBefore={!!onClearContextApprove}
              shortcut={worktreeYoloShortcut}
              disabled={disabled}
              onDefaultSelect={() => onWorktreeYoloApprove()}
              onModelSelect={onWorktreeYoloApprove}
            />
          )}
        </>
      )}
      {hasBuildActions && (
        <>
          {hasYoloActions && <DropdownMenuSeparator />}
          <CurrentSessionAction
            shortcut={buildShortcut}
            disabled={disabled}
            onSelect={onApprove}
          />
          {onClearContextBuildApprove && (
            <ApprovalActionGroup
              title="New Session"
              defaultModelLabel={buildDefaultModelLabel}
              shortcut={clearContextBuildShortcut}
              disabled={disabled}
              onDefaultSelect={() => onClearContextBuildApprove()}
              onModelSelect={onClearContextBuildApprove}
            />
          )}
          {onWorktreeBuildApprove && (
            <ApprovalActionGroup
              title="New Worktree"
              defaultModelLabel={buildDefaultModelLabel}
              separatorBefore={!!onClearContextBuildApprove}
              shortcut={worktreeBuildShortcut}
              disabled={disabled}
              onDefaultSelect={() => onWorktreeBuildApprove()}
              onModelSelect={onWorktreeBuildApprove}
            />
          )}
        </>
      )}
    </>
  )
}
