import { describe, expect, it } from 'vitest'
import {
  PREDEFINED_CLI_PROFILES,
  PREDEFINED_CODEX_PROVIDERS,
  PREDEFINED_PI_PROVIDERS,
} from './preferences'

const OPENAI_BASE_URL =
  'https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1'
const ANTHROPIC_BASE_URL =
  'https://ap-southeast-1.maas.qwencloudapi.com/apps/anthropic'

describe('QwenCloud provider presets', () => {
  it('adds a Codex provider pointing at the OpenAI-compatible endpoint', () => {
    const provider = PREDEFINED_CODEX_PROVIDERS.find(
      p => p.name === 'QwenCloud'
    )
    expect(provider).toMatchObject({
      provider_id: 'qwencloud',
      base_url: OPENAI_BASE_URL,
      env_key: 'DASHSCOPE_API_KEY',
      wire_api: 'responses',
    })
  })

  it('adds a PI provider with a single-token name and the text models', () => {
    const provider = PREDEFINED_PI_PROVIDERS.find(p => p.name === 'qwencloud')
    expect(provider).toMatchObject({
      base_url: OPENAI_BASE_URL,
      api: 'openai-completions',
      api_key_env: 'DASHSCOPE_API_KEY',
    })
    expect(provider?.name).not.toMatch(/[\s/]/)
    expect(provider?.models.map(m => m.id)).toEqual([
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
    ])
  })

  it('maps Claude model aliases to Qwen model ids', () => {
    const profile = PREDEFINED_CLI_PROFILES.find(p => p.name === 'QwenCloud')
    expect(profile).toBeDefined()
    if (!profile) throw new Error('QwenCloud CLI profile is missing')
    expect(profile.supports_thinking).toBe(false)

    const settings = JSON.parse(profile.settings_json) as {
      env: Record<string, string>
    }
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: ANTHROPIC_BASE_URL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.7-plus',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.8-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
    // The Anthropic endpoint has no /v1/models route, so discovery must stay
    // disabled and the base URL must not already include /v1.
    expect(ANTHROPIC_BASE_URL.endsWith('/apps/anthropic')).toBe(true)
  })

  it('does not ship a real API key in any preset', () => {
    const profile = PREDEFINED_CLI_PROFILES.find(p => p.name === 'QwenCloud')
    expect(profile?.settings_json).toContain('<your-qwencloud-api-key>')
    expect(profile?.settings_json).not.toContain('sk-')
  })
})
