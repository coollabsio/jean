import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptTopSpacer } from './PromptTopSpacer'

const CONTENT_HEIGHT = 2000
const CLIENT_HEIGHT = 500

let resize: () => void = () => undefined

function Harness() {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={viewportRef} data-testid="viewport">
      <div style={{ padding: 0 }}>
        <div>
          <div data-user-prompt="" />
          <div data-user-prompt="" data-testid="last-prompt" />
        </div>
        <PromptTopSpacer viewportRef={viewportRef} />
      </div>
    </div>
  )
}

function setup(scrollTop: number) {
  const utils = render(<Harness />)
  const viewport = utils.getByTestId('viewport')
  const spacer = viewport.firstElementChild?.lastElementChild as HTMLElement
  const prompt = utils.getByTestId('last-prompt')

  Object.defineProperty(viewport, 'clientHeight', { value: CLIENT_HEIGHT })
  Object.defineProperty(viewport, 'scrollHeight', {
    get: () => CONTENT_HEIGHT + (parseFloat(spacer.style.height) || 0),
  })
  Object.defineProperty(viewport, 'scrollTop', {
    value: scrollTop,
    writable: true,
  })
  // Last prompt starts 100px above the end of the content.
  prompt.getBoundingClientRect = () => ({ top: 900 }) as DOMRect
  spacer.getBoundingClientRect = () => ({ top: 1000 }) as DOMRect

  return { viewport, spacer }
}

describe('PromptTopSpacer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {
          return undefined
        }
        disconnect() {
          return undefined
        }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a bottom-pinned chat at the bottom when the spacer grows', () => {
    const { viewport, spacer } = setup(CONTENT_HEIGHT - CLIENT_HEIGHT)

    resize()

    expect(spacer.style.height).toBe('400px')
    expect(viewport.scrollTop).toBe(viewport.scrollHeight)
  })

  it('does not move a chat that is scrolled up', () => {
    const { viewport, spacer } = setup(300)

    resize()

    expect(spacer.style.height).toBe('400px')
    expect(viewport.scrollTop).toBe(300)
  })
})
