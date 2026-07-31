import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const setDeploymentOpen = vi.fn()
let config: { token?: string; productionVersionUrl?: string } = {
  token: 'pk_test',
  productionVersionUrl: 'https://example.com/version',
}

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    (selector: (state: { deploymentOpen: boolean }) => unknown) =>
      selector({ deploymentOpen: false }),
    { getState: () => ({ setDeploymentOpen }) }
  ),
}))

vi.mock('@/services/clickup', () => ({
  useClickUpConfig: () => ({ data: config }),
}))

vi.mock('@/services/ai-pipeline', () => ({
  useAiPipelineProjectId: () => ({ projectId: 'project-1' }),
}))

import { DeploymentSidebarButton } from './DeploymentSidebarButton'

describe('DeploymentSidebarButton', () => {
  beforeEach(() => {
    setDeploymentOpen.mockReset()
    config = {
      token: 'pk_test',
      productionVersionUrl: 'https://example.com/version',
    }
  })

  it('opens the deployment cockpit', () => {
    render(<DeploymentSidebarButton isNarrow={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Déploiement' }))
    expect(setDeploymentOpen).toHaveBeenCalledWith(true)
  })

  it('stays hidden until the production version URL is configured', () => {
    config = { token: 'pk_test' }
    const { container } = render(
      <DeploymentSidebarButton isNarrow={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
