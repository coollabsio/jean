/**
 * AI CLI types
 *
 * Common types for AI CLI provider abstraction.
 */

/** Available AI CLI providers */
export type AiCliProvider = 'claude' | 'gemini' | 'codex'

/** AI CLI provider display information */
export const aiProviderOptions: {
  value: AiCliProvider
  label: string
  description: string
}[] = [
  {
    value: 'claude',
    label: 'Anthropic',
    description: 'Claude Code CLI from Anthropic',
  },
  {
    value: 'gemini',
    label: 'Google',
    description: 'Gemini CLI from Google',
  },
  {
    value: 'codex',
    label: 'OpenAI',
    description: 'Codex CLI from OpenAI',
  },
]

/** Status of an AI CLI installation */
export interface AiCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

/** Authentication status for an AI CLI */
export interface AiCliAuthStatus {
  authenticated: boolean
  error: string | null
}
