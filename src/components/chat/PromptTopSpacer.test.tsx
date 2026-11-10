import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptTopSpacer } from './PromptTopSpacer'

const CONTENT_HEIGHT = 2000
const CLIENT_HEIGHT = 500

let resize: () => void = () => undefined

function Harness({
  promptIds,
  sessionId = 's1',
}: {
  promptIds: string[]
  sessionId?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={viewportRef} data-testid="viewport">
      <div style={{ padding: 0 }}>
        <div>
          {promptIds.map(id => (
            <div key={id} data-user-prompt="" data-message-anchor-id={id} />
          ))}
        </div>
        <PromptTopSpacer viewportRef={viewportRef} sessionId={sessionId} />
      </div>
    </div>
  )
}

function setup(scrollTop: number, promptIds = ['p1', 'p2']) {
  const utils = render(<Harness promptIds={promptIds} />)
  const viewport = utils.getByTestId('viewport')
  const spacer = viewport.firstElementChild?.lastElementChild as HTMLElement

  Object.defineProperty(viewport, 'clientHeight', { value: CLIENT_HEIGHT })
  Object.defineProperty(viewport, 'scrollHeight', {
    get: () => CONTENT_HEIGHT + (parseFloat(spacer.style.height) || 0),
  })
  Object.defineProperty(viewport, 'scrollTop', {
    value: scrollTop,
    writable: true,
  })
  // Every prompt starts 100px above the end of the content.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { top: this === spacer ? 1000 : 900 } as DOMRect
  }

  // The session opens with this history.
  resize()

  // A new prompt arrives while the session is displayed.
  const sendPrompt = (id: string, sessionId = 's1') => {
    utils.rerender(
      <Harness promptIds={[...promptIds, id]} sessionId={sessionId} />
    )
    resize()
  }

  return { viewport, spacer, sendPrompt, rerender: utils.rerender }
}

describe('PromptTopSpacer', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect

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
    HTMLElement.prototype.getBoundingClientRect = originalRect
    vi.unstubAllGlobals()
  })

  it('adds no space when a session opens, so its last reply ends at the bottom', () => {
    const { viewport, spacer } = setup(CONTENT_HEIGHT - CLIENT_HEIGHT)

    expect(spacer.style.height).toBe('0px')
    expect(viewport.scrollHeight).toBe(CONTENT_HEIGHT)
  })

  it('keeps a bottom-pinned chat at the bottom when a new prompt grows the spacer', () => {
    const { viewport, spacer, sendPrompt } = setup(
      CONTENT_HEIGHT - CLIENT_HEIGHT
    )

    sendPrompt('p3')

    expect(spacer.style.height).toBe('400px')
    expect(viewport.scrollTop).toBe(viewport.scrollHeight)
  })

  it('does not move a chat that is scrolled up', () => {
    const { viewport, spacer, sendPrompt } = setup(300)

    sendPrompt('p3')

    expect(spacer.style.height).toBe('400px')
    expect(viewport.scrollTop).toBe(300)
  })

  it('removes the space when another session opens', () => {
    const { spacer, sendPrompt, rerender } = setup(300)
    sendPrompt('p3')
    expect(spacer.style.height).toBe('400px')

    rerender(<Harness promptIds={['q1', 'q2']} sessionId="s2" />)
    resize()

    expect(spacer.style.height).toBe('0px')
  })
})
