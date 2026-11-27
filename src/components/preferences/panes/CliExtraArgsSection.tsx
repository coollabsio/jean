import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { Loader2 } from '@/components/icons/reicon'
import { Input } from '@/components/ui/input'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'
import { InlineField } from '../InlineField'

/** Where Jean adds the flags, and when a change applies, per backend. */
const APPLIES_TO: Record<CliBackend, string> = {
  claude: 'Added to every Claude CLI run. Applies from the next message.',
  codex:
    'Added after `codex exec` (magic prompts, reviews) and `codex app-server` (chat). The app-server is shared, so chat uses a change after it restarts.',
  opencode:
    'Added to `opencode serve`. The server is shared, so a change applies after it restarts (when idle, or after restarting Jean). `--pure` exists in OpenCode 1.x only; OpenCode 2.x does not start with an unknown flag.',
  cursor: 'Added to every Cursor CLI run. Applies from the next message.',
  pi: 'Added to every PI run. Applies from the next message.',
  commandcode:
    'Added to every Command Code run. Applies from the next message.',
  grok: 'Added to `grok agent` (chat) and to magic prompt runs. Applies to new runs.',
  kimi: 'Added to `kimi acp` (chat) and to magic prompt runs. Applies from the next message.',
  devin: 'Added to `devin acp`. Applies from the next message.',
  antigravity:
    'Added to every Antigravity CLI run. Applies from the next message.',
  muse: 'Added to `muse serve` (chat) and `muse exec` (magic prompts). Applies from the next message.',
}

/**
 * Free-form extra flags for one backend CLI (issue #335), for example
 * `--pure` for OpenCode. Rust splits and validates the value at spawn time.
 */
export function CliExtraArgsSection({ backend }: { backend: CliBackend }) {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const saved = preferences?.cli_extra_args?.[backend] ?? ''
  const [localValue, setLocalValue] = useState(saved)
  const [seenSaved, setSeenSaved] = useState(saved)
  if (saved !== seenSaved) {
    setSeenSaved(saved)
    setLocalValue(saved)
  }

  const isSaving =
    patchPreferences.isPending &&
    patchPreferences.variables != null &&
    Object.hasOwn(patchPreferences.variables, 'cli_extra_args')

  const handleSave = useCallback(() => {
    if (!preferences || localValue === saved) return
    const { [backend]: _previous, ...others } = preferences.cli_extra_args
    const trimmed = localValue.trim()
    patchPreferences.mutate({
      cli_extra_args: trimmed ? { ...others, [backend]: trimmed } : others,
    })
  }, [preferences, localValue, saved, backend, patchPreferences])

  // Escape closes Settings without blurring the input; keep the typed value.
  const flushOnUnmount = useEffectEvent(handleSave)
  useEffect(() => () => flushOnUnmount(), [])

  const inputId = `cli-extra-args-${backend}`
  return (
    <SettingsSection
      title="Extra CLI arguments"
      anchorId={`pref-${backend}-extra-args`}
    >
      <InlineField
        label="Arguments"
        description="Flags Jean adds when it starts this CLI"
        help={`${APPLIES_TO[backend]} Split like a shell (quotes work). Only flags and their values; no shell operators. Jean drops flags it controls (output format, permissions, session, model).`}
      >
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            aria-label={`Extra ${backend} CLI arguments`}
            className="w-full font-mono text-base sm:w-80 md:text-sm"
            placeholder={backend === 'opencode' ? '--pure' : '--flag value'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={localValue}
            onChange={event => setLocalValue(event.target.value)}
            onBlur={handleSave}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          {isSaving && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </InlineField>
    </SettingsSection>
  )
}
