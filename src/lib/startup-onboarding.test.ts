import { describe, expect, it } from 'vitest'
import { getStartupOnboardingAction } from './startup-onboarding'

const readyStatus = { installed: true }
const missingStatus = { installed: false }
const authenticated = { authenticated: true }
const unauthenticated = { authenticated: false }

describe('getStartupOnboardingAction', () => {
  it('waits for authentication results before opening onboarding', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [readyStatus, missingStatus, missingStatus],
        aiAuth: [undefined, undefined, undefined],
        ghStatus: readyStatus,
        ghAuth: undefined,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('wait')
  })

  it('closes startup onboarding when required tools are already ready', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [missingStatus, readyStatus, missingStatus],
        aiAuth: [undefined, authenticated, undefined],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: true,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('close')
  })

  it('reports ready setup without opening onboarding', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [missingStatus, readyStatus, missingStatus],
        aiAuth: [undefined, authenticated, undefined],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('ready')
  })

  it('treats Grok (or any later backend) as a valid ready AI backend', () => {
    // Regression: startup used to only count Claude/Codex/OpenCode, so remotes
    // with only Grok ready reopened the "Setup Complete" dialog every launch.
    expect(
      getStartupOnboardingAction({
        aiStatuses: [
          readyStatus, // claude installed but not auth'd
          missingStatus,
          missingStatus,
          missingStatus,
          missingStatus,
          missingStatus,
          readyStatus, // grok
          missingStatus,
        ],
        aiAuth: [
          unauthenticated,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          authenticated,
          undefined,
        ],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('ready')
  })

  it('does not open for WSL when tools are already ready', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [readyStatus],
        aiAuth: [authenticated],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: true,
      })
    ).toBe('ready')
  })

  it('keeps manually opened onboarding open when tools are ready', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [missingStatus, readyStatus, missingStatus],
        aiAuth: [undefined, authenticated, undefined],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: true,
        onboardingDismissed: false,
        onboardingManuallyTriggered: true,
        requiresWslChoice: false,
      })
    ).toBe('none')
  })

  it('opens onboarding when setup is definitively incomplete', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [missingStatus, missingStatus, missingStatus],
        aiAuth: [undefined, undefined, undefined],
        ghStatus: readyStatus,
        ghAuth: authenticated,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('open')
  })

  it('opens onboarding when only WSL choice is still needed and tools incomplete', () => {
    expect(
      getStartupOnboardingAction({
        aiStatuses: [missingStatus],
        aiAuth: [undefined],
        ghStatus: missingStatus,
        ghAuth: undefined,
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: true,
      })
    ).toBe('open')
  })
})
