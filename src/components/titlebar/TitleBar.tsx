import type React from 'react'
import { cn } from '@/lib/utils'
import { isClientLinux, isClientMacOS } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { Badge } from '@/components/ui/badge'
import {
  Minimize2,
  PanelLeft,
  PanelRight,
  Settings,
} from '@/components/icons/reicon'
import { Kbd } from '@/components/ui/kbd'
import { usePreferences } from '@/services/preferences'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import { isNativeApp } from '@/lib/environment'
import { UnreadBell } from '@/components/unread/UnreadBell'
import { useIsMobile } from '@/hooks/use-mobile'
import { LinuxWindowControls } from './LinuxWindowControls'
import { useRemoteConnections } from '@/lib/remote-connections'
import { useProjectsStore } from '@/store/projects-store'
import { resolveHeaderServerLabel } from './server-context'
import { UpdatesIndicator } from './UpdatesIndicator'

// Dark pill that matches the toast surface (card bg + soft border).
const SERVER_BADGE_CLASS = 'border border-border/60 bg-card text-2xs'

interface TitleBarProps {
  className?: string
  title?: string
  hideTitle?: boolean
  /** Width (px) of the left rail + sidebar; the center group is centered over the remaining content area */
  contentInset?: number
}

export function TitleBar({
  className,
  title = 'Jean',
  hideTitle = false,
  contentInset = 0,
}: TitleBarProps) {
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const toggleLeftSidebar = useUIStore(state => state.toggleLeftSidebar)
  const fileBrowserVisible = useUIStore(state => state.fileBrowserVisible)
  const toggleFileBrowser = useUIStore(state => state.toggleFileBrowser)
  const zenMode = useUIStore(state => state.zenMode)
  const toggleZenMode = useUIStore(state => state.toggleZenMode)
  const { data: preferences } = usePreferences()
  const isMobile = useIsMobile()
  /** Mobile zen: single header line in the title bar (name + exit). */
  const mobileZen = zenMode && isMobile

  const sidebarShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.toggle_left_sidebar ||
      DEFAULT_KEYBINDINGS.toggle_left_sidebar) as string
  )
  const settingsShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_preferences ||
      DEFAULT_KEYBINDINGS.open_preferences) as string
  )
  const fileBrowserShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.toggle_file_browser ||
      DEFAULT_KEYBINDINGS.toggle_file_browser) as string
  )
  const native = isNativeApp()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const remoteConnections = useRemoteConnections()
  const serverLabel = resolveHeaderServerLabel(
    selectedProjectId,
    remoteConnections
  )

  return (
    <div
      {...(native ? { 'data-tauri-drag-region': true } : {})}
      className={cn(
        'relative flex h-8 w-full shrink-0 items-center justify-between',
        'bg-transparent md:px-2',
        native ? 'z-[60]' : 'z-50',
        className
      )}
    >
      {/* Desktop: Jean logo in the left corner (macOS native uses this
          corner for the traffic lights) */}
      {!isMobile && !(native && isClientMacOS) && (
        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center pt-1">
          <img
            src="/logo.png"
            alt="Jean"
            width={18}
            height={18}
            className="size-[18px]"
            draggable={false}
          />
        </div>
      )}
      {/* Left side - Window Controls + Left Actions (hidden in zen mode) */}
      <div
        className="flex items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* macOS traffic-light inset even when action buttons are hidden */}
        {zenMode && native && isClientMacOS && (
          <div className="pl-[80px]" aria-hidden />
        )}
        {/* Left Action Buttons */}
        {!zenMode && (
          <div
            className={cn(
              'relative z-10 flex items-center gap-1',
              native && isClientMacOS
                ? 'mac-titlebar-actions'
                : isMobile
                  ? 'pl-2 pt-1'
                  : 'pl-9 pt-1' // Start after the 36px logo
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={toggleLeftSidebar}
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    leftSidebarVisible
                      ? 'Hide Left Sidebar'
                      : 'Show Left Sidebar'
                  }
                  className="rounded-none text-foreground/70 hover:text-foreground"
                >
                  {leftSidebarVisible ? (
                    <PanelRight className="size-3.5" />
                  ) : (
                    <PanelLeft className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {leftSidebarVisible ? 'Hide' : 'Show'} Left Sidebar{' '}
                <kbd className="ml-1 text-[0.625rem] opacity-60">
                  {sidebarShortcut}
                </kbd>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => useUIStore.getState().togglePreferences()}
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open Settings"
                  data-testid="titlebar-settings"
                  className="rounded-none text-foreground/70 hover:text-foreground"
                >
                  <Settings className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Settings{' '}
                <Kbd modHint className="ml-1">
                  {settingsShortcut}
                </Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Center - Title / Unread indicator (inlined left in mobile zen) */}
      {mobileZen ? (
        <div
          className="relative z-10 flex min-w-0 flex-1 items-center pl-3 pr-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="truncate text-sm font-semibold text-foreground">
            {hideTitle ? '' : title}
          </span>
          {native && (
            <Badge variant="subtle" className={cn(SERVER_BADGE_CLASS, 'ml-2')}>
              {serverLabel}
            </Badge>
          )}
        </div>
      ) : (
        <div
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[50%] px-2 pt-1"
          style={
            {
              left: `calc(50% + ${contentInset / 2}px)`,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        >
          <div className="flex items-center gap-2">
            {native && (
              <Badge
                variant="subtle"
                className={SERVER_BADGE_CLASS}
                aria-label={`Current Jean server: ${serverLabel}`}
              >
                {serverLabel}
              </Badge>
            )}
            <UnreadBell title={title} hideTitle={hideTitle} />
          </div>
        </div>
      )}

      {/* Right side - Actions + Windows/Linux window controls (hidden in zen) */}
      <div
        className={cn('flex items-center pt-1', isMobile && 'pr-2')}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {mobileZen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleZenMode}
                variant="ghost"
                size="icon-xs"
                className="rounded-none text-foreground/70 hover:text-foreground"
                aria-label="Exit zen mode"
                data-testid="toggle-zen-mode"
              >
                <Minimize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Exit zen mode{' '}
              <kbd className="ml-1 text-[0.625rem] opacity-60">
                {formatShortcutDisplay(
                  (preferences?.keybindings?.toggle_zen_mode ||
                    DEFAULT_KEYBINDINGS.toggle_zen_mode) as string
                )}
              </kbd>
            </TooltipContent>
          </Tooltip>
        )}
        {!zenMode && (
          <>
            <UpdatesIndicator />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={toggleFileBrowser}
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'rounded-none text-foreground/70 hover:text-foreground',
                    fileBrowserVisible && 'bg-muted/50 text-foreground'
                  )}
                  aria-pressed={fileBrowserVisible}
                  aria-label={
                    fileBrowserVisible
                      ? 'Hide file browser'
                      : 'Show file browser'
                  }
                  data-testid="toggle-file-browser"
                >
                  <PanelRight className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {fileBrowserVisible ? 'Hide' : 'Show'} File Browser{' '}
                <kbd className="ml-1 text-[0.625rem] opacity-60">
                  {fileBrowserShortcut}
                </kbd>
              </TooltipContent>
            </Tooltip>
          </>
        )}
        {native && isClientLinux && <LinuxWindowControls />}
      </div>
    </div>
  )
}

export default TitleBar
