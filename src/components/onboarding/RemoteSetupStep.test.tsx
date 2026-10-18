import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSetupStep } from './RemoteSetupStep'

const {
  addRemoteConnection,
  selectConnection,
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
  invoke,
  isNativeApp,
  listenLocal,
  markConnectionSwitch,
} = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(() => ({ id: 'remote-1' })),
  selectConnection: vi.fn(),
  fetchRemoteServerInfo: vi.fn(async () => ({
    ok: true,
    appVersion: '0.1.69',
    webBuildId: '0.1.69-test',
  })),
  warnRemoteVersionMismatch: vi.fn(() => false),
  invoke: vi.fn(),
  isNativeApp: vi.fn(() => true),
  listenLocal: vi.fn(
    async (
      _event: string,
      _handler: (event: { payload: { step: string; message: string } }) => void
    ) =>
      () => {
        // no-op unsubscribe
      }
  ),
  markConnectionSwitch: vi.fn(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  addRemoteConnection,
  markConnectionSwitch,
  parseOptionalSshPort: (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be an integer between 1 and 65535.')
    }
    return port
  },
  parseRemoteConnectionInput: (url: string, token: string) => {
    const parsed = new URL(url)
    const resolvedToken =
      token.trim() || parsed.searchParams.get('token')?.trim() || ''
    parsed.search = ''
    return {
      url: parsed.toString().replace(/\/$/, ''),
      token: resolvedToken,
    }
  },
  selectConnection,
}))

vi.mock('@/lib/remote-version', () => ({
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeApp(),
}))

vi.mock('@/lib/transport', () => ({
  invoke,
  listenLocal,
}))

const INSTALL_RESULT = {
  name: 'build-box',
  url: 'http://192.168.1.50:3456',
  token: 'tok-abc',
  alreadyInstalled: false,
  installMode: 'system',
  ready: true,
  log: 'ok',
}

const SSH_HOSTS = [
  { alias: 'devbox', hostName: '10.0.0.5', user: 'deploy', port: 2222 },
  { alias: 'plain', hostName: null, user: null, port: null },
]

/** Route mocked invoke calls by command name. */
function mockCommands(handlers: Record<string, (args?: unknown) => unknown>) {
  invoke.mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command]
    if (!handler) throw new Error(`Unexpected command: ${command}`)
    return handler(args)
  })
}

function fillSshTarget(user = 'ubuntu', host = '192.168.1.50') {
  fireEvent.change(screen.getByLabelText('SSH user'), {
    target: { value: user },
  })
  fireEvent.change(screen.getByLabelText('Host / IP'), {
    target: { value: host },
  })
}

function phaseState(phase: string) {
  return document
    .querySelector(`[data-phase="${phase}"]`)
    ?.getAttribute('data-state')
}

describe('RemoteSetupStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeApp.mockReturnValue(true)
    fetchRemoteServerInfo.mockResolvedValue({
      ok: true,
      appVersion: '0.1.69',
      webBuildId: '0.1.69-test',
    })
  })

  it('installs jean-server via SSH and connects', async () => {
    mockCommands({
      list_ssh_config_hosts: () => [],
      install_remote_jean_server: () => INSTALL_RESULT,
    })
    const onComplete = vi.fn()
    render(<RemoteSetupStep onComplete={onComplete} />)

    expect(
      screen.getByRole('tab', { name: /Install via SSH/i })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('SSH user'), {
      target: { value: 'ubuntu' },
    })
    fireEvent.change(screen.getByLabelText('Host / IP'), {
      target: { value: '192.168.1.50' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Install & Connect/i }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_remote_jean_server', {
        name: null,
        user: 'ubuntu',
        host: '192.168.1.50',
        sshPort: 22,
        jeanPort: 3456,
        userInstall: null,
      })
      expect(addRemoteConnection).toHaveBeenCalled()
      expect(selectConnection).not.toHaveBeenCalled()
      expect(onComplete).toHaveBeenCalledExactlyOnceWith('remote-1')
    })
  })

  it('connects with an existing Web Access URL', async () => {
    mockCommands({ list_ssh_config_hosts: () => [] })
    const onComplete = vi.fn()
    render(<RemoteSetupStep onComplete={onComplete} />)

    fireEvent.click(screen.getByRole('tab', { name: /Existing URL/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Build server' },
    })
    fireEvent.change(screen.getByLabelText('Web Access URL'), {
      target: { value: 'https://jean.example.com/?token=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => {
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: 'Build server',
        url: 'https://jean.example.com/?token=secret',
        token: '',
        sshUser: undefined,
        sshHost: undefined,
        sshPort: 22,
      })
      expect(selectConnection).not.toHaveBeenCalled()
      expect(onComplete).toHaveBeenCalledExactlyOnceWith('remote-1')
    })
  })

  it('fills the fields from an SSH config host', async () => {
    mockCommands({ list_ssh_config_hosts: () => SSH_HOSTS })
    render(<RemoteSetupStep onComplete={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'devbox' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByLabelText('SSH user')).toHaveValue('deploy')
    expect(screen.getByLabelText('Host / IP')).toHaveValue('devbox')
    expect(screen.getByLabelText('SSH port')).toHaveValue(2222)
    expect(screen.getByLabelText('Name')).toHaveValue('devbox')

    // A host without options keeps the typed user and resets the port.
    fireEvent.click(screen.getByRole('button', { name: 'plain' }))
    expect(screen.getByLabelText('SSH user')).toHaveValue('deploy')
    expect(screen.getByLabelText('Host / IP')).toHaveValue('plain')
    expect(screen.getByLabelText('SSH port')).toHaveValue(22)
    expect(screen.getByLabelText('Name')).toHaveValue('plain')
  })

  it('hides the SSH host picker outside the native app', () => {
    isNativeApp.mockReturnValue(false)
    render(<RemoteSetupStep onComplete={vi.fn()} />)
    expect(screen.queryByText('From SSH config')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('tests SSH and shows the remote system', async () => {
    mockCommands({
      list_ssh_config_hosts: () => [],
      test_ssh_connection: () => 'Linux x86_64\n',
    })
    render(<RemoteSetupStep onComplete={vi.fn()} />)

    fillSshTarget()
    fireEvent.click(screen.getByRole('button', { name: /Test SSH/i }))

    expect(
      await screen.findByText('Connected · Linux x86_64')
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('test_ssh_connection', {
      user: 'ubuntu',
      host: '192.168.1.50',
      sshPort: 22,
    })
  })

  it('shows a test SSH failure and retries', async () => {
    const testSsh = vi
      .fn()
      .mockRejectedValueOnce(
        'SSH command failed (exit 255): Permission denied (publickey).\nmore detail'
      )
      .mockResolvedValueOnce('Linux aarch64')
    mockCommands({
      list_ssh_config_hosts: () => [],
      test_ssh_connection: testSsh,
    })
    render(<RemoteSetupStep onComplete={vi.fn()} />)

    fillSshTarget()
    fireEvent.click(screen.getByRole('button', { name: /Test SSH/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'SSH command failed (exit 255): Permission denied (publickey).'
    )
    expect(alert).not.toHaveTextContent('more detail')

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(
      await screen.findByText('Connected · Linux aarch64')
    ).toBeInTheDocument()
    expect(testSsh).toHaveBeenCalledTimes(2)
    // Retry must not submit the install form.
    expect(invoke).not.toHaveBeenCalledWith(
      'install_remote_jean_server',
      expect.anything()
    )
  })

  it('updates install phases from progress events', async () => {
    let emit:
      | ((event: { payload: { step: string; message: string } }) => void)
      | undefined
    listenLocal.mockImplementation(async (_event, handler) => {
      emit = handler
      return () => {
        // no-op unsubscribe
      }
    })
    let finishInstall: (value: typeof INSTALL_RESULT) => void = () => {
      // replaced below
    }
    mockCommands({
      list_ssh_config_hosts: () => [],
      install_remote_jean_server: () =>
        new Promise(resolve => {
          finishInstall = resolve
        }),
    })
    const onComplete = vi.fn()
    render(<RemoteSetupStep onComplete={onComplete} />)

    fillSshTarget()
    fireEvent.click(screen.getByRole('button', { name: /Install & Connect/i }))

    await waitFor(() => expect(emit).toBeDefined())
    expect(phaseState('ssh')).toBe('active')
    expect(phaseState('probe')).toBe('pending')

    act(() => {
      emit?.({ payload: { step: 'probe', message: 'Checking…' } })
    })
    expect(phaseState('ssh')).toBe('done')
    expect(phaseState('probe')).toBe('active')

    // Existing server: install is skipped.
    act(() => {
      emit?.({
        payload: { step: 'health', message: 'Checking readiness (2/24)…' },
      })
    })
    expect(phaseState('install')).toBe('skipped')
    expect(phaseState('health')).toBe('active')
    expect(screen.getByText('Checking readiness (2/24)…')).toBeInTheDocument()

    act(() => {
      emit?.({ payload: { step: 'done', message: 'Ready.' } })
    })
    expect(phaseState('health')).toBe('done')
    expect(phaseState('done')).toBe('done')

    await act(async () => {
      finishInstall(INSTALL_RESULT)
    })
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledExactlyOnceWith('remote-1')
    )
  })

  it('marks the active phase failed and retries the install', async () => {
    let emit:
      | ((event: { payload: { step: string; message: string } }) => void)
      | undefined
    listenLocal.mockImplementation(async (_event, handler) => {
      emit = handler
      return () => {
        // no-op unsubscribe
      }
    })
    let failInstall: (reason: unknown) => void = () => {
      // replaced below
    }
    const install = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failInstall = reject
          })
      )
      .mockResolvedValueOnce(INSTALL_RESULT)
    mockCommands({
      list_ssh_config_hosts: () => [],
      install_remote_jean_server: install,
    })
    const onComplete = vi.fn()
    render(<RemoteSetupStep onComplete={onComplete} />)

    fillSshTarget()
    fireEvent.click(screen.getByRole('button', { name: /Install & Connect/i }))
    await waitFor(() => expect(emit).toBeDefined())
    act(() => {
      emit?.({ payload: { step: 'install', message: 'Installing…' } })
    })

    await act(async () => {
      failInstall('system install failed (exit 1): curl missing\n\nfull log')
    })

    expect(phaseState('install')).toBe('failed')
    expect(phaseState('probe')).toBe('skipped')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'system install failed (exit 1): curl missing'
    )

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledExactlyOnceWith('remote-1')
    )
    expect(install).toHaveBeenCalledTimes(2)
  })
})
