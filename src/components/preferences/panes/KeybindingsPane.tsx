import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { cn } from '@/lib/utils'
import { KeyRecorder } from '../KeyRecorder'
import { SettingsSection } from '../SettingsSection'
import {
  KEYBINDING_DEFINITIONS,
  DEFAULT_KEYBINDINGS,
  type KeybindingAction,
  type KeybindingDefinition,
} from '@/types/keybindings'

const KEYBINDING_HIGHLIGHT_DURATION_MS = 1800

export function getKeybindingRowId(action: KeybindingAction): string {
  return `settings-keybinding-${action}`
}

const KeybindingRow: React.FC<{
  definition: KeybindingDefinition
  value: string
  onChange: (action: KeybindingAction, shortcut: string) => void
  checkConflict: (shortcut: string) => string | null
  disabled: boolean
  rowId?: string
  highlighted?: boolean
}> = ({
  definition,
  value,
  onChange,
  checkConflict,
  disabled,
  rowId,
  highlighted = false,
}) => (
  <div
    id={rowId}
    data-settings-target={definition.action}
    className={cn(
      'grid gap-3 rounded-lg border border-border bg-background p-3 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
      highlighted ? 'bg-accent/60 ring-1 ring-inset ring-border' : ''
    )}
  >
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-sm text-foreground">{definition.label}</Label>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {categoryTitles[definition.category] ?? definition.category}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{definition.description}</p>
    </div>
    <KeyRecorder
      value={value}
      defaultValue={definition.default_shortcut}
      onChange={shortcut => onChange(definition.action, shortcut)}
      checkConflict={checkConflict}
      disabled={disabled}
    />
  </div>
)

const categoryTitles: Record<string, string> = {
  chat: 'Chat',
  navigation: 'Navigation',
  git: 'Git',
  terminal: 'Terminal',
}

const categoryOrder = ['chat', 'navigation', 'git', 'terminal']

interface KeybindingsPaneProps {
  searchTargetAction?: KeybindingAction | null
}

export const KeybindingsPane: React.FC<KeybindingsPaneProps> = ({
  searchTargetAction = null,
}) => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [highlightedAction, setHighlightedAction] =
    useState<KeybindingAction | null>(null)
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const keybindings = preferences?.keybindings ?? DEFAULT_KEYBINDINGS

  const sortedBindings = useMemo(() => {
    return [...KEYBINDING_DEFINITIONS].sort((a, b) => {
      const categoryDelta =
        categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category)
      if (categoryDelta !== 0) return categoryDelta
      return a.label.localeCompare(b.label)
    })
  }, [])

  // Find conflicts for a given action and shortcut
  const findConflict = useCallback(
    (action: string, shortcut: string): string | null => {
      if (!shortcut) return null

      for (const [otherAction, otherShortcut] of Object.entries(keybindings)) {
        if (otherAction !== action && otherShortcut === shortcut) {
          const def = KEYBINDING_DEFINITIONS.find(d => d.action === otherAction)
          return def ? `Already used by "${def.label}"` : 'Already in use'
        }
      }
      return null
    },
    [keybindings]
  )

  const handleChange = useCallback(
    (action: KeybindingAction, shortcut: string) => {
      if (!preferences) return

      // Check for conflicts before saving
      const conflict = findConflict(action, shortcut)
      if (conflict) {
        // Don't save if there's a conflict
        return
      }

      patchPreferences.mutate({
        keybindings: {
          ...keybindings,
          [action]: shortcut,
        },
      })
    },
    [preferences, keybindings, patchPreferences, findConflict]
  )

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!searchTargetAction) return

    const targetId = getKeybindingRowId(searchTargetAction)
    const target = document.getElementById(targetId)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    setHighlightedAction(searchTargetAction)
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedAction(current =>
        current === searchTargetAction ? null : current
      )
      highlightTimeoutRef.current = null
    }, KEYBINDING_HIGHLIGHT_DURATION_MS)
  }, [searchTargetAction])

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Keybindings"
        anchorId="pref-keybindings-section-keybindings"
      >
        <div className="grid gap-2 xl:grid-cols-2">
          {sortedBindings.map(def => (
            <KeybindingRow
              key={def.action}
              definition={def}
              value={keybindings[def.action] ?? def.default_shortcut}
              onChange={handleChange}
              checkConflict={(shortcut: string) =>
                findConflict(def.action, shortcut)
              }
              disabled={patchPreferences.isPending}
              rowId={getKeybindingRowId(def.action)}
              highlighted={highlightedAction === def.action}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}
