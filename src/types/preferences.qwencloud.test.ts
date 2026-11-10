import { describe, expect, it } from 'vitest'
import {
  PREDEFINED_CLI_PROFILES,
  PREDEFINED_CODEX_PROVIDERS,
  PREDEFINED_PI_PROVIDERS,
  QWENCLOUD_API_KEY_ENV,
  QWENCLOUD_DEFAULT_REGION_ID,
  QWENCLOUD_ENDPOINTS,
  qwenCloudAnthropicBaseUrl,
  qwenCloudApiKeyEnv,
  qwenCloudEndpointById,
  qwenCloudOpenAiBaseUrl,
  qwenCloudRegionFromValue,
  withQwenCloudRegion,
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

describe('QwenCloud regions and billing modes', () => {
  it('offers six pay-as-you-go regions plus the Token Plan endpoint', () => {
    expect(QWENCLOUD_ENDPOINTS.map(endpoint => endpoint.id)).toEqual([
      'ap-southeast-1',
      'cn-beijing',
      'eu-central-1',
      'cn-hongkong',
      'ap-northeast-1',
      'us-east-1',
      'token-plan',
    ])
    expect(QWENCLOUD_DEFAULT_REGION_ID).toBe('ap-southeast-1')
    expect(
      QWENCLOUD_ENDPOINTS.filter(e => e.mode === 'pay-as-you-go')
    ).toHaveLength(6)
    expect(
      QWENCLOUD_ENDPOINTS.filter(e => e.mode === 'token-plan')
    ).toHaveLength(1)
  })

  it('keeps a separate API key env var for each billing mode', () => {
    expect(QWENCLOUD_API_KEY_ENV).toEqual({
      'pay-as-you-go': 'DASHSCOPE_API_KEY',
      'token-plan': 'QWENCLOUD_TOKEN_PLAN_API_KEY',
    })
    expect(qwenCloudApiKeyEnv('ap-southeast-1')).toBe('DASHSCOPE_API_KEY')
    expect(qwenCloudApiKeyEnv('cn-beijing')).toBe('DASHSCOPE_API_KEY')
    expect(qwenCloudApiKeyEnv('token-plan')).toBe(
      'QWENCLOUD_TOKEN_PLAN_API_KEY'
    )
    expect(qwenCloudOpenAiBaseUrl('token-plan')).toBe(
      'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1'
    )
    expect(qwenCloudAnthropicBaseUrl('token-plan')).toBe(
      'https://token-plan.maas.qwencloudapi.com/apps/anthropic'
    )
  })

  it('builds both protocol URLs for every endpoint', () => {
    for (const endpoint of QWENCLOUD_ENDPOINTS) {
      expect(qwenCloudOpenAiBaseUrl(endpoint.id)).toBe(
        `https://${endpoint.domain}/compatible-mode/v1`
      )
      expect(qwenCloudAnthropicBaseUrl(endpoint.id)).toBe(
        `https://${endpoint.domain}/apps/anthropic`
      )
    }
  })

  it('falls back to Singapore for an unknown endpoint', () => {
    expect(qwenCloudEndpointById('not-a-region').id).toBe('ap-southeast-1')
    expect(qwenCloudOpenAiBaseUrl('not-a-region')).toBe(
      qwenCloudOpenAiBaseUrl('ap-southeast-1')
    )
  })

  it('detects the region from a URL, a settings JSON blob, and the bare alias', () => {
    expect(qwenCloudRegionFromValue(qwenCloudOpenAiBaseUrl('cn-beijing'))).toBe(
      'cn-beijing'
    )
    expect(
      qwenCloudRegionFromValue(
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: qwenCloudAnthropicBaseUrl('us-east-1') },
        })
      )
    ).toBe('us-east-1')
    expect(qwenCloudRegionFromValue(qwenCloudOpenAiBaseUrl('token-plan'))).toBe(
      'token-plan'
    )
    expect(
      qwenCloudRegionFromValue(
        'https://maas.qwencloudapi.com/compatible-mode/v1'
      )
    ).toBe('ap-southeast-1')
    expect(qwenCloudRegionFromValue('https://openrouter.ai/api/v1')).toBeNull()
  })

  it('rewrites every QwenCloud domain without corrupting settings JSON', () => {
    const profile = PREDEFINED_CLI_PROFILES.find(p => p.name === 'QwenCloud')
    if (!profile) throw new Error('QwenCloud CLI profile is missing')
    const rewritten = withQwenCloudRegion(profile.settings_json, 'cn-beijing')
    const settings = JSON.parse(rewritten) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(
      'https://cn-beijing.maas.qwencloudapi.com/apps/anthropic'
    )
    expect(rewritten).not.toContain('ap-southeast-1')
    expect(
      withQwenCloudRegion(qwenCloudOpenAiBaseUrl('eu-central-1'), 'token-plan')
    ).toBe('https://token-plan.maas.qwencloudapi.com/compatible-mode/v1')
  })
})
