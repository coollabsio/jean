import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@/test/test-utils'
import { BrowserToolbar } from './BrowserToolbar'
import { isBlankTabUrl, useBrowserStore } from '@/store/browser-store'
import { useTerminalStore } from '@/store/terminal-store'
import type * as ProjectsService from '@/services/projects'
import type { PortEntry } from '@/services/projects'

const { usePortsMock, useTerminalListeningPortsMock } = vi.hoisted(() => ({
  usePortsMock: vi.fn(() => ({ data: undefined as PortEntry[] | undefined })),
  useTerminalListeningPortsMock: vi.fn(() => ({
    data: [] as ProjectsService.TerminalPortInfo[],
  })),
}))

vi.mock('@/services/projects', async importOriginal => {
  const actual = await importOriginal<typeof ProjectsService>()
  return {
    ...actual,
    usePorts: usePortsMock,
    useTerminalListeningPorts: useTerminalListeningPortsMock,
  }
})

const actionsMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  focus: vi.fn(),
  enableGrab: vi.fn(),
}))

vi.mock('@/hooks/useBrowserPane', () => ({
  useBrowserTabActions: () => actionsMock,
  browserBackend: {
    close: vi.fn(),
  },
}))

describe('BrowserToolbar grab control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionsMock.enableGrab.mockResolvedValue(undefined)
    actionsMock.navigate.mockResolvedValue(undefined)
    usePortsMock.mockReturnValue({ data: [] })
    useTerminalListeningPortsMock.mockReturnValue({ data: [] })
    useTerminalStore.setState({ terminals: {} })
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      sidePaneOpen: {},
      modalOpen: {},
      bottomPanelOpen: {},
    })
    useBrowserStore.getState().addTab('worktree-1', 'http://localhost:3000')
  })

  it('enables React Grab for the active tab when the Grab button is clicked', async () => {
    render(<BrowserToolbar worktreeId="worktree-1" />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Grab DOM element' })
    )

    expect(actionsMock.enableGrab).toHaveBeenCalledTimes(1)
  })

  it('explains a remote preview forward in the toolbar', () => {
    const tabId = useBrowserStore.getState().getTabs('worktree-1')[0]?.id
    if (!tabId) {
      throw new Error('expected a browser tab')
    }
    useBrowserStore.getState().updateTab(tabId, {
      previewNote:
        'Remote preview via SSH forward: build.example port 3000 → 127.0.0.1:3000.',
    })

    render(<BrowserToolbar worktreeId="worktree-1" />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Remote preview via SSH forward'
    )
  })
})

const multiPorts: PortEntry[] = [
  { port: 3000, label: 'Web' },
  { port: 4000, label: 'API' },
  { port: 5000, label: 'Docs', host: '10.0.0.5' },
]

function tabUrls(): string[] {
  return (useBrowserStore.getState().tabs['worktree-1'] ?? []).map(
    tab => tab.url
  )
}

describe('BrowserToolbar port picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionsMock.navigate.mockResolvedValue(undefined)
    usePortsMock.mockReturnValue({ data: [] })
    useTerminalListeningPortsMock.mockReturnValue({ data: [] })
    useTerminalStore.setState({ terminals: {} })
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      sidePaneOpen: {},
      modalOpen: {},
      bottomPanelOpen: {},
    })
    useBrowserStore.getState().addTab('worktree-1', 'http://localhost:3000')
  })

  it('opens the only port in one click and keeps the new-tab button blank', async () => {
    usePortsMock.mockReturnValue({
      data: [{ port: 3000, label: 'Web' }],
    })
    useBrowserStore.setState({ tabs: {}, activeTabIds: {} })
    useBrowserStore.getState().addTab('worktree-1')

    render(<BrowserToolbar worktreeId="worktree-1" />)

    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open Web (localhost:3000)' })
    )
    expect(actionsMock.navigate).toHaveBeenCalledWith('http://localhost:3000')
    expect(screen.queryByRole('menuitem')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'New tab' }))
    const urls = tabUrls()
    expect(urls).toHaveLength(2)
    expect(isBlankTabUrl(urls[1] ?? '')).toBe(true)
  })

  it('lists every jean.json port and opens one that is not already showing', async () => {
    usePortsMock.mockReturnValue({ data: multiPorts })
    render(<BrowserToolbar worktreeId="worktree-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Choose port' }))
    expect(
      document.querySelector('[data-browser-port-menu][data-state="open"]')
    ).not.toBeNull()
    expect(
      screen.getByRole('menuitem', { name: 'Web (localhost:3000)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'API (localhost:4000)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Docs (10.0.0.5:5000)' })
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Docs (10.0.0.5:5000)' })
    )
    expect(tabUrls()).toEqual(['http://localhost:3000', 'http://10.0.0.5:5000'])

    await userEvent.click(screen.getByRole('button', { name: 'Choose port' }))
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Web (localhost:3000)' })
    )
    expect(tabUrls()).toEqual(['http://localhost:3000', 'http://10.0.0.5:5000'])
    expect(useBrowserStore.getState().activeTabIds['worktree-1']).toBe(
      useBrowserStore.getState().tabs['worktree-1']?.[0]?.id
    )
  })

  it('starts an extra tab on the next configured port instead of a blank page', async () => {
    usePortsMock.mockReturnValue({ data: multiPorts })
    render(<BrowserToolbar worktreeId="worktree-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(tabUrls()).toEqual([
      'http://localhost:3000',
      'http://localhost:4000',
    ])
    expect(actionsMock.navigate).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(tabUrls()).toEqual([
      'http://localhost:3000',
      'http://localhost:4000',
      'http://10.0.0.5:5000',
    ])

    await userEvent.click(screen.getByRole('button', { name: 'New tab' }))
    const urls = tabUrls()
    expect(urls).toHaveLength(4)
    expect(isBlankTabUrl(urls[3] ?? '')).toBe(true)
  })

  it('fills a blank tab with the next port when other ports exist', async () => {
    usePortsMock.mockReturnValue({
      data: [
        { port: 3000, label: 'Web' },
        { port: 4000, label: 'API' },
      ],
    })
    useBrowserStore.setState({ tabs: {}, activeTabIds: {} })
    useBrowserStore.getState().addTab('worktree-1')

    render(<BrowserToolbar worktreeId="worktree-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'New tab' }))

    expect(actionsMock.navigate).toHaveBeenCalledWith('http://localhost:3000')
    expect(tabUrls()).toHaveLength(1)
  })

  it('uses the server preview hostname for configured ports', async () => {
    usePortsMock.mockReturnValue({
      data: [
        { port: 3000, label: 'Web' },
        { port: 4000, label: 'API' },
      ],
    })
    render(
      <BrowserToolbar
        worktreeId="worktree-1"
        serverDefaultHost="dev.example.com"
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Choose port' }))
    expect(
      screen.getByRole('menuitem', { name: 'Web (dev.example.com:3000)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'API (dev.example.com:4000)' })
    ).toBeInTheDocument()
  })

  it('offers this worktree’s listening ports and skips other worktrees', async () => {
    usePortsMock.mockReturnValue({
      data: [{ port: 3000, label: 'Web' }],
    })
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'term-1',
            worktreeId: 'worktree-1',
            command: 'bun dev',
            label: 'dev',
          },
        ],
      },
    })
    useTerminalListeningPortsMock.mockReturnValue({
      data: [
        {
          terminalId: 'term-1',
          port: 5173,
          processName: 'vite',
          localAddress: '127.0.0.1:5173',
        },
        {
          terminalId: 'term-other',
          port: 9090,
          processName: 'other',
          localAddress: '127.0.0.1:9090',
        },
      ],
    })

    render(<BrowserToolbar worktreeId="worktree-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose port' }))

    expect(
      screen.getByRole('menuitem', { name: 'Web (localhost:3000)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'vite (127.0.0.1:5173)' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /9090/ })).toBeNull()
  })
})
