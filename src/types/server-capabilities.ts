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
  featureSurfaces?: FeatureSurfaceManifestEntry[]
  magicPrompts: MagicPromptCapability[]
}

export interface FeatureSurfaceManifestEntry {
  id: string
  label: string
  entryUrl: string
  featureVersion: number
  bridgeVersion: number
  permissions: string[]
}

export type ServerCapability = Record<string, number>

export interface ServerCompatibility {
  apiProtocol: number
  apiProtocolMin: number
  capabilities: ServerCapability
  featureSurfaces: FeatureSurfaceManifestEntry[]
}
