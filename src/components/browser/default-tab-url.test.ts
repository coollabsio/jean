import { describe, expect, it } from 'vitest'
import {
  listBrowserPortChoices,
  normalizeBrowserDefaultHost,
  resolveDefaultTabUrl,
  resolveNewTabUrl,
  resolvePortHost,
  resolvePortOpenAction,
  resolvePortUrl,
  urlFromListenAddress,
} from './default-tab-url'

const ports = [
  { port: 3000, label: 'Web' },
  { port: 4000, label: 'API' },
  { port: 5000, label: 'Docs', host: '10.0.0.5' },
]

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

  it('keeps the initial tab on the first jean.json port', () => {
    expect(resolveDefaultTabUrl(ports)).toBe('http://localhost:3000')
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

describe('urlFromListenAddress', () => {
  it('maps wildcard binds to loopback', () => {
    expect(urlFromListenAddress('*:5173', 5173)).toBe('http://127.0.0.1:5173')
    expect(urlFromListenAddress('0.0.0.0:3000', 3000)).toBe(
      'http://127.0.0.1:3000'
    )
    expect(urlFromListenAddress('[::]:8080', 8080)).toBe(
      'http://127.0.0.1:8080'
    )
  })

  it('preserves a specific listen host', () => {
    expect(urlFromListenAddress('127.0.0.1:1420', 1420)).toBe(
      'http://127.0.0.1:1420'
    )
    expect(urlFromListenAddress('[::1]:3000', 3000)).toBe('http://[::1]:3000')
  })
})

describe('listBrowserPortChoices', () => {
  it('lists every configured port in order', () => {
    expect(listBrowserPortChoices(ports).map(choice => choice.url)).toEqual([
      'http://localhost:3000',
      'http://localhost:4000',
      'http://10.0.0.5:5000',
    ])
    expect(listBrowserPortChoices(ports).map(choice => choice.label)).toEqual([
      'Web (localhost:3000)',
      'API (localhost:4000)',
      'Docs (10.0.0.5:5000)',
    ])
  })

  it('uses the server hostname for ports that do not set one', () => {
    expect(
      listBrowserPortChoices(
        [
          { port: 3000, label: 'Web' },
          { port: 4000, label: 'API', host: '10.0.0.8' },
        ],
        undefined,
        'dev.example.com'
      ).map(choice => choice.url)
    ).toEqual(['http://dev.example.com:3000', 'http://10.0.0.8:4000'])
  })

  it('drops invalid and duplicate configured urls', () => {
    expect(
      listBrowserPortChoices([
        { port: 0, label: 'Bad' },
        { port: 8080, label: '  ' },
        { port: 8080, label: 'Again' },
      ]).map(choice => choice.label)
    ).toEqual(['localhost:8080'])
  })

  it('appends listening ports that jean.json does not already name', () => {
    const choices = listBrowserPortChoices(
      [{ port: 3000, label: 'Web' }],
      [
        {
          port: 5173,
          processName: 'vite',
          localAddress: '*:5173',
        },
        {
          port: 3000,
          processName: 'node',
          localAddress: '127.0.0.1:3000',
        },
        {
          port: 5173,
          processName: 'vite',
          localAddress: '[::1]:5173',
        },
      ]
    )

    expect(
      choices.map(choice => ({ source: choice.source, url: choice.url }))
    ).toEqual([
      { source: 'configured', url: 'http://localhost:3000' },
      { source: 'listening', url: 'http://127.0.0.1:5173' },
    ])
    expect(choices[1]?.label).toBe('vite (127.0.0.1:5173)')
  })
})

describe('resolveNewTabUrl', () => {
  it('leaves a single-port new tab blank', () => {
    expect(resolveNewTabUrl([{ port: 3000, label: 'Web' }], [])).toBeUndefined()
    expect(resolveNewTabUrl(undefined, [])).toBeUndefined()
    expect(resolveNewTabUrl([], ['http://localhost:3000'])).toBeUndefined()
  })

  it('opens the next configured port that is not already showing', () => {
    expect(resolveNewTabUrl(ports, [])).toBe('http://localhost:3000')
    expect(resolveNewTabUrl(ports, ['http://localhost:3000'])).toBe(
      'http://localhost:4000'
    )
    expect(
      resolveNewTabUrl(ports, [
        'http://localhost:3000/dashboard',
        'http://127.0.0.1:4000',
      ])
    ).toBe('http://10.0.0.5:5000')
  })

  it('opens the next port on the server hostname', () => {
    expect(
      resolveNewTabUrl(
        [
          { port: 3000, label: 'Web' },
          { port: 4000, label: 'API' },
        ],
        ['http://dev.example.com:3000'],
        'dev.example.com'
      )
    ).toBe('http://dev.example.com:4000')
  })

  it('stays blank once every configured port is open', () => {
    expect(
      resolveNewTabUrl(ports, [
        'http://localhost:3000',
        'http://localhost:4000',
        'http://10.0.0.5:5000/guide',
      ])
    ).toBeUndefined()
  })

  it('ignores blank tabs when choosing the next port', () => {
    expect(resolveNewTabUrl(ports, ['about:blank', 'data:text/html,x'])).toBe(
      'http://localhost:3000'
    )
  })
})

describe('resolvePortOpenAction', () => {
  const web = 'http://localhost:3000'
  const api = 'http://127.0.0.1:4000'

  it('navigates a blank tab in place', () => {
    expect(
      resolvePortOpenAction(web, [{ id: 'a', url: 'about:blank' }], 'a')
    ).toEqual({ type: 'navigate' })
    expect(
      resolvePortOpenAction(web, [{ id: 'a', url: 'data:text/html,hi' }], 'a')
    ).toEqual({ type: 'navigate' })
  })

  it('focuses a tab that already has that port', () => {
    expect(
      resolvePortOpenAction(
        'http://127.0.0.1:3000',
        [{ id: 'a', url: 'http://localhost:3000/app' }],
        null
      )
    ).toEqual({ type: 'focus', tabId: 'a' })
  })

  it('does nothing when the active tab is already that port', () => {
    expect(resolvePortOpenAction(web, [{ id: 'a', url: web }], 'a')).toEqual({
      type: 'noop',
    })
  })

  it('adds a tab when the active page is a different port', () => {
    expect(resolvePortOpenAction(api, [{ id: 'a', url: web }], 'a')).toEqual({
      type: 'add-tab',
    })
  })
})
