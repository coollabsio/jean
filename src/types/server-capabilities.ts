export interface MagicPromptCapability {
  id: string
  label: string
  defaultPrompt: string
}

export interface ServerCapabilitiesEnvelope {
  schemaVersion: number
  appVersion: string
  magicPrompts: MagicPromptCapability[]
}
