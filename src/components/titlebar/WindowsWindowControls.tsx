import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useCommandContext } from '@/hooks/use-command-context'
import { executeCommand } from '@/lib/commands'
import { useWindowMaximized } from '@/hooks/use-window-maximized'

export function WindowsWindowControls() {
  const context = useCommandContext()
  const isMaximized = useWindowMaximized()

  const handleMinimize = useCallback(async () => {
    await executeCommand('window-minimize', context)
  }, [context])

  const handleMaximize = useCallback(async () => {
    await executeCommand('window-toggle-maximize', context)
  }, [context])

  const handleClose = useCallback(async () => {
    await executeCommand('window-close', context)
  }, [context])

  return (
    <div
      className="flex items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Minimize */}
      <button
        type="button"
        onClick={handleMinimize}
        className={cn(
          'inline-flex h-8 w-[46px] items-center justify-center',
          'text-foreground/90 hover:bg-foreground/10 active:bg-foreground/15',
          'transition-colors'
        )}
        aria-label="Minimize"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
          <rect width="10" height="1" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        type="button"
        onClick={handleMaximize}
        className={cn(
          'inline-flex h-8 w-[46px] items-center justify-center',
          'text-foreground/90 hover:bg-foreground/10 active:bg-foreground/15',
          'transition-colors'
        )}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          // Restore icon (overlapping rectangles)
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="2" y="3" width="7" height="7" rx="0.5" />
            <path d="M3 3V1.5a.5.5 0 0 1 .5-.5H9.5a.5.5 0 0 1 .5.5V7.5a.5.5 0 0 1-.5.5H8" />
          </svg>
        ) : (
          // Maximize icon (single rectangle)
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        type="button"
        onClick={handleClose}
        className={cn(
          'inline-flex h-8 w-[46px] items-center justify-center',
          'text-foreground/90 hover:bg-[#c42b1c] hover:text-white active:bg-[#b22a1a] active:text-white',
          'transition-colors'
        )}
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M1.41 0L5 3.59L8.59 0L10 1.41L6.41 5L10 8.59L8.59 10L5 6.41L1.41 10L0 8.59L3.59 5L0 1.41z" />
        </svg>
      </button>
    </div>
  )
}
