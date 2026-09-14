import { describe, expect, it } from 'vitest'
import {
  validateExternalFeatureUrl,
  validateFeatureBridgeRequest,
  validateFeatureManifest,
} from './feature-surface-bridge'

const surface = {
  id: 'server-info',
  label: 'Server information',
  entryUrl: '/api/features/server-info',
  featureVersion: 1,
  bridgeVersion: 1,
  permissions: ['clipboard.write'],
}

describe('feature surface security', () => {
  it('accepts only compatible same-origin manifests', () => {
    expect(validateFeatureManifest(surface, 'https://jean.test')).toBe(
      'https://jean.test/api/features/server-info'
    )
    expect(
      validateFeatureManifest(
        { ...surface, entryUrl: 'https://evil.test/feature' },
        'https://jean.test'
      )
    ).toBeNull()
    expect(
      validateFeatureManifest(
        { ...surface, bridgeVersion: 2 },
        'https://jean.test'
      )
    ).toBeNull()
  })

  it('rejects wrong channels and undeclared permissions', () => {
    const request = {
      type: 'jean:bridge' as const,
      channel: 'secret',
      requestId: 'one',
      permission: 'clipboard.write' as const,
      payload: { text: 'Jean' },
    }
    expect(validateFeatureBridgeRequest(request, surface, 'secret')).toEqual(
      request
    )
    expect(
      validateFeatureBridgeRequest(
        { ...request, channel: 'wrong' },
        surface,
        'secret'
      )
    ).toBeNull()
    expect(
      validateFeatureBridgeRequest(
        { ...request, permission: 'notification.show' },
        surface,
        'secret'
      )
    ).toBeNull()
  })

  it('permits only HTTPS external URLs', () => {
    expect(validateExternalFeatureUrl('https://jean.app/docs')).toBe(
      'https://jean.app/docs'
    )
    expect(validateExternalFeatureUrl('file:///etc/passwd')).toBeNull()
  })
})
