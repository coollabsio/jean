import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('UI state multi-client sync', () => {
  it('broadcasts saved UI state from the shared native and web save path', () => {
    const source = readFileSync(`${process.cwd()}/jean-core/src/lib.rs`, 'utf8')
    const save = source.match(/async fn save_ui_state\([\s\S]*?^}/m)?.[0]
    const emit = source.match(/fn emit_ui_state_invalidation\([\s\S]*?^}/m)?.[0]

    expect(save).toContain('emit_ui_state_invalidation(&app)')
    expect(emit).toContain('app.emit_all(')
    expect(emit).toContain('"cache:invalidate"')
    expect(emit).toContain('"ui-state"')
  })
})
