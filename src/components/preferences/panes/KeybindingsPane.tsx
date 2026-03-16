import React, { useCallback, useMemo } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { KeyRecorder } from '../KeyRecorder'
import {
  KEYBINDING_DEFINITIONS,
  DEFAULT_KEYBINDINGS,
  type KeybindingAction,
  type KeybindingDefinition,
} from '@/types/keybindings'

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-2">
    <div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <Separator className="mt-1" />
    </div>
    {children}
  </div>
)

const KeybindingRow: React.FC<{
  definition: KeybindingDefinition
  value: string
  onChange: (action: KeybindingAction, shortcut: string) => void
  checkConflict: (shortcut: string) => string | null
  disabled: boolean
}> = ({ definition, value, onChange, checkConflict, disabled }) => (
  <div className="flex items-center gap-3">
    <div className="w-48 shrink-0">
      <Label className="text-xs text-foreground">{definition.label}</Label>
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
}

const categoryOrder = ['chat', 'navigation', 'git']

export const KeybindingsPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const keybindings = preferences?.keybindings ?? DEFAULT_KEYBINDINGS

  // Group keybindings by category
  const groupedBindings = useMemo(() => {
    const result: Record<string, KeybindingDefinition[]> = {}
    for (const def of KEYBINDING_DEFINITIONS) {
      const categoryDefs = result[def.category] ?? []
      categoryDefs.push(def)
      result[def.category] = categoryDefs
    }
    return result
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

  return (
    <div className="space-y-4">
      {categoryOrder.map(category => {
        const definitions = groupedBindings[category]
        if (!definitions?.length) return null

        return (
          <SettingsSection
            key={category}
            title={categoryTitles[category] ?? category}
          >
            <div className="space-y-2">
              {definitions.map(def => (
                <KeybindingRow
                  key={def.action}
                  definition={def}
                  value={keybindings[def.action] ?? def.default_shortcut}
                  onChange={handleChange}
                  checkConflict={(shortcut: string) =>
                    findConflict(def.action, shortcut)
                  }
                  disabled={patchPreferences.isPending}
                />
              ))}
            </div>
          </SettingsSection>
        )
      })}
    </div>
  )
}
