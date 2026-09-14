import { describe, expect, it } from 'vitest'
import {
  isCoreProtocolCompatible,
  normalizeServerCompatibility,
} from './server-capabilities'

describe('server compatibility', () => {
  it('normalizes legacy server capabilities', () => {
    expect(
      normalizeServerCompatibility({
        schemaVersion: 1,
        appVersion: '0.1.74',
        magicPrompts: [],
      })
    ).toMatchObject({
      apiProtocol: 1,
      apiProtocolMin: 1,
      capabilities: {},
      featureSurfaces: [],
    })
  })

  it('detects an incompatible protocol range', () => {
    expect(
      isCoreProtocolCompatible({ apiProtocol: 2, apiProtocolMin: 2 }, 1)
    ).toBe(false)
  })

  it('accepts a protocol inside the server range', () => {
    expect(
      isCoreProtocolCompatible({ apiProtocol: 3, apiProtocolMin: 1 }, 2)
    ).toBe(true)
  })
})
