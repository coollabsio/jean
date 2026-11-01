import { describe, expect, it } from 'vitest'
import { buildMcpEndpointHeaders } from './mcp-endpoint-auth'

describe('MCP endpoint credentials', () => {
  it('keeps default login and existing custom headers', () => {
    expect(buildMcpEndpointHeaders('', 'default', 'ignored', '')).toEqual({})
    expect(
      buildMcpEndpointHeaders('{"X-Tenant":"one"}', 'default', '', '')
    ).toEqual({ 'X-Tenant': 'one' })
  })
  it('adds bearer credentials alongside unrelated headers', () => {
    expect(
      buildMcpEndpointHeaders('{"X-Tenant":"one"}', 'bearer', ' token ', '')
    ).toEqual({ 'X-Tenant': 'one', Authorization: 'Bearer token' })
  })
  it('uses the selected API key header without a bearer prefix', () => {
    expect(
      buildMcpEndpointHeaders('', 'api-key', 'secret', ' api-key ')
    ).toEqual({ 'api-key': 'secret' })
  })
  it('rejects ambiguous credentials without exposing them', () => {
    expect(() =>
      buildMcpEndpointHeaders(
        '{"authorization":"secret"}',
        'bearer',
        'token',
        ''
      )
    ).toThrow('Remove the authentication header')
    expect(() =>
      buildMcpEndpointHeaders('{"X-KEY":"secret"}', 'api-key', 'token', 'x-key')
    ).toThrow('Remove the authentication header')
  })
  it('rejects missing credentials and invalid HTTP headers', () => {
    for (const token of ['', ' ', 'secret\r\ninjected: value']) {
      expect(() => buildMcpEndpointHeaders('', 'bearer', token, '')).toThrow()
    }
    expect(() =>
      buildMcpEndpointHeaders('', 'api-key', 'secret', 'bad header')
    ).toThrow()
    expect(() =>
      buildMcpEndpointHeaders('{"X-Key":3}', 'default', '', '')
    ).toThrow()
    expect(() => buildMcpEndpointHeaders('[]', 'default', '', '')).toThrow()
    expect(() =>
      buildMcpEndpointHeaders('{"X-Key":"secret\\nvalue"}', 'default', '', '')
    ).toThrow()
  })
})
