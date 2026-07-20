import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  uiFontOptions,
  chatFontOptions,
  syntaxThemeDarkOptions,
  syntaxThemeLightOptions,
  fileEditModeOptions,
  terminalBackgroundOptions,
  FONT_SIZE_DEFAULT,
  ZOOM_LEVEL_DEFAULT,
  uiFontScaleTicks,
  chatFontScaleTicks,
  zoomLevelTicks,
  type UIFont,
  type ChatFont,
  type SyntaxTheme,
  type FileEditMode,
  type TerminalBackgroundMode,
} from '@/types/preferences'
import { getModifierSymbol, isClientMacOS } from '@/lib/platform'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { isValidHex } from '@/lib/terminal-theme'
import { SettingsSection } from '../SettingsSection'

const InlineField: React.FC<{
  label: string
  description?: string
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
    {children}
  </div>
)

const ScalingField: React.FC<{
  label: string
  description?: string
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="space-y-2">
    <div className="space-y-0.5">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
    {children}
  </div>
)

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const modKey = getModifierSymbol()

export const AppearancePane: React.FC = () => {
  const { theme, setTheme } = useTheme()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [isVibrancyPending, setIsVibrancyPending] = useState(false)

  // Zoom uses commit-only saving to avoid flickering the webview during drag.
  // localZoom tracks slider position, preferences are saved only on release.
  const desktopZoom = preferences?.zoom_level ?? ZOOM_LEVEL_DEFAULT
  const savedMobileZoom = preferences?.mobile_zoom_level ?? ZOOM_LEVEL_DEFAULT
  const syncZoomLevels = preferences?.sync_zoom_levels ?? true
  const [localDesktopZoom, setLocalDesktopZoom] = useState<number | null>(null)
  const [localMobileZoom, setLocalMobileZoom] = useState<number | null>(null)
  const desktopZoomValue = localDesktopZoom ?? desktopZoom
  const mobileZoomValue = syncZoomLevels
    ? desktopZoomValue
    : (localMobileZoom ?? savedMobileZoom)

  const handleThemeChange = useCallback(
    async (value: 'light' | 'dark' | 'system') => {
      setTheme(value)
      patchPreferences.mutate({ theme: value })
    },
    [setTheme, patchPreferences]
  )

  const handleFontSizeChange = useCallback(
    (field: 'ui_font_size' | 'chat_font_size', value: number) => {
      if (!isNaN(value) && value > 0) {
        patchPreferences.mutate({ [field]: value })
      }
    },
    [patchPreferences]
  )

  const handleZoomCommit = useCallback(
    (target: 'desktop' | 'mobile', value: number) => {
      if (target === 'desktop') {
        setLocalDesktopZoom(null)
        patchPreferences.mutate(
          syncZoomLevels
            ? { zoom_level: value, mobile_zoom_level: value }
            : { zoom_level: value }
        )
      } else {
        setLocalMobileZoom(null)
        patchPreferences.mutate({ mobile_zoom_level: value })
      }
    },
    [patchPreferences, syncZoomLevels]
  )

  const handleSyncZoomLevelsChange = useCallback(
    (checked: boolean | 'indeterminate') => {
      const shouldSync = checked === true
      setLocalDesktopZoom(null)
      setLocalMobileZoom(null)
      patchPreferences.mutate({
        sync_zoom_levels: shouldSync,
        mobile_zoom_level: desktopZoom,
      })
    },
    [desktopZoom, patchPreferences]
  )

  const handleFontChange = useCallback(
    (field: 'ui_font' | 'chat_font', value: UIFont | ChatFont) => {
      patchPreferences.mutate({ [field]: value })
    },
    [patchPreferences]
  )

  const handleSyntaxThemeChange = useCallback(
    (field: 'syntax_theme_dark' | 'syntax_theme_light', value: SyntaxTheme) => {
      patchPreferences.mutate({ [field]: value })
    },
    [patchPreferences]
  )

  const handleTerminalBackgroundModeChange = useCallback(
    (value: TerminalBackgroundMode) => {
      patchPreferences.mutate({ terminal_background: value })
    },
    [patchPreferences]
  )

  // Custom terminal color: keep an uncommitted draft so the hex field can be
  // typed into character by character, and debounce persistence so dragging
  // the native color picker does not flood the backend with disk writes.
  const terminalMode = preferences?.terminal_background ?? 'auto'
  const savedCustomColor = preferences?.terminal_background_custom ?? null
  const [customColorDraft, setCustomColorDraft] = useState<string | null>(null)
  const customSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const customColorValue = customColorDraft ?? savedCustomColor ?? ''

  // Drop the draft whenever the mode is no longer "custom" so the field
  // re-syncs to the saved value next time it is shown.
  useEffect(() => {
    if (terminalMode !== 'custom') setCustomColorDraft(null)
  }, [terminalMode])

  useEffect(() => {
    return () => {
      if (customSaveTimer.current) clearTimeout(customSaveTimer.current)
    }
  }, [])

  const scheduleCustomColorSave = useCallback(
    (value: string | null) => {
      if (customSaveTimer.current) clearTimeout(customSaveTimer.current)
      customSaveTimer.current = setTimeout(() => {
        customSaveTimer.current = null
        patchPreferences.mutate({ terminal_background_custom: value })
      }, 200)
    },
    [patchPreferences]
  )

  const handleCustomColorPick = useCallback(
    (value: string) => {
      setCustomColorDraft(value)
      scheduleCustomColorSave(value)
    },
    [scheduleCustomColorSave]
  )

  const handleCustomColorText = useCallback(
    (value: string) => {
      setCustomColorDraft(value)
      const trimmed = value.trim()
      if (trimmed === '') {
        scheduleCustomColorSave(null)
      } else if (isValidHex(trimmed)) {
        scheduleCustomColorSave(trimmed)
      }
    },
    [scheduleCustomColorSave]
  )

  const handleCustomColorBlur = useCallback(() => {
    if (customSaveTimer.current) {
      clearTimeout(customSaveTimer.current)
      customSaveTimer.current = null
    }
    const trimmed = (customColorDraft ?? '').trim()
    if (customColorDraft !== null) {
      if (trimmed === '') {
        patchPreferences.mutate({ terminal_background_custom: null })
      } else if (isValidHex(trimmed)) {
        patchPreferences.mutate({ terminal_background_custom: trimmed })
      }
    }
    // Resync the field to the persisted value (discards invalid drafts).
    setCustomColorDraft(null)
  }, [customColorDraft, patchPreferences])

  const handleFileEditModeChange = useCallback(
    (value: FileEditMode) => {
      patchPreferences.mutate({ file_edit_mode: value })
    },
    [patchPreferences]
  )

  const handleVibrancyChange = useCallback(
    async (checked: boolean) => {
      const previous = preferences?.window_vibrancy ?? false
      if (checked === previous) return

      setIsVibrancyPending(true)
      try {
        await patchPreferences.mutateAsync({ window_vibrancy: checked })
      } catch {
        setIsVibrancyPending(false)
        return
      }

      try {
        await invoke('set_window_vibrancy', { enabled: checked })
      } catch (error) {
        try {
          await invoke('set_window_vibrancy', { enabled: previous })
          await patchPreferences.mutateAsync({ window_vibrancy: previous })
        } catch (rollbackError) {
          toast.error('Window transparency was not applied or rolled back', {
            description: getErrorMessage(rollbackError),
          })
          return
        }

        toast.error('Window transparency was not applied', {
          description: getErrorMessage(error),
        })
      } finally {
        setIsVibrancyPending(false)
      }
    },
    [patchPreferences, preferences?.window_vibrancy]
  )

  return (
    <div className="space-y-6">
      <SettingsSection title="Theme" anchorId="pref-appearance-section-theme">
        <div className="space-y-4">
          <InlineField
            label="Color theme"
            description="Choose your preferred color scheme"
          >
            <Select
              value={theme}
              onValueChange={handleThemeChange}
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Syntax theme (dark)"
            description="Highlighting theme for code in dark mode"
          >
            <Select
              value={preferences?.syntax_theme_dark ?? 'vitesse-black'}
              onValueChange={value =>
                handleSyntaxThemeChange(
                  'syntax_theme_dark',
                  value as SyntaxTheme
                )
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent>
                {syntaxThemeDarkOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Syntax theme (light)"
            description="Highlighting theme for code in light mode"
          >
            <Select
              value={preferences?.syntax_theme_light ?? 'github-light'}
              onValueChange={value =>
                handleSyntaxThemeChange(
                  'syntax_theme_light',
                  value as SyntaxTheme
                )
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent>
                {syntaxThemeLightOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          {isClientMacOS && (
            <InlineField
              label="Window transparency"
              description="Translucent window with desktop blur (uses significant GPU)"
            >
              <Switch
                checked={preferences?.window_vibrancy ?? false}
                onCheckedChange={handleVibrancyChange}
                disabled={patchPreferences.isPending || isVibrancyPending}
              />
            </InlineField>
          )}

          <InlineField
            label="Terminal background"
            description="Pick a background color for the terminal panel"
          >
            <Select
              value={terminalMode}
              onValueChange={value =>
                handleTerminalBackgroundModeChange(
                  value as TerminalBackgroundMode
                )
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {terminalBackgroundOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          {terminalMode === 'custom' && (
            <InlineField
              label="Custom terminal color"
              description="Choose any color you like for the terminal background"
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={
                    isValidHex(customColorValue) ? customColorValue : '#101010'
                  }
                  onChange={e => handleCustomColorPick(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border"
                  aria-label="Pick terminal background color"
                />
                <Input
                  value={customColorValue}
                  onChange={e => handleCustomColorText(e.target.value)}
                  onBlur={handleCustomColorBlur}
                  placeholder="#101010"
                  className="w-40 font-mono"
                  spellCheck={false}
                />
              </div>
            </InlineField>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Fonts" anchorId="pref-appearance-section-fonts">
        <div className="space-y-4">
          <InlineField label="UI font" description="Font for interface text">
            <Select
              value={preferences?.ui_font ?? 'inter'}
              onValueChange={value =>
                handleFontChange('ui_font', value as UIFont)
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select font" />
              </SelectTrigger>
              <SelectContent>
                {uiFontOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField label="Chat font" description="Font for chat messages">
            <Select
              value={preferences?.chat_font ?? 'jetbrains-mono'}
              onValueChange={value =>
                handleFontChange('chat_font', value as ChatFont)
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select font" />
              </SelectTrigger>
              <SelectContent>
                {chatFontOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Scaling"
        anchorId="pref-appearance-section-scaling"
      >
        <div className="space-y-5">
          <ScalingField
            label="UI font scaling"
            description="Increase or decrease the size of the interface font"
          >
            <Slider
              ticks={uiFontScaleTicks}
              value={preferences?.ui_font_size ?? FONT_SIZE_DEFAULT}
              onValueChange={value =>
                handleFontSizeChange('ui_font_size', value)
              }
              disabled={patchPreferences.isPending}
            />
          </ScalingField>

          <ScalingField
            label="Chat font scaling"
            description="Increase or decrease the size of the chat font"
          >
            <Slider
              ticks={chatFontScaleTicks}
              value={preferences?.chat_font_size ?? FONT_SIZE_DEFAULT}
              onValueChange={value =>
                handleFontSizeChange('chat_font_size', value)
              }
              disabled={patchPreferences.isPending}
            />
          </ScalingField>

          <div className="flex items-center gap-2">
            <Checkbox
              id="sync-zoom-levels"
              checked={syncZoomLevels}
              onCheckedChange={handleSyncZoomLevelsChange}
              disabled={patchPreferences.isPending}
            />
            <Label
              htmlFor="sync-zoom-levels"
              className="cursor-pointer text-sm"
            >
              Sync desktop and mobile scaling
            </Label>
          </div>

          <ScalingField
            label="Desktop zoom level"
            description="Adjust the interface size on desktop screens"
          >
            <Slider
              ticks={zoomLevelTicks}
              value={desktopZoomValue}
              onValueChange={setLocalDesktopZoom}
              onValueCommit={value => handleZoomCommit('desktop', value)}
              disabled={patchPreferences.isPending}
            />
            <p className="text-xs text-muted-foreground">
              You can change the zoom level with {modKey} +/- and reset to the
              default zoom with {modKey}+0.
            </p>
          </ScalingField>

          <ScalingField
            label="Mobile zoom level"
            description={
              syncZoomLevels
                ? 'Synced with the desktop zoom level'
                : 'Adjust the interface size on mobile screens'
            }
          >
            <Slider
              ticks={zoomLevelTicks}
              value={mobileZoomValue}
              onValueChange={setLocalMobileZoom}
              onValueCommit={value => handleZoomCommit('mobile', value)}
              disabled={syncZoomLevels || patchPreferences.isPending}
            />
          </ScalingField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="File Viewer"
        anchorId="pref-appearance-section-file-viewer"
      >
        <div className="space-y-4">
          <InlineField
            label="Edit files in"
            description="How to edit files when viewing them in Jean"
          >
            <Select
              value={preferences?.file_edit_mode ?? 'external'}
              onValueChange={value =>
                handleFileEditModeChange(value as FileEditMode)
              }
              disabled={patchPreferences.isPending}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select mode" />
              </SelectTrigger>
              <SelectContent>
                {fileEditModeOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>
    </div>
  )
}
