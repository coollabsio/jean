import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Zap } from 'lucide-react'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import { MobileSettingsMenu } from './MobileSettingsMenu'
import * as platform from '@/lib/platform'

const usePortsMock = vi.fn(() => ({ data: [] as Array<{
  port: number
  label: string
  host?: string | null
}> }))
const useWorktreeMock = vi.fn(() => ({
  data: {
    id: 'worktree-1',
    path: '/repo/worktree',
    branch: 'feature',
    project_id: 'project-1',
    base_branch: 'main',
  },
}))

vi.mock('@/services/projects', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/projects')>()
  return {
    ...actual,
    useWorktree: useWorktreeMock as unknown as typeof actual.useWorktree,
    useProjects: () => ({
      data: [{ id: 'project-1', path: '/repo', name: 'app', default_branch: 'main' }],
    }),
    usePorts: usePortsMock as unknown as typeof actual.usePorts,
  }
})

vi.mock('@/services/github', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/github')>()
  return {
    ...actual,
    useGitHubPRs: () => ({ data: [] }),
  }
})

beforeEach(() => {
  usePortsMock.mockReturnValue({ data: [] })
  useWorktreeMock.mockReturnValue({
    data: {
      id: 'worktree-1',
      path: '/repo/worktree',
      branch: 'feature',
      project_id: 'project-1',
      base_branch: 'main',
    },
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

const baseProps = {
  isDisabled: false,
  selectedBackend: 'claude' as const,
  selectedProvider: null,
  backendModelLabel: 'Claude · Sonnet',
  backendModelLabelText: 'Claude · Sonnet',
  hasMultipleBackendModelChoices: true,
  selectedEffortLevel: 'medium' as const,
  selectedThinkingLevel: 'think' as const,
  useAdaptiveThinking: false,
  isCodex: false,
  customCliProfiles: [],
  onOpenBackendModelPicker: vi.fn(),
  handleProviderChange: vi.fn(),
  handleEffortLevelChange: vi.fn(),
  handleThinkingLevelChange: vi.fn(),
  loadedIssueContexts: [],
  loadedPRContexts: [],
  loadedSecurityContexts: [],
  loadedAdvisoryContexts: [],
  loadedLinearContexts: [],
  attachedSavedContexts: [],
  handleViewIssue: vi.fn(),
  handleViewPR: vi.fn(),
  handleViewSecurityAlert: vi.fn(),
  handleViewAdvisory: vi.fn(),
  handleViewLinear: vi.fn(),
  handleViewSavedContext: vi.fn(),
  availableMcpServers: [],
  enabledMcpServers: [],
  activeMcpCount: 0,
  onToggleMcpServer: vi.fn(),
}

describe('MobileSettingsMenu', () => {
  it('aligns the mobile Effort label with the other setting labels', async () => {
    const user = userEvent.setup()
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })

    try {
      render(<MobileSettingsMenu {...baseProps} useAdaptiveThinking />)

      await user.click(screen.getByRole('button', { name: /settings/i }))

      const effortItem = screen.getByText('Effort').closest('[role="menuitem"]')
      const effortIcon = effortItem?.querySelector('svg.lucide-brain')
      expect(effortIcon).not.toHaveClass('mr-2')
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      })
    }
  })

  it('hides model row chevron when there is only one backend/model choice', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        hasMultipleBackendModelChoices={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    const modelItem = screen.getByText('Model').closest('[role="menuitem"]')
    expect(modelItem?.querySelector('svg.lucide-chevron-right')).toBeNull()
  })

  it('shows MCP as a plain disabled row when no servers are configured', async () => {
    const user = userEvent.setup()

    render(<MobileSettingsMenu {...baseProps} availableMcpServers={[]} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    const mcpItem = screen.getByText('MCP').closest('[role="menuitem"]')
    const mcpIcon = mcpItem?.querySelector('svg.lucide-plug')
    expect(mcpItem).toHaveAttribute('aria-disabled', 'true')
    expect(mcpIcon).not.toHaveClass('mr-2')
    expect(mcpItem?.querySelector('svg.lucide-chevron-right')).toBeNull()
    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('opens mobile MCP servers in a screen-contained bottom sheet', async () => {
    const user = userEvent.setup()
    const onToggleMcpServer = vi.fn()
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })

    try {
      render(
        <MobileSettingsMenu
          {...baseProps}
          availableMcpServers={[
            {
              name: 'chrome_devtools',
              config: {},
              scope: 'user',
              disabled: false,
              backend: 'codex',
            },
            {
              name: 'jean',
              config: {},
              scope: 'project',
              disabled: false,
              backend: 'codex',
            },
          ]}
          onToggleMcpServer={onToggleMcpServer}
        />
      )

      await user.click(screen.getByRole('button', { name: /settings/i }))
      await user.click(screen.getByText('MCP'))

      const sheet = screen.getByRole('dialog', { name: 'Manage MCP servers' })
      expect(sheet).toHaveClass('max-h-[75svh]')
      await user.click(within(sheet).getByRole('button', { name: /jean/i }))
      expect(onToggleMcpServer).toHaveBeenCalledWith('codex:jean')
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      })
    }
  })

  it('opens backend/model picker via gear menu', async () => {
    const user = userEvent.setup()
    const onOpenBackendModelPicker = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        onOpenBackendModelPicker={onOpenBackendModelPicker}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()

    await user.click(screen.getByText('Model'))
    expect(onOpenBackendModelPicker).toHaveBeenCalledTimes(1)
  })

  it('shows and starts the jean.json run command from the settings menu', async () => {
    const user = userEvent.setup()
    const onRunCommand = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        worktreeId="worktree-1"
        runScripts={['bun run dev']}
        onRunCommand={onRunCommand}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(await screen.findByRole('menuitem', { name: /run/i }))

    expect(onRunCommand).toHaveBeenCalledWith('bun run dev')
  })

  it('opens package scripts in a bottom sheet after Run', async () => {
    const user = userEvent.setup()
    const onRunPackageScript = vi.fn()
    const onToggleFavoritePackageScript = vi.fn()
    const packageScript = {
      name: 'test:unit',
      command: 'bun',
      args: ['run', 'test:unit'],
    }
    const favoriteScript = {
      name: 'lint',
      command: 'bun',
      args: ['run', 'lint'],
    }

    render(
      <MobileSettingsMenu
        {...baseProps}
        worktreeId="worktree-1"
        runScripts={['bun run dev']}
        packageScripts={[packageScript, favoriteScript]}
        favoritePackageScripts={['lint']}
        onRunPackageScript={onRunPackageScript}
        onToggleFavoritePackageScript={onToggleFavoritePackageScript}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    const runItem = screen.getByRole('menuitem', { name: 'Run' })
    const scriptsItem = screen.getByRole('menuitem', { name: 'Scripts' })
    expect(
      runItem.compareDocumentPosition(scriptsItem) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await user.click(scriptsItem)
    const sheet = screen.getByRole('dialog', { name: 'Scripts' })
    expect(sheet).toHaveClass('max-h-[75svh]')
    const scriptButtons = within(sheet).getAllByRole('button', {
      name: /^(lint|test:unit)$/,
    })
    expect(scriptButtons.map(button => button.textContent)).toEqual([
      'lint',
      'test:unit',
    ])
    expect(
      within(sheet)
        .getByRole('button', { name: 'Unfavorite lint' })
        .querySelector('svg')
    ).toHaveClass('fill-yellow-500', 'text-yellow-500')
    await user.click(
      within(sheet).getByRole('button', { name: 'Favorite test:unit' })
    )
    expect(onToggleFavoritePackageScript).toHaveBeenCalledWith('test:unit')
    await user.click(within(sheet).getByRole('button', { name: 'test:unit' }))

    expect(onRunPackageScript).toHaveBeenCalledWith(packageScript)
  })

  it('keeps Claude provider switcher available after messages exist', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        customCliProfiles={[{ name: 'OpenRouter', settings_json: '{}' }]}
        providerLocked
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Provider')).toBeInTheDocument()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
  })

  it('keeps model settings usable while a session is running', async () => {
    const user = userEvent.setup()
    const onOpenBackendModelPicker = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        isDisabled={false}
        onOpenBackendModelPicker={onOpenBackendModelPicker}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Model'))

    expect(onOpenBackendModelPicker).toHaveBeenCalledTimes(1)
  })

  it('shows fast mode icon in the model row label', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        backendModelLabel={
          <>
            Codex · GPT 5.5
            <Zap aria-label="Fast mode" />
          </>
        }
        backendModelLabelText="Codex · GPT 5.5"
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByLabelText('Fast mode')).toBeInTheDocument()
  })

  it('renders worktree PR row when prUrl + prNumber set; click opens externally', async () => {
    const user = userEvent.setup()
    const openSpy = vi
      .spyOn(platform, 'openExternal')
      .mockImplementation(() => {
        return undefined as unknown as ReturnType<typeof platform.openExternal>
      })

    render(
      <MobileSettingsMenu
        {...baseProps}
        prUrl="https://github.com/owner/repo/pull/9999"
        prNumber={9999}
        prDisplayStatus="open"
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Linked')).toBeInTheDocument()
    expect(screen.getByText('PR #9999')).toBeInTheDocument()
    const prRow = screen.getByText('PR #9999').closest('[role="menuitem"]')
    expect(prRow).not.toBeNull()
    expect(
      within(prRow as HTMLElement).queryByText('Open')
    ).not.toBeInTheDocument()
    expect(prRow?.querySelector('svg.lucide-external-link')).toBeInTheDocument()

    await user.click(screen.getByText('PR #9999'))
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/owner/repo/pull/9999'
    )

    openSpy.mockRestore()
  })

  it('hides Linked section when no PR data set', async () => {
    const user = userEvent.setup()

    render(<MobileSettingsMenu {...baseProps} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.queryByText('Linked')).not.toBeInTheDocument()
  })

  it('shows Open section with GitHub and jean.json port URLs', async () => {
    const user = userEvent.setup()
    const openSpy = vi
      .spyOn(platform, 'openExternal')
      .mockImplementation(() => {
        return undefined as unknown as ReturnType<typeof platform.openExternal>
      })
    usePortsMock.mockReturnValue({
      data: [
        { port: 1420, label: 'App', host: 'localhost' },
        { port: 3000, label: 'API', host: null },
      ],
    })

    render(
      <MobileSettingsMenu {...baseProps} worktreeId="worktree-1" />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('App (localhost:1420)')).toBeInTheDocument()
    expect(screen.getByText('API (localhost:3000)')).toBeInTheDocument()

    // Open section sits after Run/Terminal actions and before Linked
    const githubItem = screen.getByText('GitHub').closest('[role="menuitem"]')
    const portItem = screen
      .getByText('App (localhost:1420)')
      .closest('[role="menuitem"]')
    expect(githubItem?.querySelector('svg.lucide-external-link')).toBeTruthy()
    expect(portItem?.querySelector('svg.lucide-globe')).toBeTruthy()
    expect(portItem?.querySelector('svg.lucide-external-link')).toBeTruthy()

    await user.click(screen.getByText('App (localhost:1420)'))
    expect(openSpy).toHaveBeenCalledWith('http://localhost:1420')

    openSpy.mockRestore()
  })

  it('hides Open section when no worktree and no ports', async () => {
    const user = userEvent.setup()
    usePortsMock.mockReturnValue({ data: [] })
    useWorktreeMock.mockReturnValue({ data: null as never })

    render(<MobileSettingsMenu {...baseProps} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.queryByText('Open')).not.toBeInTheDocument()
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument()
  })

  it('hides reasoning control for Command Code in mobile settings', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="commandcode"
        backendModelLabel="Command Code · CLI default"
        backendModelLabelText="Command Code · CLI default"
        useAdaptiveThinking={false}
        isCodex={false}
        hideThinkingLevel={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })

  it('hides Claude-only Max and Ultracode effort for Codex', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="codex"
        backendModelLabel="Codex · GPT 5.5"
        backendModelLabelText="Codex · GPT 5.5"
        selectedEffortLevel="max"
        useAdaptiveThinking={false}
        isCodex
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('shows PI effort options instead of Claude thinking in mobile settings', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="pi"
        backendModelLabel="PI · GPT 5.5 (OpenAI Codex)"
        backendModelLabelText="PI · GPT 5.5 (OpenAI Codex)"
        selectedEffortLevel="xhigh"
        selectedThinkingLevel="megathink"
        useAdaptiveThinking={false}
        isCodex={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Effort')).toBeInTheDocument()
    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Megathink')).not.toBeInTheDocument()

    await user.click(screen.getByText('Effort'))

    expect(
      screen.getByRole('menuitemradio', { name: /minimal/i })
    ).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('calls effort change handler when selecting an effort on mobile', async () => {
    const user = userEvent.setup()
    const handleEffortLevelChange = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        useAdaptiveThinking
        handleEffortLevelChange={handleEffortLevelChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))
    const xHighItem = screen
      .getAllByRole('menuitemradio', { name: /xhigh/i })
      .find(item => item.textContent?.startsWith('xHigh'))
    expect(xHighItem).toBeDefined()
    if (!xHighItem) return
    fireEvent.click(xHighItem)

    expect(handleEffortLevelChange).toHaveBeenCalledWith('xhigh')
  })

  it('opens mobile effort options in a screen-contained bottom sheet', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('innerWidth', 390)

    render(
      <MobileSettingsMenu
        {...baseProps}
        useAdaptiveThinking
        selectedEffortLevel="xhigh"
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    const sheet = screen.getByRole('dialog', { name: 'Select effort' })
    expect(sheet).toHaveClass('max-h-[75svh]')
    expect(within(sheet).getByRole('button', { name: /Max/i })).toBeVisible()
    expect(
      within(sheet).getByRole('button', { name: /Ultracode/i })
    ).toBeVisible()
  })

  it('keeps Max effort available for Claude adaptive thinking', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedEffortLevel="max"
        useAdaptiveThinking
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getAllByText('Max').length).toBeGreaterThan(0)
  })

  it('keeps Ultracode effort available for Claude adaptive thinking', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedEffortLevel="ultracode"
        useAdaptiveThinking
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getAllByText('Ultracode').length).toBeGreaterThan(0)
  })
})
