import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { usePreferences, useSavePreferences, preferencesQueryKeys } from './preferences'
import type { AppPreferences } from '@/types/preferences'
import { FONT_SIZE_DEFAULT, DEFAULT_MAGIC_PROMPTS, DEFAULT_MAGIC_PROMPT_MODELS } from '@/types/preferences'
import { DEFAULT_KEYBINDINGS } from '@/types/keybindings'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

const createWrapper = (queryClient: QueryClient) => {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('preferences service', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = createTestQueryClient()
    vi.clearAllMocks()
    // Mock Tauri environment
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
  })

  describe('preferencesQueryKeys', () => {
    it('returns correct all key', () => {
      expect(preferencesQueryKeys.all).toEqual(['preferences'])
    })

    it('returns correct preferences key', () => {
      expect(preferencesQueryKeys.preferences()).toEqual(['preferences'])
    })
  })

  describe('usePreferences', () => {
    it('loads preferences from backend', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockPreferences: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        auto_branch_naming: true,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: FONT_SIZE_DEFAULT,
        chat_font_size: FONT_SIZE_DEFAULT,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 60,
        remote_poll_interval: 60,
        keybindings: DEFAULT_KEYBINDINGS,
        archive_retention_days: 30,
        session_grouping_enabled: true,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: true,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }
      vi.mocked(invoke).mockResolvedValueOnce(mockPreferences)

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).toHaveBeenCalledWith('load_preferences')
      expect(result.current.data?.theme).toBe('dark')
    })

    it('returns defaults when not in Tauri context', async () => {
      // Remove Tauri context
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.theme).toBe('system')
      expect(result.current.data?.selected_model).toBe('opus')
    })

    it('returns defaults on backend error', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('File not found'))

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.theme).toBe('system')
    })

    it('migrates old keybindings to new defaults', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const prefsWithOldBinding: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        auto_branch_naming: true,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: FONT_SIZE_DEFAULT,
        chat_font_size: FONT_SIZE_DEFAULT,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 60,
        remote_poll_interval: 60,
        keybindings: {
          ...DEFAULT_KEYBINDINGS,
          toggle_left_sidebar: 'mod+1', // Old default
        },
        archive_retention_days: 30,
        session_grouping_enabled: true,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: true,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }
      vi.mocked(invoke).mockResolvedValueOnce(prefsWithOldBinding)

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      // Should migrate to new default
      expect(result.current.data?.keybindings?.toggle_left_sidebar).toBe('mod+b')
    })
  })

  describe('useSavePreferences', () => {
    it('saves preferences to backend', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { toast } = await import('sonner')
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      const newPrefs: AppPreferences = {
        theme: 'light',
        selected_model: 'sonnet',
        thinking_level: 'think',
        terminal: 'warp',
        editor: 'cursor',
        auto_branch_naming: false,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: 14,
        chat_font_size: 14,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 30,
        remote_poll_interval: 120,
        keybindings: DEFAULT_KEYBINDINGS,
        archive_retention_days: 7,
        session_grouping_enabled: false,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: false,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).toHaveBeenCalledWith('save_preferences', { preferences: newPrefs })
      expect(toast.success).toHaveBeenCalledWith('Preferences saved')
    })

    it('updates cache on success', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      const newPrefs: AppPreferences = {
        theme: 'light',
        selected_model: 'sonnet',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        auto_branch_naming: true,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: FONT_SIZE_DEFAULT,
        chat_font_size: FONT_SIZE_DEFAULT,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 60,
        remote_poll_interval: 60,
        keybindings: DEFAULT_KEYBINDINGS,
        archive_retention_days: 30,
        session_grouping_enabled: true,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: true,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      const cached = queryClient.getQueryData(preferencesQueryKeys.preferences())
      expect(cached).toEqual(newPrefs)
    })

    it('skips persistence when not in Tauri context', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      const newPrefs: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        auto_branch_naming: true,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: FONT_SIZE_DEFAULT,
        chat_font_size: FONT_SIZE_DEFAULT,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 60,
        remote_poll_interval: 60,
        keybindings: DEFAULT_KEYBINDINGS,
        archive_retention_days: 30,
        session_grouping_enabled: true,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: true,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).not.toHaveBeenCalled()
    })

    it('shows error toast on failure', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { toast } = await import('sonner')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Save failed'))

      const newPrefs: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        auto_branch_naming: true,
        branch_naming_model: 'haiku',
        auto_session_naming: true,
        session_naming_model: 'haiku',
        ui_font_size: FONT_SIZE_DEFAULT,
        chat_font_size: FONT_SIZE_DEFAULT,
        ui_font: 'geist',
        chat_font: 'geist',
        git_poll_interval: 60,
        remote_poll_interval: 60,
        keybindings: DEFAULT_KEYBINDINGS,
        archive_retention_days: 30,
        session_grouping_enabled: true,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        disable_thinking_in_non_plan_modes: true,
        session_recap_enabled: false,
        session_recap_model: 'haiku',
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        workspace_folder: '',
        default_ai_provider: 'claude',
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isError).toBe(true))

      expect(toast.error).toHaveBeenCalledWith('Failed to save preferences', {
        description: 'Save failed',
      })
    })
  })
})
