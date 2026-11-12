import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptTopSpacer } from './PromptTopSpacer'

const CONTENT_HEIGHT = 2000
const CLIENT_HEIGHT = 500

let resize: () => void = () => undefined

/** Resolve the spacer's CSS height, with the composer height as `--chat-composer-height`. */
function spacerHeight(spacer: HTMLElement): number {
  const value = spacer.style.height
  const match =
    /^max\(0px, (-?\d+)px - var\(--chat-composer-height, 0px\)\)$/.exec(value)
  if (!match) return parseFloat(value) || 0
  const composer =
    parseFloat(
      spacer.parentElement?.style.getPropertyValue('--chat-composer-height') ??
        ''
    ) || 0
  return Math.max(0, Number(match[1]) - composer)
}

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
        <PromptTopSpacer
          viewportRef={viewportRef}
          sessionId={sessionId}
          bottomInset="var(--chat-composer-height, 0px)"
        />
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
    get: () => CONTENT_HEIGHT + spacerHeight(spacer),
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

  it('puts the last prompt at the top when a session opens', () => {
    const { viewport, spacer } = setup(CONTENT_HEIGHT - CLIENT_HEIGHT)

    expect(spacerHeight(spacer)).toBe(400)
    expect(viewport.scrollTop).toBe(viewport.scrollHeight)
  })

  it('adds no space when the session has only one prompt', () => {
    const { spacer } = setup(CONTENT_HEIGHT - CLIENT_HEIGHT, ['p1'])

    expect(spacerHeight(spacer)).toBe(0)
  })

  it('keeps a bottom-pinned chat at the bottom when a new prompt grows the spacer', () => {
    const { viewport, spacer, sendPrompt } = setup(
      CONTENT_HEIGHT - CLIENT_HEIGHT
    )

    sendPrompt('p3')

    expect(spacerHeight(spacer)).toBe(400)
    expect(viewport.scrollTop).toBe(viewport.scrollHeight)
  })

  it('does not move a chat that is scrolled up', () => {
    const { viewport, spacer, sendPrompt } = setup(300)

    sendPrompt('p3')

    expect(spacerHeight(spacer)).toBe(400)
    expect(viewport.scrollTop).toBe(300)
  })

  it('removes the space when another session opens with only one prompt', () => {
    const { spacer, sendPrompt, rerender } = setup(300)
    sendPrompt('p3')
    expect(spacerHeight(spacer)).toBe(400)

    rerender(<Harness promptIds={['q1']} sessionId="s2" />)
    resize()

    expect(spacerHeight(spacer)).toBe(0)
  })

  it('shrinks by the composer growth, so a taller composer does not push the prompt above the top', () => {
    const { spacer, sendPrompt } = setup(CONTENT_HEIGHT - CLIENT_HEIGHT)
    sendPrompt('p3')
    expect(spacerHeight(spacer)).toBe(400)

    // Queued prompts panel opens: the composer and the bottom padding grow by
    // 60px. CSS shrinks the spacer by the same amount, with no JS update, so
    // padding + spacer (and the prompt position) stay the same.
    spacer.parentElement?.style.setProperty('--chat-composer-height', '60px')

    expect(spacerHeight(spacer)).toBe(340)
  })
})
