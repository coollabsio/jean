import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPreferences, type AppPreferences } from '@/types/preferences'
import type * as MagicPromptTerminal from '@/lib/magic-prompt-terminal'
import type * as CliBinary from '@/services/cli-binary'
import { maybeRunMagicPromptInTerminal } from './magic-prompt-surface'

const launchMagicPromptTerminal = vi.hoisted(() => vi.fn())
const resolveBackendCliPath = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/lib/magic-prompt-terminal', async importOriginal => {
  const actual = await importOriginal<typeof MagicPromptTerminal>()
  return { ...actual, launchMagicPromptTerminal }
})

vi.mock('@/services/cli-binary', async importOriginal => {
  const actual = await importOriginal<typeof CliBinary>()
  return { ...actual, resolveBackendCliPath }
})

vi.mock('sonner', () => ({ toast: { error: toastError } }))

const params = {
  surfaceKey: 'code_review_surface',
  prompt: 'Review this branch.',
  backend: 'claude',
  label: 'Code Review',
  worktreeId: 'wt-1',
  worktreePath: '/repo',
} as const

const withPrefs = (overrides: Partial<AppPreferences> = {}): AppPreferences => ({
  ...defaultPreferences,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  resolveBackendCliPath.mockResolvedValue('/opt/jean/bin/claude')
  launchMagicPromptTerminal.mockResolvedValue({
    sessionId: 's-1',
    terminalId: 't-1',
  })
})

describe('maybeRunMagicPromptInTerminal', () => {
  it('declines to handle the prompt when the surface is chat', async () => {
    await expect(
      maybeRunMagicPromptInTerminal({ ...params, preferences: withPrefs() })
    ).resolves.toBe(false)
    expect(launchMagicPromptTerminal).not.toHaveBeenCalled()
  })

  it('handles the prompt when the per-prompt surface is terminal', async () => {
    await expect(
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences: withPrefs({
          magic_prompt_surfaces: {
            ...defaultPreferences.magic_prompt_surfaces,
            code_review_surface: 'terminal',
          },
        }),
      })
    ).resolves.toBe(true)
    expect(launchMagicPromptTerminal).toHaveBeenCalledTimes(1)
  })

  it('honors a global terminal default when no per-prompt value is set', async () => {
    await expect(
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences: withPrefs({ default_magic_prompt_surface: 'terminal' }),
      })
    ).resolves.toBe(true)
  })

  it('lets a per-prompt chat setting override a global terminal default', async () => {
    await expect(
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences: withPrefs({
          default_magic_prompt_surface: 'terminal',
          magic_prompt_surfaces: {
            ...defaultPreferences.magic_prompt_surfaces,
            code_review_surface: 'chat',
          },
        }),
      })
    ).resolves.toBe(false)
    expect(launchMagicPromptTerminal).not.toHaveBeenCalled()
  })

  it('lets an explicit override beat both preference levels', async () => {
    await expect(
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences: withPrefs(),
        surfaceOverride: 'terminal',
      })
    ).resolves.toBe(true)
    expect(launchMagicPromptTerminal).toHaveBeenCalledTimes(1)
  })

  it('launches the resolved absolute path, not the bare name', async () => {
    // Jean-managed installs are not on PATH, so a bare name would fail to spawn.
    await maybeRunMagicPromptInTerminal({
      ...params,
      preferences: withPrefs({ default_magic_prompt_surface: 'terminal' }),
    })

    expect(launchMagicPromptTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: '/opt/jean/bin/claude' })
    )
  })

  it('falls back to the bare command when no path resolves', async () => {
    resolveBackendCliPath.mockResolvedValue(null)

    await maybeRunMagicPromptInTerminal({
      ...params,
      preferences: withPrefs({ default_magic_prompt_surface: 'terminal' }),
    })

    expect(launchMagicPromptTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'claude' })
    )
  })

  it('passes yolo through only for yolo execution mode', async () => {
    const preferences = withPrefs({ default_magic_prompt_surface: 'terminal' })

    await maybeRunMagicPromptInTerminal({
      ...params,
      preferences,
      executionMode: 'yolo',
    })
    expect(launchMagicPromptTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ yolo: true })
    )

    await maybeRunMagicPromptInTerminal({
      ...params,
      preferences,
      executionMode: 'plan',
    })
    expect(launchMagicPromptTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ yolo: false })
    )
  })

  it('reports launch failures instead of silently running headless', async () => {
    // A surprise chat fallback would spend tokens the user did not intend.
    launchMagicPromptTerminal.mockRejectedValue(new Error('spawn failed'))

    await expect(
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences: withPrefs({ default_magic_prompt_surface: 'terminal' }),
      })
    ).resolves.toBe(true)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
