import type React from 'react'
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { WindowsWindowControls } from './WindowsWindowControls'
import { isMacOS, openExternal } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { useCommandContext } from '@/lib/commands'
import {
  ArrowUpCircle,
  Github,
  Heart,
  PanelLeft,
  PanelLeftClose,
  Settings,
} from 'lucide-react'
import { usePreferences } from '@/services/preferences'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import { isNativeApp } from '@/lib/environment'
import { UnreadBell } from '@/components/unread/UnreadBell'
import { useIsMobile } from '@/hooks/use-mobile'
import { FALLBACK_APP_VERSION } from '@/lib/app-version'

interface TitleBarProps {
  className?: string
  title?: string
  hideTitle?: boolean
}

export function TitleBar({
  className,
  title = 'Jean',
  hideTitle = false,
}: TitleBarProps) {
  const { leftSidebarVisible, toggleLeftSidebar } = useUIStore()
  const commandContext = useCommandContext()
  const { data: preferences } = usePreferences()
  const isMobile = useIsMobile()

  const sidebarShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.toggle_left_sidebar ||
      DEFAULT_KEYBINDINGS.toggle_left_sidebar) as string
  )
  const native = isNativeApp()

  const [appVersion, setAppVersion] = useState<string>(FALLBACK_APP_VERSION)
  useEffect(() => {
    if (!native) return

    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion(FALLBACK_APP_VERSION))
  }, [native])

  return (
    <div
      {...(native ? { 'data-tauri-drag-region': true } : {})}
      className={cn(
        'relative flex h-8 w-full shrink-0 items-center justify-between',
        'bg-background/80 backdrop-blur-md border-b border-border/50 md:px-2',
        native ? 'z-[60]' : 'z-50',
        className
      )}
    >
      {/* Left side - Window Controls + Left Actions */}
      <div
        className="flex items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Left Action Buttons */}
        <div
          className={cn(
            'relative z-10 flex items-center gap-1',
            native && isMacOS ? 'pl-[68px]' : 'pl-2'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleLeftSidebar}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
              >
                {leftSidebarVisible ? (
                  <PanelLeftClose className="h-3 w-3" />
                ) : (
                  <PanelLeft className="h-3 w-3" />
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
                onClick={commandContext.openPreferences}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
              >
                <Settings className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Settings{' '}
              <kbd className="ml-1 text-[0.625rem] opacity-60">
                {formatShortcutDisplay(
                  (preferences?.keybindings?.open_preferences ||
                    DEFAULT_KEYBINDINGS.open_preferences) as string
                )}
              </kbd>
            </TooltipContent>
          </Tooltip>
          {!isMobile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() =>
                    openExternal('https://github.com/coollabsio/jean')
                  }
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
                >
                  <Github className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => openExternal('https://jean.build/sponsorships/')}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-pink-500 hover:text-pink-400"
              >
                <Heart className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sponsor</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Center - Title / Unread indicator */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[50%] px-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <UnreadBell title={title} hideTitle={hideTitle} />
      </div>

      {/* Right side - Version + Windows/Linux window controls */}
      <div
        className={cn('flex items-center', isMobile && 'pr-2')}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isMobile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() =>
                  openExternal('https://github.com/coollabsio/jean')
                }
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
              >
                <Github className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>GitHub</TooltipContent>
          </Tooltip>
        )}
        {appVersion && <UpdateIndicator />}
        {appVersion && (
          <button
            onClick={() =>
              openExternal(
                `https://github.com/coollabsio/jean/releases/tag/v${appVersion}`
              )
            }
            className="px-1.5 text-[0.625rem] text-foreground/40 transition-colors cursor-pointer hover:text-foreground/60"
          >
            v{appVersion}
          </button>
        )}
        {native && !isMacOS && <WindowsWindowControls />}
      </div>
    </div>
  )
}

function UpdateIndicator() {
  const pendingVersion = useUIStore(state => state.pendingUpdateVersion)
  if (!pendingVersion) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() =>
            window.dispatchEvent(new Event('install-pending-update'))
          }
          className="mr-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary hover:bg-primary/25 transition-colors cursor-pointer"
        >
          <ArrowUpCircle className="size-3" />
          Update available
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Update to v{pendingVersion}</TooltipContent>
    </Tooltip>
  )
}

export default TitleBar
