import { describe, expect, it } from 'vitest'
import { getStartupOnboardingAction } from './startup-onboarding'

const readyStatus = { installed: true }
const missingStatus = { installed: false }
const authenticated = { authenticated: true }

describe('getStartupOnboardingAction', () => {
  it('waits for authentication results before opening onboarding', () => {
    expect(
      getStartupOnboardingAction({
        statuses: [readyStatus, missingStatus, missingStatus, readyStatus],
        auth: [undefined, undefined, undefined, undefined],
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
        statuses: [missingStatus, readyStatus, missingStatus, readyStatus],
        auth: [undefined, authenticated, undefined, authenticated],
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
        statuses: [missingStatus, readyStatus, missingStatus, readyStatus],
        auth: [undefined, authenticated, undefined, authenticated],
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('ready')
  })

  it('keeps manually opened onboarding open when tools are ready', () => {
    expect(
      getStartupOnboardingAction({
        statuses: [missingStatus, readyStatus, missingStatus, readyStatus],
        auth: [undefined, authenticated, undefined, authenticated],
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
        statuses: [missingStatus, missingStatus, missingStatus, readyStatus],
        auth: [undefined, undefined, undefined, authenticated],
        onboardingOpen: false,
        onboardingDismissed: false,
        onboardingManuallyTriggered: false,
        requiresWslChoice: false,
      })
    ).toBe('open')
  })
})
