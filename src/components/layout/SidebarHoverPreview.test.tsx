import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarHoverPreview } from './SidebarHoverPreview'

describe('SidebarHoverPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens after 200ms and closes 300ms after the pointer leaves', () => {
    render(
      <SidebarHoverPreview enabled width={250}>
        <div>Projects</div>
      </SidebarHoverPreview>
    )

    const hotspot = screen.getByTestId('sidebar-hover-hotspot')
    fireEvent.pointerEnter(hotspot, { pointerType: 'mouse' })

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(screen.queryByText('Projects')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    const preview = screen.getByTestId('sidebar-hover-preview')
    expect(preview).toHaveAttribute('data-open', 'true')

    fireEvent.pointerLeave(preview)
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(preview).toHaveAttribute('data-open', 'true')

    act(() => {
      vi.advanceTimersByTime(301)
    })
    expect(
      screen.queryByTestId('sidebar-hover-preview')
    ).not.toBeInTheDocument()
  })

  it('ignores touch pointers', () => {
    render(
      <SidebarHoverPreview enabled width={250}>
        <div>Projects</div>
      </SidebarHoverPreview>
    )

    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-hotspot'), {
      pointerType: 'touch',
    })
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(
      screen.queryByTestId('sidebar-hover-preview')
    ).not.toBeInTheDocument()
  })

  it('closes immediately when the preference is disabled', () => {
    const { rerender } = render(
      <SidebarHoverPreview enabled width={250}>
        <div>Projects</div>
      </SidebarHoverPreview>
    )

    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-hotspot'), {
      pointerType: 'mouse',
    })
    act(() => {
      vi.advanceTimersByTime(201)
    })
    expect(screen.getByTestId('sidebar-hover-preview')).toBeInTheDocument()

    rerender(
      <SidebarHoverPreview enabled={false} width={250}>
        <div>Projects</div>
      </SidebarHoverPreview>
    )

    expect(
      screen.queryByTestId('sidebar-hover-preview')
    ).not.toBeInTheDocument()
  })

  it('closes when a blocking modal opens', async () => {
    render(
      <SidebarHoverPreview enabled width={250}>
        <div>Projects</div>
      </SidebarHoverPreview>
    )

    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-hotspot'), {
      pointerType: 'mouse',
    })
    act(() => {
      vi.advanceTimersByTime(201)
    })

    const overlay = document.createElement('div')
    overlay.setAttribute('data-slot', 'dialog-overlay')
    overlay.setAttribute('data-state', 'open')
    act(() => {
      document.body.append(overlay)
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(
      screen.queryByTestId('sidebar-hover-preview')
    ).not.toBeInTheDocument()
    overlay.remove()
  })

  it('stays open while the pointer is in a portaled menu', async () => {
    render(
      <>
        <SidebarHoverPreview enabled width={250}>
          <div>Projects</div>
        </SidebarHoverPreview>
        <div data-slot="dropdown-menu-content" data-state="open">
          Menu
        </div>
      </>
    )

    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-hotspot'), {
      pointerType: 'mouse',
    })
    act(() => {
      vi.advanceTimersByTime(201)
    })

    const preview = screen.getByTestId('sidebar-hover-preview')
    const menu = screen.getByText('Menu')
    fireEvent.pointerLeave(preview, { relatedTarget: menu })
    fireEvent.pointerOver(menu)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(preview).toHaveAttribute('data-open', 'true')

    act(() => {
      menu.setAttribute('data-state', 'closed')
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(
      screen.queryByTestId('sidebar-hover-preview')
    ).not.toBeInTheDocument()
  })
})
