import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useBrowserStore } from '@/store/browser-store'
import {
  DISMISS_TRANSIENT_UI_EVENT,
  dismissTransientUi,
} from './dismiss-transient-ui'

describe('dismissTransientUi', () => {
  beforeEach(() => {
    useUIStore.setState({
      commandPaletteOpen: false,
      preferencesOpen: false,
      preferencesPane: null,
      onboardingOpen: false,
      magicModalOpen: false,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      githubDashboardOpen: false,
      viewingFilePath: null,
      updateModalVersion: null,
      remotePickerOpen: false,
      remotePickerRepoPath: null,
    })
    useProjectsStore.setState({
      projectSettingsDialogOpen: false,
      projectSettingsProjectId: null,
      projectSettingsInitialPane: null,
      addProjectDialogOpen: false,
      gitInitModalOpen: false,
      cloneModalOpen: false,
      jeanConfigWizardOpen: false,
    })
    useBrowserStore.setState({ modalOpen: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('closes store-managed dialogs and modals', () => {
    useUIStore.setState({
      commandPaletteOpen: true,
      preferencesOpen: true,
      preferencesPane: 'general',
      onboardingOpen: true,
      magicModalOpen: true,
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'wt-1',
      githubDashboardOpen: true,
      viewingFilePath: '/tmp/a.ts',
      updateModalVersion: '1.2.3',
    })
    useProjectsStore.getState().openProjectSettings('proj-1', 'general')
    useProjectsStore.getState().setAddProjectDialogOpen(true)
    useBrowserStore.setState({ modalOpen: { 'wt-1': true } })

    dismissTransientUi()

    const ui = useUIStore.getState()
    expect(ui.commandPaletteOpen).toBe(false)
    expect(ui.preferencesOpen).toBe(false)
    expect(ui.preferencesPane).toBeNull()
    expect(ui.onboardingOpen).toBe(false)
    expect(ui.magicModalOpen).toBe(false)
    expect(ui.sessionChatModalOpen).toBe(false)
    expect(ui.sessionChatModalWorktreeId).toBeNull()
    expect(ui.githubDashboardOpen).toBe(false)
    expect(ui.viewingFilePath).toBeNull()
    expect(ui.updateModalVersion).toBeNull()

    const projects = useProjectsStore.getState()
    expect(projects.projectSettingsDialogOpen).toBe(false)
    expect(projects.addProjectDialogOpen).toBe(false)

    expect(useBrowserStore.getState().modalOpen['wt-1']).toBe(false)
  })

  it('dispatches dismiss event for local-state overlays', () => {
    const listener = vi.fn()
    window.addEventListener(DISMISS_TRANSIENT_UI_EVENT, listener)

    dismissTransientUi()

    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(DISMISS_TRANSIENT_UI_EVENT, listener)
  })

  it('dispatches Escape so uncontrolled Radix menus can close', () => {
    const keydown = vi.fn()
    document.addEventListener('keydown', keydown)

    dismissTransientUi()

    expect(keydown).toHaveBeenCalled()
    const escapeCalls = keydown.mock.calls.filter(
      ([event]) => (event as KeyboardEvent).key === 'Escape'
    )
    expect(escapeCalls.length).toBeGreaterThan(0)

    document.removeEventListener('keydown', keydown)
  })

  it('clears body pointer-events lock after dismiss when no overlay remains', async () => {
    document.body.style.pointerEvents = 'none'
    document.body.setAttribute('data-scroll-locked', '1')

    dismissTransientUi()

    await new Promise(resolve => setTimeout(resolve, 60))

    expect(document.body.style.pointerEvents).toBe('')
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
  })
})
