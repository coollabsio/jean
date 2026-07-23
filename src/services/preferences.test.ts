import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import {
  usePreferences,
  useSavePreferences,
  preferencesQueryKeys,
} from './preferences'
import { AppearancePane } from '@/components/preferences/panes/AppearancePane'
import type { AppPreferences } from '@/types/preferences'
import {
  FONT_SIZE_DEFAULT,
  ZOOM_LEVEL_DEFAULT,
  codexDefaultModelOptions,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_LUNA_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_LUNA_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_SOL_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_SOL_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_TERRA_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_TERRA_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_MAGIC_PROMPTS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_PROVIDERS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  DEFAULT_MAGIC_PROMPT_EFFORTS,
  DEFAULT_MAGIC_PROMPT_MODES,
  modelOptions,
  normalizeClaudeModel,
  normalizeCodexModel,
  defaultPreferences,
} from '@/types/preferences'
import { DEFAULT_KEYBINDINGS } from '@/types/keybindings'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isClientMacOS: true,
  isMacOS: true,
  isWindows: false,
  isLinux: false,
  getServerPlatform: vi.fn(() => 'mac'),
  isServerWindows: vi.fn(() => false),
  getModifierSymbol: vi.fn(() => '⌘'),
  getFileManagerName: vi.fn(() => 'Finder'),
  openExternal: vi.fn(),
  preOpenWindow: vi.fn(() => null),
}))

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn(),
  }),
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

describe('model option helpers', () => {
  it('enables compact chat view by default', () => {
    expect(defaultPreferences.compact_chat_view_enabled).toBe(true)
  })

  it('syncs desktop and mobile zoom by default', () => {
    expect(defaultPreferences.zoom_level).toBe(ZOOM_LEVEL_DEFAULT)
    expect(defaultPreferences.mobile_zoom_level).toBe(ZOOM_LEVEL_DEFAULT)
    expect(defaultPreferences.sync_zoom_levels).toBe(true)
  })

  it('offers Claude 1M variants alongside standard context models', () => {
    expect(modelOptions.map(option => option.value)).toEqual([
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-4-8[1m]',
      'claude-opus-4-8',
      'claude-opus-4-7[1m]',
      'claude-opus-4-7',
      'claude-opus-4-6[1m]',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-6[1m]',
      'claude-sonnet-4-6',
      'haiku',
    ])
    expect(normalizeClaudeModel('sonnet')).toBe('claude-sonnet-5')
    expect(normalizeClaudeModel('claude-fable-5')).toBe('claude-fable-5')
    expect(normalizeClaudeModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(normalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(normalizeClaudeModel('claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(normalizeClaudeModel('claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(normalizeClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('offers GPT 5.6 preview variants in Codex selectors', () => {
    const values = codexDefaultModelOptions.map(option => option.value)
    expect(values.slice(0, 3)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(values).not.toContain('gpt-5.6')
    expect(normalizeCodexModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(normalizeCodexModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(normalizeCodexModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(normalizeCodexModel('gpt-5.6')).toBe('gpt-5.6-sol')
    expect(normalizeCodexModel('gpt-5-6-sol')).toBe('gpt-5.6-sol')
  })

  it('offers Codex fast modes for default selectors', () => {
    const values = codexDefaultModelOptions.map(option => option.value)
    expect(values).toContain('gpt-5.6-sol-fast')
    expect(values).toContain('gpt-5.6-terra-fast')
    expect(values).toContain('gpt-5.6-luna-fast')
    expect(values).toContain('gpt-5.5-fast')
    expect(values).toContain('gpt-5.4-fast')
    expect(values).toContain('gpt-5.4-mini-fast')
    expect(normalizeCodexModel('gpt-5.6-sol-fast')).toBe('gpt-5.6-sol-fast')
    expect(normalizeCodexModel('gpt-5.6-fast')).toBe('gpt-5.6-sol-fast')
    expect(normalizeCodexModel('gpt-5-6-sol-fast')).toBe('gpt-5.6-sol-fast')
    expect(normalizeCodexModel('gpt-5.5-fast')).toBe('gpt-5.5-fast')
  })

  it('uses GPT 5.6 Sol for Codex magic presets', () => {
    expect(new Set(Object.values(CODEX_DEFAULT_MAGIC_PROMPT_MODELS))).toEqual(
      new Set(['gpt-5.6-sol'])
    )
    expect(
      new Set(Object.values(CODEX_FAST_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-sol-fast']))
  })

  it('provides standard and fast GPT 5.6 magic presets for every variant', () => {
    expect(
      new Set(Object.values(CODEX_56_SOL_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-sol']))
    expect(
      new Set(Object.values(CODEX_56_SOL_FAST_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-sol-fast']))
    expect(
      new Set(Object.values(CODEX_56_LUNA_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-luna']))
    expect(
      new Set(Object.values(CODEX_56_LUNA_FAST_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-luna-fast']))
    expect(
      new Set(Object.values(CODEX_56_TERRA_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-terra']))
    expect(
      new Set(Object.values(CODEX_56_TERRA_FAST_DEFAULT_MAGIC_PROMPT_MODELS))
    ).toEqual(new Set(['gpt-5.6-terra-fast']))
  })

  it('documents Codex questions-tool answers must re-show the plan tool', () => {
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'backend-native interactive question UI'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain('Codex request_user_input')
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'when the current execution mode is plan: after the user answers native `request_user_input`'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'Every Codex response that contains or revises a plan while the current execution mode is plan'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain('Jean Worktree Policy')
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'Do NOT create git worktrees manually'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain('Jean MCP/tools')
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'VERY IMPORTANT: Keep Code Simple'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'Always implement the simplest maintainable solution'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain('Clickable References')
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'include clickable links when available'
    )
  })

  it('requires GitHub issue and discussion discovery after changes', () => {
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'GitHub Issue and Discussion Discovery'
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      "search the current repository's existing GitHub issues and discussions"
    )
    expect(DEFAULT_GLOBAL_SYSTEM_PROMPT).toContain(
      'Include the results in both the main response and the `## Recap`'
    )
  })
})

describe('preferences service', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = createTestQueryClient()
    vi.clearAllMocks()
    // Mock Tauri environment
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: vi.fn() },
      configurable: true,
    })
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: class ResizeObserver {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
      }
      vi.mocked(invoke).mockResolvedValueOnce(mockPreferences)

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invoke).toHaveBeenCalledWith('load_preferences')
      expect(result.current.data?.theme).toBe('dark')
      expect(result.current.data?.jean_mcp_enabled).toBe(false)
    })

    it('returns defaults when not in Tauri context', async () => {
      // Remove Tauri context
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.theme).toBe('system')
      expect(result.current.data?.selected_model).toBe('claude-opus-4-8[1m]')
      expect(result.current.data?.jean_mcp_enabled).toBe(true)
    })

    it('reports backend errors instead of overwriting cached preferences', async () => {
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('File not found'))

      const { result } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isError).toBe(true))

      expect(result.current.data).toBeUndefined()
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
          toggle_left_sidebar: 'mod+1', // Old default
          restore_last_archived: 'mod+alt+shift+t', // Broken modifier order
        },
        archive_retention_days: 30,
        syntax_theme_dark: 'vitesse-black',
        syntax_theme_light: 'github-light',
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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
      expect(result.current.data?.keybindings?.restore_last_archived).toBe(
        'mod+shift+alt+t'
      )
      expect(result.current.data?.keybindings?.open_quick_menu).toBe(
        DEFAULT_KEYBINDINGS.open_quick_menu
      )
      expect(Object.keys(result.current.data?.keybindings ?? {})).toHaveLength(
        Object.keys(DEFAULT_KEYBINDINGS).length
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model:
          'gpt-5.3-fast' as AppPreferences['selected_codex_model'],
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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

    it('persists window vibrancy and returns it on subsequent loads', async () => {
      const { invoke } = await import('@/lib/transport')
      let persistedPreferences: AppPreferences = {
        ...defaultPreferences,
        window_vibrancy: false,
      }
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'save_preferences') {
          persistedPreferences = (args as { preferences: AppPreferences })
            .preferences
          return undefined
        }
        if (command === 'load_preferences') return persistedPreferences
        throw new Error(`Unexpected command ${command}`)
      })

      const prefsWithVibrancy: AppPreferences = {
        ...persistedPreferences,
        window_vibrancy: true,
      }
      const { result: saveResult } = renderHook(() => useSavePreferences(), {
        wrapper: createWrapper(queryClient),
      })

      await act(async () => {
        await saveResult.current.mutateAsync(prefsWithVibrancy)
      })

      expect(persistedPreferences.window_vibrancy).toBe(true)
      expect(invoke).toHaveBeenCalledWith('save_preferences', {
        preferences: prefsWithVibrancy,
      })

      const reloadQueryClient = createTestQueryClient()
      const { result: loadResult } = renderHook(() => usePreferences(), {
        wrapper: createWrapper(reloadQueryClient),
      })

      await waitFor(() => expect(loadResult.current.isSuccess).toBe(true))
      expect(loadResult.current.data?.window_vibrancy).toBe(true)
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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
        parallel_execution_prompt_enabled: true,
        compact_chat_view_enabled: false,
        magic_prompts: DEFAULT_MAGIC_PROMPTS,
        magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
        magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
        magic_prompt_modes: DEFAULT_MAGIC_PROMPT_MODES,
        file_edit_mode: 'external',
        ai_language: '',
        allow_web_tools_in_plan_mode: true,
        waiting_sound: 'none',
        review_sound: 'none',
        web_access_sounds_enabled: true,
        desktop_notifications_enabled: true,
        http_server_enabled: false,
        http_server_port: 3456,
        http_server_token: null,
        http_server_bind_host: null,
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
        has_seen_jean_mcp_intro: false,
        chrome_enabled: true,
        zoom_level: 100,
        custom_cli_profiles: [],
        default_provider: null,
        custom_codex_providers: [],
        default_codex_provider: null,
        custom_pi_providers: [],
        favorite_models: [],
        fast_mode_models: [],

        auto_save_context: false,
        auto_pull_base_branch: true,
        confirm_session_close: true,
        default_execution_mode: 'plan',
        default_backend: 'claude',
        default_new_session_kind: 'chat',
        selected_codex_model: 'gpt-5.5',
        selected_opencode_model: 'opencode/gpt-5.5',
        selected_cursor_model: 'cursor/auto',
        selected_pi_model: 'pi/sonnet',
        selected_grok_model: 'grok/grok-4.5',
        default_codex_reasoning_effort: 'high',
        default_grok_reasoning_effort: 'high',
        codex_goal_execution_mode: 'build',
        codex_multi_agent_enabled: false,
        codex_max_agent_threads: 3,
        codex_auto_steer_enabled: true,
        opencode_auto_steer_enabled: true,
        pi_auto_steer_enabled: true,
        grok_auto_steer_enabled: true,
        restore_last_session: true,
        close_original_on_clear_context: true,
        build_model: null,
        yolo_model: null,
        build_backend: null,
        yolo_backend: null,
        build_thinking_level: null,
        yolo_thinking_level: null,
        build_effort_level: null,
        yolo_effort_level: null,
        linear_api_key: null,
        magic_models_auto_initialized: false,
        claude_cli_source: 'jean',
        codex_cli_source: 'jean',
        opencode_cli_source: 'jean',
        grok_cli_source: 'jean',
        gh_cli_source: 'jean',
        wsl_mode_chosen: false,
        wsl_enabled: false,
        wsl_distro: '',
        pi_cli_source: 'jean',
        coderabbit_cli_source: 'jean',
        expand_tool_calls_by_default: false,
        window_vibrancy: false,
        terminal_background: 'auto',
        terminal_background_custom: null,
        auto_update_ai_backends: true,
        jean_mcp_enabled: false,
        jean_mcp_max_depth: 3,
        jean_mcp_rate_limit_per_minute: 20,
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

  describe('AppearancePane scaling', () => {
    it('syncs desktop and mobile scaling by default', async () => {
      const { invoke } = await import('@/lib/transport')
      let storedPreferences = { ...defaultPreferences }
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'load_preferences') return storedPreferences
        if (command === 'patch_preferences') {
          storedPreferences = {
            ...storedPreferences,
            ...(args as { patch: Partial<AppPreferences> }).patch,
          }
          return undefined
        }
        throw new Error(`Unexpected command ${command}`)
      })

      const user = userEvent.setup()
      render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AppearancePane)
        )
      )

      const syncCheckbox = await screen.findByRole('checkbox', {
        name: 'Sync desktop and mobile scaling',
      })
      expect(syncCheckbox).toBeChecked()
      expect(screen.getAllByRole('slider').at(-1)).toHaveAttribute(
        'data-disabled'
      )

      await user.click(syncCheckbox)

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('patch_preferences', {
          patch: {
            sync_zoom_levels: false,
            mobile_zoom_level: ZOOM_LEVEL_DEFAULT,
          },
        })
        expect(syncCheckbox).not.toBeChecked()
        expect(screen.getAllByRole('slider').at(-1)).not.toHaveAttribute(
          'data-disabled'
        )
      })

      const mobileSlider = screen.getAllByRole('slider').at(-1)
      mobileSlider?.focus()
      await user.keyboard('{ArrowRight}')

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('patch_preferences', {
          patch: { mobile_zoom_level: 100 },
        })
      })
    })
  })

  describe('AppearancePane window vibrancy', () => {
    it('keeps the switch off and skips runtime vibrancy when persistence fails', async () => {
      const { invoke } = await import('@/lib/transport')
      const { toast } = await import('sonner')
      vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'load_preferences') {
          return { ...defaultPreferences, window_vibrancy: false }
        }
        if (command === 'patch_preferences') {
          throw new Error('Save failed')
        }
        if (command === 'set_window_vibrancy') return undefined
        throw new Error(`Unexpected command ${command}`)
      })

      const user = userEvent.setup()
      render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AppearancePane)
        )
      )

      const switchEl = await screen.findByRole('switch')
      expect(switchEl).toHaveAttribute('aria-checked', 'false')

      await user.click(switchEl)

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('patch_preferences', {
          patch: { window_vibrancy: true },
        })
      })
      expect(invoke).not.toHaveBeenCalledWith('set_window_vibrancy', {
        enabled: true,
      })
      expect(
        queryClient.getQueryData<AppPreferences>(
          preferencesQueryKeys.preferences()
        )?.window_vibrancy
      ).toBe(false)
      expect(switchEl).toHaveAttribute('aria-checked', 'false')
      expect(toast.error).toHaveBeenCalledWith('Failed to save preferences', {
        description: 'Save failed',
      })
    })
  })
})
