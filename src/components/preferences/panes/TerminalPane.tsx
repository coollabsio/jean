import React from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  terminalFontOptions,
  type TerminalFont,
  type TerminalRenderer,
} from '@/types/preferences'
import { InlineField } from '../InlineField'

export const TerminalPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  return (
    <div className="space-y-6">
      <div id="pref-terminal-section-terminal" className="space-y-4">
        <InlineField
          label="Embedded terminal renderer"
          description="Applies to new terminal tabs"
        >
          <Select
            value={preferences?.terminal_renderer ?? 'xterm'}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_renderer: value as TerminalRenderer,
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="xterm">xterm.js (stable)</SelectItem>
              <SelectItem value="ghostty-web">
                Ghostty Web (experimental)
              </SelectItem>
            </SelectContent>
          </Select>
        </InlineField>

        <InlineField
          label="Terminal font"
          description="Applies to all terminal tabs"
        >
          <Select
            value={preferences?.terminal_font ?? 'jetbrains-mono'}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_font: value as TerminalFont,
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {terminalFontOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>

        {(preferences?.terminal_font ?? 'jetbrains-mono') === 'custom' && (
          <InlineField
            label="Custom font family"
            description={
              'A CSS font-family value, e.g. "Fira Code Nerd Font", monospace'
            }
            help="The font must be installed on this machine."
          >
            <Input
              aria-label="Custom terminal font family"
              defaultValue={preferences?.terminal_font_custom ?? ''}
              placeholder='"Fira Code Nerd Font", monospace'
              className="w-full sm:w-80 font-mono text-sm"
              onBlur={event => {
                const value = event.target.value.trim()
                if (value !== (preferences?.terminal_font_custom ?? '')) {
                  patchPreferences.mutate({ terminal_font_custom: value })
                }
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </InlineField>
        )}

        <InlineField
          label="Terminal font size"
          description="Applies to all terminal tabs"
        >
          <Select
            value={String(preferences?.terminal_font_size ?? 13)}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_font_size: Number(value),
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map(size => (
                <SelectItem key={size} value={String(size)}>
                  {size}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>
      </div>
    </div>
  )
}
