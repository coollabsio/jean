import type { Backend } from '@/types/chat'
import type { PrDisplayStatus } from '@/types/pr-status'

export function getPrStatusDisplay(status: PrDisplayStatus): {
  label: string
  className: string
} {
  switch (status) {
    case 'draft':
      return { label: 'Draft', className: 'text-muted-foreground' }
    case 'open':
      return { label: 'Open', className: 'text-green-600 dark:text-green-500' }
    case 'merged':
      return {
        label: 'Merged',
        className: 'text-purple-600 dark:text-purple-400',
      }
    case 'closed':
      return { label: 'Closed', className: 'text-red-600 dark:text-red-400' }
    default:
      return { label: 'Unknown', className: 'text-muted-foreground' }
  }
}

export function getProviderDisplayName(
  selectedProvider: string | null
): string {
  return !selectedProvider || selectedProvider === '__anthropic__'
    ? 'Anthropic'
    : selectedProvider
}

export function getSessionProviderDisplayName(
  selectedBackend: Backend | undefined,
  selectedProvider: string | null | undefined
): string {
  if (selectedBackend === 'codex') return 'OpenAI'
  if (selectedBackend === 'opencode') return 'OpenCode'
  return getProviderDisplayName(selectedProvider ?? null)
}

function formatProviderName(provider: string): string {
  const knownProviders: Record<string, string> = {
    anthropic: 'Anthropic',
    opencode: 'OpenCode',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    google: 'Google',
    deepseek: 'DeepSeek',
    'meta-llama': 'Meta',
    mistralai: 'Mistral',
    qwen: 'Qwen',
    moonshotai: 'Moonshot AI',
    minimax: 'MiniMax',
    xai: 'xAI',
    'black-forest-labs': 'Black Forest Labs',
    cohere: 'Cohere',
    nvidia: 'NVIDIA',
    arcee: 'Arcee AI',
    'arcee-ai': 'Arcee AI',
    featherless: 'Featherless',
    cognitivecomputations: 'Cognitive Computations',
  }
  return (
    knownProviders[provider.toLowerCase()] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  )
}

function formatModelToken(token: string): string {
  const knownTokens: Record<string, string> = {
    claude: 'Claude',
    gpt: 'GPT',
    glm: 'GLM',
    kimi: 'Kimi',
    codex: 'Codex',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    opus: 'Opus',
    minimax: 'MiniMax',
    trinity: 'Trinity',
    latest: 'Latest',
    preview: 'Preview',
    turbo: 'Turbo',
    thinking: 'Thinking',
    flash: 'Flash',
    nano: 'Nano',
    mini: 'Mini',
    max: 'Max',
    large: 'Large',
    free: 'Free',
    pro: 'Pro',
  }

  const lower = token.toLowerCase()
  if (knownTokens[lower]) return knownTokens[lower]
  if (/^\d+(\.\d+)*$/.test(token)) return token
  if (/^[a-z]{1,3}$/i.test(token)) return token.toUpperCase()
  return token.charAt(0).toUpperCase() + token.slice(1)
}

export function formatOpencodeModelLabel(raw: string): string {
  const parts = raw.split('/')
  if (parts.length < 2) return raw

  let provider: string
  let modelPath: string

  if (parts[0] === 'openrouter' && parts.length >= 3) {
    // OpenRouter proxies models from other providers
    // Format: openrouter/anthropic/claude-3.5-haiku
    // Extract the actual provider and model path
    provider = parts[1] ?? ''
    modelPath = parts.slice(2).join('/')
  } else {
    provider = parts[0] ?? ''
    modelPath = parts.slice(1).join('/')
  }

  // Strip optional :qualifier suffix (e.g. ":free", ":exacto") and surface as badge
  const colonIdx = modelPath.lastIndexOf(':')
  const qualifier = colonIdx !== -1 ? modelPath.slice(colonIdx + 1) : null
  const modelName = colonIdx !== -1 ? modelPath.slice(0, colonIdx) : modelPath

  const rawTokens = modelName.split('-').filter(Boolean)
  const mergedTokens: string[] = []
  for (let i = 0; i < rawTokens.length; i++) {
    const current = rawTokens[i]
    if (!current) continue
    const next = rawTokens[i + 1]
    // Render version pairs like 4-5 -> 4.5, 3-7 -> 3.7
    if (/^\d$/.test(current) && /^\d$/.test(next ?? '')) {
      mergedTokens.push(`${current}.${next}`)
      i++
      continue
    }
    mergedTokens.push(current)
  }

  const modelLabel = mergedTokens
    .filter(Boolean)
    .map(formatModelToken)
    .join(' ')
  const qualifierSuffix = qualifier ? ` [${qualifier}]` : ''
  return `${modelLabel} (${formatProviderName(provider)})${qualifierSuffix}`
}
