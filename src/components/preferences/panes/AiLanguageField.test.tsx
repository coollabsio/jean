import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPreferences } from '@/types/preferences'
import { defaultPreferences } from '@/types/preferences'
import { AiLanguageField, isAiLanguageSavePending } from './AiLanguageField'

const mutateMock = vi.fn()
const isPendingRef = { current: false }
const variablesRef = {
  current: undefined as Partial<AppPreferences> | undefined,
}

vi.mock('@/services/preferences', () => ({
  usePatchPreferences: () => ({
    mutate: mutateMock,
    get isPending() {
      return isPendingRef.current
    },
    get variables() {
      return variablesRef.current
    },
  }),
}))

function renderField(preferences: AppPreferences = defaultPreferences) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AiLanguageField, { preferences })
    )
  )
}

describe('isAiLanguageSavePending (#505)', () => {
  it('is false while a model-default (or other) patch is pending', () => {
    expect(
      isAiLanguageSavePending(true, {
        selected_model: 'claude-sonnet-4-6[1m]',
      })
    ).toBe(false)
    expect(isAiLanguageSavePending(true, { thinking_level: 'high' })).toBe(
      false
    )
    expect(isAiLanguageSavePending(false, { ai_language: 'French' })).toBe(
      false
    )
    expect(isAiLanguageSavePending(true, undefined)).toBe(false)
    expect(isAiLanguageSavePending(true, null)).toBe(false)
  })

  it('is true only while an ai_language patch is pending', () => {
    expect(isAiLanguageSavePending(true, { ai_language: 'French' })).toBe(true)
    expect(isAiLanguageSavePending(true, { ai_language: '' })).toBe(true)
  })
})

describe('AiLanguageField (#505)', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    isPendingRef.current = false
    variablesRef.current = undefined
  })

  it('does not show a loading spinner while a model-default patch is pending', async () => {
    const user = userEvent.setup()
    const { rerender } = renderField()

    const input = screen.getByPlaceholderText('Default')
    await user.clear(input)
    await user.type(input, 'French')

    const save = screen.getByRole('button', { name: /save/i })
    await waitFor(() => expect(save).not.toBeDisabled())

    // Concurrent model default edit — previously shared isPending spun this button
    isPendingRef.current = true
    variablesRef.current = { selected_model: 'claude-sonnet-4-6[1m]' }

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    rerender(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AiLanguageField, { preferences: defaultPreferences })
      )
    )

    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled()
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('shows a loading spinner only while an ai_language patch is pending', async () => {
    const user = userEvent.setup()
    const { rerender } = renderField()

    const input = screen.getByPlaceholderText('Default')
    await user.clear(input)
    await user.type(input, 'French')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled()
    })

    isPendingRef.current = true
    variablesRef.current = { ai_language: 'French' }

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    rerender(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AiLanguageField, { preferences: defaultPreferences })
      )
    )

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })

  it('patches ai_language on save', async () => {
    const user = userEvent.setup()
    renderField()

    const input = screen.getByPlaceholderText('Default')
    await user.clear(input)
    await user.type(input, '日本語')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(mutateMock).toHaveBeenCalledWith({ ai_language: '日本語' })
  })
})
