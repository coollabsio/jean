import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { RotateCcw } from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatShortcutDisplay,
  eventToShortcutString,
  type ShortcutString,
} from '@/types/keybindings'

// Format currently held modifiers for display
function formatModifiersDisplay(modifiers: {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}): string {
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
  const isWeb =
    typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
  const useMacCtrl = isMac && isWeb

  const parts: string[] = []
  if (modifiers.meta || modifiers.ctrl)
    parts.push(useMacCtrl ? '⌃' : isMac ? '⌘' : 'Ctrl')
  if (modifiers.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (modifiers.alt) parts.push(isMac ? '⌥' : 'Alt')

  if (parts.length === 0) return 'Press keys...'
  return parts.join(' + ') + ' + ...'
}

interface KeyRecorderProps {
  value: ShortcutString
  defaultValue: ShortcutString
  onChange: (shortcut: ShortcutString) => void
  checkConflict: (shortcut: string) => string | null
  disabled?: boolean
}

export const KeyRecorder: React.FC<KeyRecorderProps> = ({
  value,
  defaultValue,
  onChange,
  checkConflict,
  disabled,
}) => {
  const [isRecording, setIsRecording] = useState(false)
  const [heldModifiers, setHeldModifiers] = useState({
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
  })
  // Track pending shortcut that has a conflict (shown but not saved)
  const [pendingConflict, setPendingConflict] = useState<{
    shortcut: string
    message: string
  } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return

      e.preventDefault()
      e.stopPropagation()

      // Update held modifiers for display
      setHeldModifiers({
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      })

      // ESC to cancel recording
      if (e.key === 'Escape') {
        setIsRecording(false)
        setHeldModifiers({ meta: false, ctrl: false, shift: false, alt: false })
        setPendingConflict(null)
        return
      }

      // Backspace to clear
      if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey) {
        onChange('')
        setIsRecording(false)
        setHeldModifiers({ meta: false, ctrl: false, shift: false, alt: false })
        setPendingConflict(null)
        return
      }

      const shortcut = eventToShortcutString(e)
      if (shortcut) {
        // Check for conflict before accepting
        const conflict = checkConflict(shortcut)
        if (conflict) {
          // Show the conflict but don't save
          setPendingConflict({ shortcut, message: conflict })
          setIsRecording(false)
          setHeldModifiers({
            meta: false,
            ctrl: false,
            shift: false,
            alt: false,
          })
        } else {
          // No conflict, save it
          onChange(shortcut)
          setIsRecording(false)
          setHeldModifiers({
            meta: false,
            ctrl: false,
            shift: false,
            alt: false,
          })
          setPendingConflict(null)
        }
      }
    },
    [isRecording, onChange, checkConflict]
  )

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return

      // Update held modifiers when keys are released
      setHeldModifiers({
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      })
    },
    [isRecording]
  )

  useEffect(() => {
    if (isRecording) {
      document.addEventListener('keydown', handleKeyDown, true)
      document.addEventListener('keyup', handleKeyUp, true)
      return () => {
        document.removeEventListener('keydown', handleKeyDown, true)
        document.removeEventListener('keyup', handleKeyUp, true)
      }
    }
  }, [isRecording, handleKeyDown, handleKeyUp])

  // Click outside to cancel recording
  useEffect(() => {
    if (!isRecording) return

    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setIsRecording(false)
        setHeldModifiers({ meta: false, ctrl: false, shift: false, alt: false })
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isRecording])

  const handleClick = () => {
    if (!disabled) {
      setIsRecording(true)
      setHeldModifiers({ meta: false, ctrl: false, shift: false, alt: false })
      setPendingConflict(null)
    }
  }

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(defaultValue)
    setPendingConflict(null)
  }

  const isModified = value !== defaultValue

  // Check for existing conflict on current value
  const existingConflict = checkConflict(value)

  // Show pending conflict shortcut if there is one, otherwise show current value
  let displayText: string
  if (isRecording) {
    displayText = formatModifiersDisplay(heldModifiers)
  } else if (pendingConflict) {
    displayText = formatShortcutDisplay(pendingConflict.shortcut)
  } else if (value) {
    displayText = formatShortcutDisplay(value)
  } else {
    displayText = 'Not set'
  }

  // Show pending conflict message, or existing conflict message
  const conflictMessage = pendingConflict?.message ?? existingConflict
  const hasConflict = !!conflictMessage

  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={buttonRef}
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          'min-w-24 px-2 py-0 text-xs font-mono rounded border transition-colors',
          'bg-background hover:bg-accent',
          isRecording && 'ring-2 ring-primary border-primary bg-accent',
          hasConflict && 'border-destructive',
          pendingConflict && 'text-destructive',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        {displayText}
      </button>

      {(isModified || pendingConflict) && !isRecording && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={handleReset}
              disabled={disabled}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset to default</TooltipContent>
        </Tooltip>
      )}

      {hasConflict && !isRecording && (
        <span className="text-xs text-destructive">{conflictMessage}</span>
      )}
    </div>
  )
}
