import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/store/ui-store'
import { usePreferences } from '@/services/preferences'
import {
  useClaudeCliAuth,
  useClaudeCliStatus,
  useClaudeUsage,
} from '@/services/claude-cli'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
import {
  useGrokCliAuth,
  useGrokCliStatus,
  useGrokUsage,
} from '@/services/grok-cli'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import type { CliBackend } from '@/types/preferences'
import {
  formatUsagePair,
  resolveActiveUsageEntry,
  usageSeverityTextClass,
  type UsageEntry,
} from '@/components/chat/toolbar/usage-indicator-utils'

const USAGE_ICONS = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  grok: GrokIcon,
} as const

export interface UsageIndicatorProps {
  /** Session-selected backend — preferred entry when it supports usage. */
  selectedBackend?: CliBackend | string | null
  /**
   * `toolbar` — chat button row next to model/effort/mode.
   * `dock` — floating dock (icon-only until xl, then numbers).
   */
  variant?: 'toolbar' | 'dock'
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
  /** Show keyboard shortcut in tooltip (native desktop only by default). */
  showKeybindingHint?: boolean
  /**
   * When true, only fetch while the dropdown is open (dev default for dock).
   * When false/omit, fetch whenever the indicator mounts (needed for live badge).
   */
  fetchOnlyWhenOpen?: boolean
}

/**
 * Compact Session|Weekly% usage control for Claude / Codex / Grok.
 * In the chat toolbar it sits next to the model picker.
 * Click opens a multi-backend snapshot and links to Preferences → Usage.
 */
export function UsageIndicator({
  selectedBackend,
  variant = 'toolbar',
  side = 'top',
  align = 'start',
  className,
  showKeybindingHint,
  fetchOnlyWhenOpen = false,
}: UsageIndicatorProps) {
  const { data: preferences } = usePreferences()
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const shouldFetch = !fetchOnlyWhenOpen || menuOpen
  const isToolbar = variant === 'toolbar'

  const claudeStatus = useClaudeCliStatus()
  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed || isToolbar,
  })
  // Installed OR already authenticated OR selected in toolbar — keep chip alive.
  const claudeReady =
    !!claudeStatus.data?.installed ||
    !!claudeAuth.data?.authenticated ||
    (isToolbar && selectedBackend === 'claude')
  const claudeUsage = useClaudeUsage({
    enabled: claudeReady && shouldFetch,
  })

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({
    enabled: !!codexStatus.data?.installed || isToolbar,
  })
  const codexReady =
    !!codexStatus.data?.installed ||
    !!codexAuth.data?.authenticated ||
    (isToolbar && selectedBackend === 'codex')
  const codexUsage = useCodexUsage({
    enabled: codexReady && shouldFetch,
  })

  const grokStatus = useGrokCliStatus()
  const grokAuth = useGrokCliAuth({
    enabled: !!grokStatus.data?.installed || isToolbar,
  })
  const grokReady =
    !!grokStatus.data?.installed ||
    !!grokAuth.data?.authenticated ||
    (isToolbar && selectedBackend === 'grok')
  const grokUsage = useGrokUsage({
    enabled: grokReady && shouldFetch,
  })

  const usageEntries: UsageEntry[] = useMemo(() => {
    const rows: UsageEntry[] = [
      {
        id: 'claude',
        label: 'Claude',
        plan: claudeUsage.data?.planType ?? null,
        session: claudeUsage.data?.session?.usedPercent ?? null,
        weekly: claudeUsage.data?.weekly?.usedPercent ?? null,
        available:
          !!claudeStatus.data?.installed || !!claudeAuth.data?.authenticated,
      },
      {
        id: 'codex',
        label: 'Codex',
        plan: codexUsage.data?.planType ?? null,
        session: codexUsage.data?.session?.usedPercent ?? null,
        weekly: codexUsage.data?.weekly?.usedPercent ?? null,
        available:
          !!codexStatus.data?.installed || !!codexAuth.data?.authenticated,
      },
      {
        id: 'grok',
        label: 'Grok',
        plan: grokUsage.data?.planType ?? null,
        session: grokUsage.data?.session?.usedPercent ?? null,
        weekly: grokUsage.data?.weekly?.usedPercent ?? null,
        available:
          !!grokStatus.data?.installed || !!grokAuth.data?.authenticated,
      },
    ]
    return rows.filter(entry => entry.available)
  }, [
    claudeAuth.data?.authenticated,
    claudeStatus.data?.installed,
    claudeUsage.data?.planType,
    claudeUsage.data?.session?.usedPercent,
    claudeUsage.data?.weekly?.usedPercent,
    codexAuth.data?.authenticated,
    codexStatus.data?.installed,
    codexUsage.data?.planType,
    codexUsage.data?.session?.usedPercent,
    codexUsage.data?.weekly?.usedPercent,
    grokAuth.data?.authenticated,
    grokStatus.data?.installed,
    grokUsage.data?.planType,
    grokUsage.data?.session?.usedPercent,
    grokUsage.data?.weekly?.usedPercent,
  ])

  const activeEntry = resolveActiveUsageEntry(usageEntries, selectedBackend, {
    preferSelectedPlaceholder: isToolbar,
  })

  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => !prev)
  }, [])

  useEffect(() => {
    const handler = () => toggleMenu()
    window.addEventListener('toggle-usage-menu', handler)
    return () => window.removeEventListener('toggle-usage-menu', handler)
  }, [toggleMenu])

  const usageShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_usage_dropdown ??
      DEFAULT_KEYBINDINGS.open_usage_dropdown) as string
  )
  const showShortcut =
    showKeybindingHint ?? (isNativeApp() && !isMobile)

  if (!activeEntry) return null

  // Toolbar dropdown: include the active backend even if still loading.
  const menuEntries =
    usageEntries.some(e => e.id === activeEntry.id)
      ? usageEntries
      : [activeEntry, ...usageEntries]

  const ActiveIcon = USAGE_ICONS[activeEntry.id]
  const badgeText = formatUsagePair(activeEntry.session, activeEntry.weekly)
  const severityClass = usageSeverityTextClass(
    activeEntry.session,
    activeEntry.weekly
  )

  return (
    // Wrapper owns responsive visibility so it never fights the trigger's `flex`.
    <div className={cn(className)}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${activeEntry.label} usage ${badgeText}`}
                className={cn(
                  isToolbar
                    ? 'flex h-8 items-center gap-1 px-2 text-xs font-medium transition-colors hover:bg-muted/80 hover:text-foreground'
                    : 'inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground xl:w-[88px] xl:justify-center xl:px-2',
                  severityClass
                )}
              >
                <ActiveIcon
                  className={cn(
                    'shrink-0',
                    isToolbar ? 'h-3.5 w-3.5' : 'size-4 xl:mr-1 xl:size-3.5'
                  )}
                />
                <span
                  className={cn(
                    'tabular-nums leading-none',
                    isToolbar
                      ? 'text-[11px]'
                      : 'hidden text-[11px] xl:inline'
                  )}
                >
                  {badgeText}
                </span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={side}>
            {activeEntry.label} Session|Weekly
            {showShortcut ? (
              <kbd className="ml-1 text-[0.625rem] opacity-60">
                {usageShortcut}
              </kbd>
            ) : null}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side={side}
          align={align}
          className="min-w-[180px]"
          onEscapeKeyDown={e => e.stopPropagation()}
        >
          {menuEntries.map(entry => {
            const Icon = USAGE_ICONS[entry.id]
            const pair = formatUsagePair(entry.session, entry.weekly)
            const planText =
              entry.plan && entry.plan.trim().length > 0 ? entry.plan : '--'
            return (
              <DropdownMenuItem
                key={entry.id}
                onClick={() =>
                  useUIStore.getState().openPreferencesPane('usage')
                }
              >
                <Icon className="mr-2 h-4 w-4 shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span>{entry.label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    Plan: {planText}
                  </span>
                </div>
                <DropdownMenuShortcut
                  className={usageSeverityTextClass(
                    entry.session,
                    entry.weekly
                  )}
                >
                  {pair}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => useUIStore.getState().openPreferencesPane('usage')}
          >
            <BarChart3 className="mr-2 h-4 w-4" />
            Open Usage Details
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
