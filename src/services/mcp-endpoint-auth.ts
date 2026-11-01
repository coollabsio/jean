export type McpEndpointAuth = 'default' | 'bearer' | 'api-key'

/** Build static credentials for servers that accept tokens without OAuth. */
export function buildMcpEndpointHeaders(
  rawHeaders: string,
  auth: McpEndpointAuth,
  credential: string,
  apiKeyHeader: string
): Record<string, string> {
  let headers: Record<string, string> = {}
  if (rawHeaders.trim()) {
    const value: unknown = JSON.parse(rawHeaders)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some(v => typeof v !== 'string')
    ) {
      throw new Error('Headers must be a JSON object with string values')
    }
    headers = value as Record<string, string>
  }
  if (auth !== 'default') {
    const token = credential.trim()
    if (!token) throw new Error('Enter a token or API key')
    const name = auth === 'bearer' ? 'Authorization' : apiKeyHeader.trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error('Enter a valid API key header name')
    }
    if (
      Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())
    ) {
      throw new Error(
        'Remove the authentication header from Headers (JSON) before using token authentication'
      )
    }
    headers[name] = auth === 'bearer' ? `Bearer ${token}` : token
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) {
      throw new Error('Headers contain an invalid name or value')
    }
  }
  return headers
}
