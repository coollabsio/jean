import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  BarChart3,
  Command,
  LayoutDashboard,
  Menu,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
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
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'

interface DockBurgerButtonProps {
  /** Extra classes merged onto the trigger button (e.g. responsive visibility). */
  className?: string
}

function formatUsagePair(
  session: number | null | undefined,
  weekly: number | null | undefined
) {
  const sessionText = session == null ? '--' : `${Math.round(session)}`
  const weeklyText = weekly == null ? '--' : `${Math.round(weekly)}`
  return `${sessionText}|${weeklyText}%`
}

export function DockBurgerButton({
  className,
}: DockBurgerButtonProps = {}) {
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()

  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const claudeStatus = useClaudeCliStatus()
  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed,
  })
  const claudeUsage = useClaudeUsage({
    enabled:
      !!claudeStatus.data?.installed &&
      !!claudeAuth.data?.authenticated &&
      menuOpen,
  })

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({
    enabled: !!codexStatus.data?.installed,
  })
  const codexUsage = useCodexUsage({
    enabled:
      !!codexStatus.data?.installed &&
      !!codexAuth.data?.authenticated &&
      menuOpen,
  })

  const grokStatus = useGrokCliStatus()
  const grokAuth = useGrokCliAuth({
    enabled: !!grokStatus.data?.installed,
  })
  const grokUsage = useGrokUsage({
    enabled:
      !!grokStatus.data?.installed &&
      !!grokAuth.data?.authenticated &&
      menuOpen,
  })

  const claudeAvailable =
    !!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated
  const codexAvailable =
    !!codexStatus.data?.installed && !!codexAuth.data?.authenticated
  const grokAvailable =
    !!grokStatus.data?.installed && !!grokAuth.data?.authenticated

  // Only installed + authenticated backends appear in the usage menu.
  const usageRows = [
    {
      id: 'claude' as const,
      label: 'Claude',
      Icon: ClaudeIcon,
      available: claudeAvailable,
      pair: formatUsagePair(
        claudeUsage.data?.session?.usedPercent,
        claudeUsage.data?.weekly?.usedPercent
      ),
    },
    {
      id: 'codex' as const,
      label: 'Codex',
      Icon: CodexIcon,
      available: codexAvailable,
      pair: formatUsagePair(
        codexUsage.data?.session?.usedPercent,
        codexUsage.data?.weekly?.usedPercent
      ),
    },
    {
      id: 'grok' as const,
      label: 'Grok',
      Icon: GrokIcon,
      available: grokAvailable,
      pair: formatUsagePair(
        grokUsage.data?.session?.usedPercent,
        grokUsage.data?.weekly?.usedPercent
      ),
    },
  ].filter(row => row.available)

  const showUsageSection = usageRows.length > 0

  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => !prev)
  }, [])

  // Global shortcut — only respond when this instance is the visible variant.
  // Both desktop + mobile burgers mount; CSS (`hidden`/`@xl:hidden`) hides one.
  // `offsetParent === null` is true for `display: none`, so the hidden variant skips.
  useEffect(() => {
    const handler = () => {
      if (!triggerRef.current || triggerRef.current.offsetParent === null)
        return
      toggleMenu()
    }
    window.addEventListener('toggle-quick-menu', handler)
    return () => window.removeEventListener('toggle-quick-menu', handler)
  }, [toggleMenu])

  const githubShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_github_dashboard ??
      DEFAULT_KEYBINDINGS.open_github_dashboard) as string
  )
  const menuShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_quick_menu ??
      DEFAULT_KEYBINDINGS.open_quick_menu) as string
  )

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Menu (${menuShortcut})`}
              className={cn(
                'flex h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground',
                className
              )}
            >
              <Menu className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Menu ({menuShortcut})</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        className="min-w-[240px]"
        onEscapeKeyDown={e => e.stopPropagation()}
      >
        <DropdownMenuItem
          onClick={() =>
            useProjectsStore.getState().setAddProjectDialogOpen(true)
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Project
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
          }
        >
          <Archive className="mr-2 h-4 w-4" />
          Archives
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
        >
          <Command className="mr-2 h-4 w-4" />
          Command Palette
          {!isMobile && <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useUIStore.getState().setGitHubDashboardOpen(true)}
        >
          <LayoutDashboard className="mr-2 h-4 w-4" />
          GitHub Dashboard
          {!isMobile && (
            <DropdownMenuShortcut>{githubShortcut}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>

        {showUsageSection && (
          <>
            <DropdownMenuSeparator />
            {usageRows.map(row => (
              <DropdownMenuItem
                key={row.id}
                onClick={() =>
                  useUIStore.getState().openPreferencesPane('usage')
                }
              >
                <row.Icon className="mr-2 h-4 w-4 shrink-0" />
                {row.label}
                <DropdownMenuShortcut>{row.pair}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => useUIStore.getState().openPreferencesPane('usage')}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              Open Usage Details
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
