import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
} from '@/types/preferences'
import {
  getFirstInstalledMagicDefaults,
  getReadyBackends,
  hasUntouchedClaudeMagicDefaults,
} from './useMagicPromptAutoDefaults'

describe('getFirstInstalledMagicDefaults', () => {
  it('only considers installed and authenticated backends ready', () => {
    expect(
      getReadyBackends(['claude', 'codex', 'opencode'], {
        claude: false,
        codex: true,
        opencode: undefined,
      })
    ).toEqual(['codex'])
  })

  it('selects the first installed supported CLI', () => {
    expect(getFirstInstalledMagicDefaults(['codex'])).toEqual({
      models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
      backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
    })
    expect(
      getFirstInstalledMagicDefaults(['opencode', 'codex'])?.backends
    ).toBe(OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS)
  })

  it('selects Muse presets when Muse is the first installed CLI', () => {
    const defaults = getFirstInstalledMagicDefaults(['muse', 'codex'])
    expect(defaults?.backends.investigate_issue_backend).toBe('muse')
    expect(defaults?.models.investigate_issue_model).toBe('muse/default')
  })

  it('waits when no CLI is installed', () => {
    expect(getFirstInstalledMagicDefaults([])).toBeNull()
  })

  it('keeps Claude defaults when Claude is first', () => {
    expect(getFirstInstalledMagicDefaults(['claude', 'codex'])).toBeNull()
  })

  it('recognizes untouched Claude defaults for onboarding repair', () => {
    expect(
      hasUntouchedClaudeMagicDefaults(
        DEFAULT_MAGIC_PROMPT_MODELS,
        DEFAULT_MAGIC_PROMPT_BACKENDS
      )
    ).toBe(true)
    expect(
      hasUntouchedClaudeMagicDefaults(
        CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
        CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS
      )
    ).toBe(false)
  })
})
