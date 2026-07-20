/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { MobileLeftSidebar } from './MobileLeftSidebar'

vi.mock('./LeftSideBar', () => ({
  LeftSideBar: () => (
    <div data-testid="left-sidebar-content">
      <button type="button" aria-label="Expand all projects">
        Expand all
      </button>
      Sidebar body
    </div>
  ),
}))

describe('MobileLeftSidebar', () => {
  it('renders as an overlay dialog when open without taking layout flow', async () => {
    const onOpenChange = vi.fn()

    render(
      <div data-testid="layout-root">
        <div data-testid="main-content">Main content stays put</div>
        <MobileLeftSidebar
          open={true}
          onOpenChange={onOpenChange}
          width={250}
        />
      </div>
    )

    const sheet = await screen.findByTestId('mobile-left-sidebar')
    expect(sheet).toBeInTheDocument()
    expect(
      await screen.findByTestId('left-sidebar-content')
    ).toBeInTheDocument()

    // Sheet content is portaled (fixed overlay), so main content remains a direct child
    const layoutRoot = screen.getByTestId('layout-root')
    expect(layoutRoot.children).toHaveLength(1)
    expect(screen.getByTestId('main-content')).toBeInTheDocument()
  })

  it('does not render sheet content when closed', () => {
    render(
      <MobileLeftSidebar open={false} onOpenChange={vi.fn()} width={250} />
    )

    expect(screen.queryByTestId('mobile-left-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('left-sidebar-content')).not.toBeInTheDocument()
  })

  it('drags the real sidebar overlay while the persisted open state is closed', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <MobileLeftSidebar
        open={false}
        onOpenChange={onOpenChange}
        width={250}
        isDragging
        dragOffset={112}
        dragTransition=""
      />
    )

    const sheet = await screen.findByTestId('mobile-left-sidebar')
    expect(sheet).toHaveAttribute('data-swipe-dragging', 'true')
    expect(sheet).toHaveStyle({
      transform: 'translateX(min(0px, calc(-100% + 112px)))',
      animation: 'none',
      transition: 'none',
    })
    expect(
      await screen.findByTestId('left-sidebar-content')
    ).toBeInTheDocument()

    rerender(
      <MobileLeftSidebar
        open
        onOpenChange={onOpenChange}
        width={250}
        isDragging={false}
        dragOffset={400}
        dragTransition="transform 200ms ease-out"
      />
    )

    expect(sheet).toHaveStyle({ animation: 'none' })
    expect(sheet).not.toHaveStyle({ transform: 'translateX(-100%)' })
  })

  it('closes when the dimmed backdrop (grey area) is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <MobileLeftSidebar open={true} onOpenChange={onOpenChange} width={250} />
    )

    await screen.findByTestId('mobile-left-sidebar')

    const overlay = document.querySelector('[data-slot="sheet-overlay"]')
    expect(overlay).toBeTruthy()

    await user.click(overlay as Element)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not autofocus expand-all (avoids tooltip on open)', async () => {
    render(<MobileLeftSidebar open={true} onOpenChange={vi.fn()} width={250} />)

    const expandAll = await screen.findByRole('button', {
      name: 'Expand all projects',
    })

    // Allow Radix open animation / focus cycle to settle
    await waitFor(() => {
      expect(expandAll).not.toHaveFocus()
    })
  })
})
