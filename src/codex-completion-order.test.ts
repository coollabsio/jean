import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Codex completion ordering', () => {
  const commandsSource = readFileSync(
    `${process.cwd()}/jean-core/src/chat/commands.rs`,
    'utf8'
  )
  const codexSource = readFileSync(
    `${process.cwd()}/jean-core/src/chat/codex.rs`,
    'utf8'
  )

  it('notifies clients only after the run and session state are persisted', () => {
    const processTurnStart = codexSource.indexOf('fn process_turn_events(')
    const processTurnEnd = codexSource.indexOf(
      '/// Convert a server notification',
      processTurnStart
    )
    const processTurnSource = codexSource.slice(
      processTurnStart,
      processTurnEnd
    )

    expect(processTurnSource).not.toContain('"chat:done"')

    const completionStart = commandsSource.indexOf(
      '// Finalize run log (complete or cancel based on response status)'
    )
    const completionEnd = commandsSource.indexOf(
      'trigger_backend_queue_drain(',
      completionStart
    )
    const completionSource = commandsSource.slice(
      completionStart,
      completionEnd
    )

    expect(completionSource.indexOf('run_log_writer.complete')).toBeGreaterThan(
      -1
    )
    expect(completionSource.indexOf('with_sessions_mut')).toBeGreaterThan(-1)
    expect(
      completionSource.indexOf('emit_sessions_cache_invalidation')
    ).toBeGreaterThan(completionSource.indexOf('with_sessions_mut'))
    expect(completionSource.indexOf('"chat:done"')).toBeGreaterThan(
      completionSource.indexOf('emit_sessions_cache_invalidation')
    )
  })
})
