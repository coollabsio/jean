import type React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { isClientLinux, isClientMacOS, openExternal } from '@/lib/platform'
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
  Download,
  Github,
  Heart,
  PanelLeft,
  PanelLeftClose,
  Settings,
  X,
} from 'lucide-react'
import { usePreferences } from '@/services/preferences'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { CLI_DISPLAY_NAMES, resolveCliPathUpdateAction } from '@/lib/cli-update'
import type { PendingCliUpdate } from '@/store/ui-store'
import { toast } from 'sonner'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import { isNativeApp } from '@/lib/environment'
import { UnreadBell } from '@/components/unread/UnreadBell'
import { useIsMobile } from '@/hooks/use-mobile'
import { FALLBACK_APP_VERSION } from '@/lib/app-version'
import { applyServerUpdate } from '@/hooks/useServerUpdateCheck'
import { LinuxWindowControls } from './LinuxWindowControls'
import { RemoteConnectionsDialog } from '@/components/remote/RemoteConnectionsDialog'

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
        'bg-background/80 md:px-2',
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
            'relative z-10 flex items-center gap-1 pt-1',
            native && isClientMacOS ? 'pl-[80px]' : 'pl-2'
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
                  <PanelLeftClose className="size-3.5" />
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
                onClick={commandContext.openPreferences}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
              >
                <Settings className="size-3.5" />
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
                  <Github className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub</TooltipContent>
            </Tooltip>
          )}
          {native && <RemoteConnectionsDialog />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => openExternal('https://jean.build/sponsorships/')}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-none text-pink-500 hover:text-pink-400"
              >
                <Heart className="size-3.5" />
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
        className={cn('flex items-center pt-1', isMobile && 'pr-2')}
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
        <CliUpdatesIndicator />
        <ServerUpdateIndicator />
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
        {native && isClientLinux && <LinuxWindowControls />}
      </div>
    </div>
  )
}

function CliUpdatesIndicator() {
  const updates = useUIStore(state => state.availableCliUpdates)
  const dismissCliUpdateNotice = useUIStore(
    state => state.dismissCliUpdateNotice
  )
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const [open, setOpen] = useState(false)

  const triggerUpdate = useCallback(
    (update: PendingCliUpdate) => {
      if (update.cliSource === 'path') {
        const action = resolveCliPathUpdateAction(
          update.type,
          update.cliPath,
          update.packageManager,
          update.latestVersion
        )
        if (action) {
          openCliLoginModal(update.type, action[0], action[1], 'update')
        } else {
          toast.error(
            `Can't auto-update ${CLI_DISPLAY_NAMES[update.type]}. Update it manually via your package manager.`
          )
          return
        }
      } else {
        openCliUpdateModal(update.type)
      }
      dismissCliUpdateNotice(update.type)
    },
    [dismissCliUpdateNotice, openCliUpdateModal, openCliLoginModal]
  )

  // Auto-close popover when all updates have been acted on / dismissed
  useEffect(() => {
    if (updates.length === 0) setOpen(false)
  }, [updates.length])

  if (updates.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button className="relative mr-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary hover:bg-primary/25 transition-colors cursor-pointer">
              <Download className="size-3" />
              <span>{updates.length}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {updates.length} CLI update{updates.length > 1 ? 's' : ''} available
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="divide-y">
          {updates.map(update => (
            <div
              key={update.type}
              className="flex items-center justify-between px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">
                  {CLI_DISPLAY_NAMES[update.type]}
                </p>
                <p className="text-[0.625rem] text-muted-foreground">
                  v{update.currentVersion} → v{update.latestVersion}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <button
                  onClick={() => triggerUpdate(update)}
                  className="rounded px-2 py-0.5 text-[0.625rem] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Update
                </button>
                <button
                  onClick={() => dismissCliUpdateNotice(update.type)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                >
                  <X className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ServerUpdateIndicator() {
  const pending = useUIStore(state => state.pendingServerUpdate)
  if (!pending) return null

  const handleClick = () => {
    if (!pending.canUpdate) {
      toast.info(`jean-server ${pending.latestVersion} is available`, {
        id: 'server-update-available',
        description:
          pending.reason ||
          'This host cannot self-update. Replace the binary or image manually.',
        duration: 12_000,
      })
      return
    }
    void applyServerUpdate(pending.latestVersion)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleClick}
          className="mr-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary hover:bg-primary/25 transition-colors cursor-pointer"
        >
          <ArrowUpCircle className="size-3.5" />
          Server update
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {pending.canUpdate
          ? `Update jean-server to v${pending.latestVersion} (currently v${pending.currentVersion})`
          : `jean-server v${pending.latestVersion} available — ${pending.reason || 'manual update required'}`}
      </TooltipContent>
    </Tooltip>
  )
}

function UpdateIndicator() {
  const pendingVersion = useUIStore(state => state.pendingUpdateVersion)
  const readyVersion = useUIStore(state => state.updateReadyVersion)
  const isInstalling = useUIStore(state => state.isUpdateInstalling)

  // Ready takes priority; also show while deferred or mid-download so the user
  // keeps a visible affordance after dismissing the modal.
  const version = readyVersion ?? pendingVersion
  if (!version && !isInstalling) return null

  const label = readyVersion
    ? 'Restart to update'
    : isInstalling
      ? 'Updating…'
      : 'Update available'
  const tooltip = readyVersion
    ? `Restart to apply v${readyVersion}`
    : isInstalling
      ? version
        ? `Downloading v${version}…`
        : 'Downloading update…'
      : `Update to v${version}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => {
            if (isInstalling && !readyVersion) return
            window.dispatchEvent(new Event('install-pending-update'))
          }}
          disabled={isInstalling && !readyVersion}
          className="mr-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary hover:bg-primary/25 transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-default"
        >
          <ArrowUpCircle className="size-3.5" />
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export default TitleBar
