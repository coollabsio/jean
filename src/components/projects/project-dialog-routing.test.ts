import { describe, expect, it } from 'vitest'
import { shouldUseDirectoryBrowser } from './project-dialog-routing'

describe('shouldUseDirectoryBrowser', () => {
  it('uses the in-app browser for local macOS folder selection', () => {
    expect(
      shouldUseDirectoryBrowser({
        isLocalBackend: true,
        isClientMacOS: true,
        isLocalTarget: true,
      })
    ).toBe(true)
  })

  it('keeps the native picker for a local non-macOS target', () => {
    expect(
      shouldUseDirectoryBrowser({
        isLocalBackend: true,
        isClientMacOS: false,
        isLocalTarget: true,
      })
    ).toBe(false)
  })

  it('uses the in-app browser for remote backends and targets', () => {
    expect(
      shouldUseDirectoryBrowser({
        isLocalBackend: false,
        isClientMacOS: false,
        isLocalTarget: true,
      })
    ).toBe(true)
    expect(
      shouldUseDirectoryBrowser({
        isLocalBackend: true,
        isClientMacOS: false,
        isLocalTarget: false,
      })
    ).toBe(true)
  })
})
