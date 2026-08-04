import type React from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowMaximized } from '@/hooks/use-window-maximized'

type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

interface Handle {
  direction: ResizeDirection
  style: React.CSSProperties
}

const EDGE_SIZE = 6
const CORNER_SIZE = 12

const cursorByDirection: Record<ResizeDirection, string> = {
  North: 'ns-resize',
  South: 'ns-resize',
  East: 'ew-resize',
  West: 'ew-resize',
  NorthEast: 'nesw-resize',
  SouthWest: 'nesw-resize',
  NorthWest: 'nwse-resize',
  SouthEast: 'nwse-resize',
}

const handles: Handle[] = [
  {
    direction: 'NorthWest',
    style: { top: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    direction: 'North',
    style: { top: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_SIZE },
  },
  {
    direction: 'NorthEast',
    style: { top: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    direction: 'East',
    style: {
      top: CORNER_SIZE,
      right: 0,
      bottom: CORNER_SIZE,
      width: EDGE_SIZE,
    },
  },
  {
    direction: 'SouthEast',
    style: { right: 0, bottom: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    direction: 'South',
    style: {
      right: CORNER_SIZE,
      bottom: 0,
      left: CORNER_SIZE,
      height: EDGE_SIZE,
    },
  },
  {
    direction: 'SouthWest',
    style: { bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    direction: 'West',
    style: { top: CORNER_SIZE, bottom: CORNER_SIZE, left: 0, width: EDGE_SIZE },
  },
]

function startResize(direction: ResizeDirection) {
  return (event: React.MouseEvent) => {
    if (event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    void getCurrentWindow().startResizeDragging(direction)
  }
}

export function WindowResizeHandles() {
  const isMaximized = useWindowMaximized()

  if (isMaximized) return null

  return (
    <>
      {handles.map(handle => (
        <div
          key={handle.direction}
          data-testid={`window-resize-${handle.direction}`}
          aria-hidden="true"
          onMouseDown={startResize(handle.direction)}
          style={{
            position: 'fixed',
            zIndex: 70,
            pointerEvents: 'auto',
            cursor: cursorByDirection[handle.direction],
            ...handle.style,
          }}
        />
      ))}
    </>
  )
}
