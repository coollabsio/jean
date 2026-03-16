import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import {
  usePreferences,
  useSavePreferences,
  preferencesQueryKeys,
} from './preferences'
import type { AppPreferences } from '@/types/preferences'
import {
  FONT_SIZE_DEFAULT,
  DEFAULT_MAGIC_PROMPTS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_PROVIDERS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  DEFAULT_MAGIC_PROMPT_EFFORTS,
} from '@/types/preferences'
import { DEFAULT_KEYBINDINGS } from '@/types/keybindings'

vi.mock('@/lib/transport', () => ({
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
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  Wrapper.displayName = 'TestQueryClientWrapper'
  return Wrapper
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
      const { invoke } = await import('@/lib/transport')
      const mockPreferences: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
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
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('File not found'))

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.theme).toBe('system')
    })

    it('migrates old keybindings to new defaults', async () => {
      const { invoke } = await import('@/lib/transport')
      const prefsWithOldBinding: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
      }
      vi.mocked(invoke).mockResolvedValueOnce(prefsWithOldBinding)

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      // Should migrate to new default
      expect(result.current.data?.keybindings?.toggle_left_sidebar).toBe(
        'mod+b'
      )
    })

    it('migrates deprecated Codex fast models to their standard variants', async () => {
      const { invoke } = await import('@/lib/transport')
      const prefsWithDeprecatedFastModel: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.3-fast' as AppPreferences['selected_codex_model'],
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
      }
      vi.mocked(invoke).mockResolvedValueOnce(prefsWithDeprecatedFastModel)

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.selected_codex_model).toBe('gpt-5.3')
    })
  })

  describe('useSavePreferences', () => {
    it('saves preferences to backend', async () => {
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      const newPrefs: AppPreferences = {
        theme: 'light',
        selected_model: 'sonnet',
        thinking_level: 'think',
        terminal: 'warp',
        editor: 'cursor',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).toHaveBeenCalledWith('save_preferences', {
        preferences: newPrefs,
      })
      // Toast was removed — preferences save silently logs instead
    })

    it('updates cache on success', async () => {
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      const newPrefs: AppPreferences = {
        theme: 'light',
        selected_model: 'sonnet',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      const cached = queryClient.getQueryData(
        preferencesQueryKeys.preferences()
      )
      expect(cached).toEqual(newPrefs)
    })

    it('skips persistence when not in Tauri context', async () => {
      const { invoke } = await import('@/lib/transport')
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      const newPrefs: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
      }

      const { result } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      result.current.mutate(newPrefs)

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).not.toHaveBeenCalled()
    })

    it('shows error toast on failure', async () => {
      const { invoke } = await import('@/lib/transport')
      const { toast } = await import('sonner')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Save failed'))

      const newPrefs: AppPreferences = {
        theme: 'dark',
        selected_model: 'opus',
        thinking_level: 'off',
        terminal: 'terminal',
        editor: 'vscode',
        open_in: 'editor',
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
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        session_recap_enabled: false,
        parallel_execution_prompt_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_auto_start: false,
        http_server_localhost_only: true,
        http_server_token_required: true,
        removal_behavior: 'archive',
        auto_archive_on_pr_merged: true,
        debug_mode_enabled: false,
        default_effort_level: 'high',
        default_enabled_mcp_servers: [],
        known_mcp_servers: [],
        has_seen_feature_tour: false,
        has_seen_jean_config_wizard: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,

        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        selected_codex_model: 'gpt-5.4',
        selected_opencode_model: 'opencode/gpt-5.3-codex',
        default_codex_reasoning_effort: 'high',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        restore_last_session: false,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
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
