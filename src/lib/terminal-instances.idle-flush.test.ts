import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('terminal idle-freeze regression', () => {
  it('scheduleAnimationFrame falls back to setTimeout when document is hidden', () => {
    const source = readSource('src/lib/terminal-instances.ts')

    // requestAnimationFrame is paused under macOS App Nap and when the
    // document is hidden. Without a fallback, output and echo stall for
    // minutes at a time — see plan we-have-a-problem-iterative-spring.md.
    expect(source).toContain("document.visibilityState === 'hidden'")
    expect(source).toMatch(
      /if \(!hidden && typeof requestAnimationFrame === 'function'\)/
    )
  })

  it('wake handler flushes queued output and input before refresh', () => {
    const source = readSource('src/lib/terminal-instances.ts')

    const wakeStart = source.indexOf('const wake = () => {')
    const wakeEnd = source.indexOf('document.addEventListener', wakeStart)
    expect(wakeStart).toBeGreaterThan(-1)
    expect(wakeEnd).toBeGreaterThan(wakeStart)

    const wakeBody = source.slice(wakeStart, wakeEnd)
    expect(wakeBody).toContain('outputBuffers')
    expect(wakeBody).toContain('inst.terminal.write(buffer.data)')
    expect(wakeBody).toContain('flushTerminalInput(terminalId)')

    // refresh() must run after the drain so freshly written rows are repainted.
    const drainIndex = wakeBody.indexOf('outputBuffers.delete(terminalId)')
    const refreshIndex = wakeBody.indexOf('.refresh(')
    expect(drainIndex).toBeGreaterThan(-1)
    expect(refreshIndex).toBeGreaterThan(drainIndex)
  })

  it('bounds detached renderer retention and rehydrates idle running PTYs', () => {
    const source = readSource('src/lib/terminal-instances.ts')

    expect(source).toContain('MAX_DETACHED_TERMINAL_INSTANCES = 20')
    expect(source).toContain('TERMINAL_SCROLLBACK_LINES = 2_000')
    expect(source).toContain('RUNNING_RENDERER_IDLE_MS = 5 * 60 * 1000')
    expect(source).toContain('DETACHED_OUTPUT_BUFFER_CHARS = 512 * 1024')
    expect(source).toContain('!runningTerminals.has(instance.terminalId)')
    expect(source).toContain('rendererEvicted')
    expect(source).toContain('appendDetachedOutput')
    expect(source).toContain('snapshotTerminalBuffer')
    expect(source).toContain('restoreDetachedOutput(instance)')
    expect(source).toContain('trimDetachedTerminalRenderers')
  })
})
