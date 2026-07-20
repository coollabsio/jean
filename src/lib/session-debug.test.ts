import { describe, expect, it } from 'vitest'
import {
  formatSessionDebugDetails,
  resolveSessionDebugDetails,
} from './session-debug'
import type { AppPreferences } from '@/types/preferences'
import type { Project } from '@/types/projects'
import type { Session, SessionDebugInfo } from '@/types/chat'

const preferences: AppPreferences = {
  selected_model: 'sonnet',
  selected_codex_model: 'gpt-5.4-fast',
  selected_opencode_model: 'opencode/openai/gpt-5.3',
  default_provider: 'openrouter',
  default_backend: 'claude',
} as AppPreferences

const project: Project = {
  id: 'project-1',
  name: 'Jean',
  path: '/tmp/jean',
  default_branch: 'main',
  added_at: 0,
  order: 0,
  default_provider: 'project-provider',
  default_backend: 'codex',
}

const debugInfo: SessionDebugInfo = {
  app_data_dir: '/tmp/app',
  sessions_file: '/tmp/sessions.json',
  runs_dir: '/tmp/runs',
  manifest_file: '/tmp/manifest.json',
  claude_jsonl_file: '/tmp/claude.jsonl',
  claude_session_id: 'claude-session',
  run_log_files: [],
  total_usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
}

describe('resolveSessionDebugDetails', () => {
  it('prefers persisted session values over empty zustand state', () => {
    const session: Session = {
      id: 'session-1',
      name: 'Session 1',
      order: 0,
      created_at: 0,
      updated_at: 0,
      messages: [],
      backend: 'claude',
      selected_model: 'opus',
      selected_provider: 'custom-profile',
    }

    const result = resolveSessionDebugDetails({
      session,
      selectedBackend: 'codex',
      selectedModel: 'gpt-5.4',
      selectedProvider: null,
      project,
      preferences,
      installedBackends: ['claude', 'codex', 'opencode'],
    })

    expect(result).toEqual({
      selectedBackend: 'claude',
      selectedModel: 'opus',
      providerDisplay: 'custom-profile',
    })
  })

  it('uses project or global defaults when session values are missing', () => {
    const result = resolveSessionDebugDetails({
      project,
      preferences,
      installedBackends: ['claude', 'codex'],
    })

    expect(result).toEqual({
      selectedBackend: 'codex',
      selectedModel: 'gpt-5.4-fast',
      providerDisplay: 'OpenAI',
    })
  })

  it('lets model imply the backend for codex and opencode models', () => {
    expect(
      resolveSessionDebugDetails({
        selectedBackend: 'claude',
        selectedModel: 'gpt-5.4',
        preferences,
        installedBackends: ['claude', 'codex'],
      }).selectedBackend
    ).toBe('codex')

    const opencodeResult = resolveSessionDebugDetails({
      selectedBackend: 'claude',
      selectedModel: 'opencode/openrouter/anthropic/claude-3.5-haiku',
      preferences,
      installedBackends: ['claude', 'opencode'],
    })

    expect(opencodeResult.selectedBackend).toBe('opencode')
    expect(opencodeResult.providerDisplay).toBe('OpenCode')
  })

  it('lets PI provider/model ids imply the PI backend even when provider contains codex', () => {
    const result = resolveSessionDebugDetails({
      selectedBackend: 'codex',
      selectedModel: 'pi/openai-codex/gpt-5.5',
      preferences,
      installedBackends: ['codex', 'pi'],
    })

    expect(result.selectedBackend).toBe('pi')
  })

  it('reports xAI as the provider for Grok sessions', () => {
    const session = {
      id: 'session-grok',
      name: 'Grok session',
      order: 0,
      created_at: 0,
      updated_at: 0,
      messages: [],
      backend: 'grok',
      selected_model: 'grok/grok-4.5',
    } as Session

    expect(
      resolveSessionDebugDetails({
        session,
        preferences,
        installedBackends: ['claude', 'grok'],
      }).providerDisplay
    ).toBe('xAI')
  })
})

describe('formatSessionDebugDetails', () => {
  it('includes backend in copied debug text', () => {
    const text = formatSessionDebugDetails({
      sessionId: 'session-1',
      selectedBackend: 'codex',
      selectedModel: 'gpt-5.4',
      providerDisplay: 'OpenAI',
      debugInfo,
    })

    expect(text).toContain('backend: codex')
    expect(text).toContain('model: gpt-5.4 / provider: OpenAI')
  })
})
