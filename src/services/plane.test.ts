import { describe, expect, it } from 'vitest'
import { hasPlaneAccess } from './plane'

describe('hasPlaneAccess', () => {
  it('needs both an API key and a workspace slug', () => {
    expect(hasPlaneAccess(undefined, { plane_api_key: 'k' })).toBe(false)
    expect(
      hasPlaneAccess({ plane: { api_key: 'k' } }, { plane_api_key: null })
    ).toBe(false)
    expect(
      hasPlaneAccess({ plane: { workspace_slug: 'acme' } }, undefined)
    ).toBe(false)
  })

  it('combines project and global settings', () => {
    expect(
      hasPlaneAccess(
        { plane: { workspace_slug: 'acme' } },
        { plane_api_key: 'k' }
      )
    ).toBe(true)
    expect(
      hasPlaneAccess(
        { plane: { api_key: 'k' } },
        { plane_workspace_slug: 'acme' }
      )
    ).toBe(true)
  })

  it('accepts a redacted global key from a remote server', () => {
    expect(
      hasPlaneAccess(
        { plane: null },
        { plane_api_key_configured: true, plane_workspace_slug: 'acme' }
      )
    ).toBe(true)
  })
})
