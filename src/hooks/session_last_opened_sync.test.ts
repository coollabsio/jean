/**
 * Structure regression for multi-client unread sync (#512).
 * `set_session_last_opened` must broadcast cache:invalidate so native + web
 * clients refresh finished/unread state after one client marks a session read.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('set_session_last_opened multi-client sync', () => {
  const source = readFileSync(
    `${process.cwd()}/jean-core/src/chat/commands.rs`,
    'utf8'
  )

  it('emits sessions cache invalidation after single mark-opened', () => {
    const singleFn = source.match(
      /pub async fn set_session_last_opened[\s\S]*?^pub async fn set_sessions_last_opened_bulk/m
    )
    expect(singleFn?.[0]).toBeTruthy()
    expect(singleFn?.[0]).toContain('emit_sessions_cache_invalidation(&app)')
  })

  it('emits sessions cache invalidation after bulk mark-opened', () => {
    const bulkFn = source.match(
      /pub async fn set_sessions_last_opened_bulk[\s\S]*?^\/\/ =+[\s\S]*?Chat Commands/m
    )
    expect(bulkFn?.[0]).toBeTruthy()
    expect(bulkFn?.[0]).toContain('emit_sessions_cache_invalidation(&app)')
  })
})
