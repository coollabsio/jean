/**
 * Runtime HTTP endpoint for an SSH-tunnel profile.
 *
 * The persisted profile URL is a placeholder. File and upload helpers read
 * this map so they never target that placeholder.
 */

export interface SshTransportEndpoint {
  url: string
  token: string
}

const endpoints = new Map<string, SshTransportEndpoint>()

export function setSshTransportEndpoint(
  id: string,
  endpoint: SshTransportEndpoint | null
): void {
  if (!endpoint) {
    endpoints.delete(id)
    return
  }
  endpoints.set(id, endpoint)
}

export function getSshTransportEndpoint(
  id: string
): SshTransportEndpoint | null {
  return endpoints.get(id) ?? null
}

export function clearSshTransportEndpoints(): void {
  endpoints.clear()
}
