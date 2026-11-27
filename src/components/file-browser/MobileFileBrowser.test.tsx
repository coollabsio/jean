/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MobileFileBrowser } from './MobileFileBrowser'

vi.mock('@/components/layout/RightPanel', () => ({
  RightPanel: () => <div>Files</div>,
}))

describe('MobileFileBrowser', () => {
  it('shows the drawer only when explicitly opened', async () => {
    render(<MobileFileBrowser open onOpenChange={vi.fn()} />)

    const drawer = await screen.findByTestId('mobile-file-browser')
    expect(drawer).toBeVisible()
    expect(drawer).not.toHaveAttribute('data-swipe-dragging')
  })
})
