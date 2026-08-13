import type { AppPreferences } from './preferences'

export interface ServerPreferencesEnvelope {
  schemaVersion: number
  revision: string
  preferences: Partial<AppPreferences> & {
    linear_api_key_configured?: boolean
    sentry_auth_token_configured?: boolean
    http_server_token_configured?: boolean
  }
}
