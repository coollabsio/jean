import type React from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWindowMaximized } from '@/hooks/use-window-maximized'

const getAppWindow = async () => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

const handleMinimize = async () => {
  const appWindow = await getAppWindow()
  await appWindow.minimize()
}

const handleToggleMaximize = async () => {
  const appWindow = await getAppWindow()
  await appWindow.toggleMaximize()
}

const handleClose = async () => {
  const { requestAppQuit } = await import('@/lib/window-close')
  await requestAppQuit()
}

export function LinuxWindowControls() {
  const isMaximized = useWindowMaximized()

  return (
    <div
      className="flex h-8 items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <ControlButton onClick={handleMinimize} aria-label="Minimize">
        <Minus className="size-3.5" />
      </ControlButton>
      <ControlButton
        onClick={handleToggleMaximize}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          <Copy className="size-3 -scale-x-100" />
        ) : (
          <Square className="size-3" />
        )}
      </ControlButton>
      <ControlButton
        onClick={handleClose}
        aria-label="Close"
        className="hover:bg-red-600 hover:text-white"
      >
        <X className="size-3.5" />
      </ControlButton>
    </div>
  )
}

interface ControlButtonProps {
  onClick: () => void
  className?: string
  children: React.ReactNode
  'aria-label': string
}

function ControlButton({
  onClick,
  className,
  children,
  ...rest
}: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      type="button"
      className={cn(
        'flex h-8 w-[46px] items-center justify-center text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export default LinuxWindowControls
