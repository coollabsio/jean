export interface MagicPromptCapability {
  id: string
  label: string
  defaultPrompt: string
}

export interface ServerCapabilitiesEnvelope {
  schemaVersion: number
  appVersion: string
  apiProtocol?: number
  apiProtocolMin?: number
  capabilities?: Record<string, number>
  magicPrompts: MagicPromptCapability[]
}

export type ServerCapability = Record<string, number>

export interface ServerCompatibility {
  apiProtocol: number
  apiProtocolMin: number
  capabilities: ServerCapability
}
