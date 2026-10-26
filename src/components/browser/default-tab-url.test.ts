import { describe, expect, it } from 'vitest'
import {
  normalizeBrowserDefaultHost,
  resolveDefaultTabUrl,
  resolvePortHost,
  resolvePortUrl,
} from './default-tab-url'

describe('resolveDefaultTabUrl', () => {
  it('defaults configured ports to localhost', () => {
    expect(resolveDefaultTabUrl([{ port: 8000, label: 'App' }])).toBe(
      'http://localhost:8000'
    )
  })

  it('uses a configured host when present', () => {
    expect(
      resolveDefaultTabUrl([{ port: 8000, label: 'App', host: '192.168.1.42' }])
    ).toBe('http://192.168.1.42:8000')
  })

  it('uses the server hostname when the port has no host', () => {
    expect(
      resolveDefaultTabUrl([{ port: 8000, label: 'App' }], 'dev.example.com')
    ).toBe('http://dev.example.com:8000')
  })

  it('lets a jean.json host win over the server hostname', () => {
    expect(
      resolvePortUrl(
        { port: 8000, label: 'App', host: '10.0.0.8' },
        'dev.example.com'
      )
    ).toBe('http://10.0.0.8:8000')
  })

  it('keeps a loopback server hostname so remote preview forwarding still applies', () => {
    expect(resolvePortUrl({ port: 8000, label: 'App' }, '127.0.0.1')).toBe(
      'http://127.0.0.1:8000'
    )
    expect(resolvePortUrl({ port: 8000, label: 'App' }, '::1')).toBe(
      'http://[::1]:8000'
    )
    expect(resolvePortHost({ host: 'localhost' }, 'dev.example.com')).toBe(
      'localhost'
    )
  })

  it('uses a non-loopback server hostname as written', () => {
    expect(
      resolvePortUrl({ port: 5173, label: 'Vite' }, ' 100.110.76.47 ')
    ).toBe('http://100.110.76.47:5173')
  })

  it('treats a blank server hostname as localhost', () => {
    expect(resolveDefaultTabUrl([{ port: 3000, label: 'API' }], '   ')).toBe(
      'http://localhost:3000'
    )
    expect(resolveDefaultTabUrl([{ port: 3000, label: 'API' }], null)).toBe(
      'http://localhost:3000'
    )
  })
})

describe('normalizeBrowserDefaultHost', () => {
  it('clears blank values and canonicalizes hosts', () => {
    expect(normalizeBrowserDefaultHost('  ')).toEqual({ ok: true, host: null })
    expect(normalizeBrowserDefaultHost(' LocalHost ')).toEqual({
      ok: true,
      host: 'localhost',
    })
    expect(normalizeBrowserDefaultHost('[::1]')).toEqual({
      ok: true,
      host: '::1',
    })
    expect(normalizeBrowserDefaultHost('Dev.Example.COM')).toEqual({
      ok: true,
      host: 'dev.example.com',
    })
  })

  it('rejects schemes and ports', () => {
    expect(normalizeBrowserDefaultHost('http://dev.example.com').ok).toBe(false)
    expect(normalizeBrowserDefaultHost('dev.example.com:3000').ok).toBe(false)
  })
})
