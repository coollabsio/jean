import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  bareCommandForBackend,
  isBareCliCommand,
  preferResolvedCliCommand,
  resolveBackendCliPath,
} from './cli-binary'

const invokeMock = vi.hoisted(() => vi.fn())
const hasBackendTransportMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/environment', () => ({
  hasBackendTransport: hasBackendTransportMock,
}))

describe('cli-binary helpers', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    hasBackendTransportMock.mockReturnValue(true)
  })

  it('detects bare vs path-like commands', () => {
    expect(isBareCliCommand('grok')).toBe(true)
    expect(isBareCliCommand('codex')).toBe(true)
    expect(isBareCliCommand('')).toBe(true)
    expect(isBareCliCommand(null)).toBe(true)
    expect(
      isBareCliCommand(
        '/home/u/.local/share/com.jean.desktop/grok-cli/node_modules/.bin/grok'
      )
    ).toBe(false)
    expect(isBareCliCommand('C:\\Program Files\\grok\\grok.exe')).toBe(false)
    expect(isBareCliCommand('./local-grok')).toBe(false)
  })

  it('prefers resolved path when command is bare', () => {
    const managed =
      '/home/u/.local/share/com.jean.desktop/grok-cli/node_modules/.bin/grok'
    expect(preferResolvedCliCommand('grok', 'grok', managed)).toBe(managed)
    expect(preferResolvedCliCommand(undefined, 'grok', managed)).toBe(managed)
    expect(preferResolvedCliCommand('', 'grok', managed)).toBe(managed)
  })

  it('keeps absolute path commands even when resolved is set', () => {
    expect(
      preferResolvedCliCommand(
        '/usr/bin/grok',
        'grok',
        '/jean/managed/grok'
      )
    ).toBe('/usr/bin/grok')
  })

  it('falls back to bare name when nothing is resolved', () => {
    expect(preferResolvedCliCommand(undefined, 'grok', null)).toBe('grok')
    expect(bareCommandForBackend('grok')).toBe('grok')
    expect(bareCommandForBackend('cursor')).toBe('cursor-agent')
  })

  it('resolves backend path from check_*_cli_installed', async () => {
    invokeMock.mockResolvedValue({
      installed: true,
      path: '/jean/managed/grok',
    })
    await expect(resolveBackendCliPath('grok')).resolves.toBe(
      '/jean/managed/grok'
    )
    expect(invokeMock).toHaveBeenCalledWith('check_grok_cli_installed')
  })

  it('returns null when CLI is not installed', async () => {
    invokeMock.mockResolvedValue({ installed: false, path: null })
    await expect(resolveBackendCliPath('grok')).resolves.toBeNull()
  })
})
