import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import { applySessionSettingToSession } from './session-setting-sync'

const baseSession: Session = {
  id: 'session-1',
  name: 'Session 1',
  order: 0,
  created_at: 1,
  updated_at: 1,
  messages: [],
  backend: 'claude',
  selected_model: 'opus',
  selected_thinking_level: 'off',
  selected_execution_mode: 'plan',
}

describe('applySessionSettingToSession', () => {
  it('updates backend', () => {
    expect(
      applySessionSettingToSession(baseSession, 'backend', 'codex')
    ).toMatchObject({
      backend: 'codex',
      selected_model: 'opus',
    })
  })

  it('updates model', () => {
    expect(
      applySessionSettingToSession(baseSession, 'model', 'gpt-5.4')
    ).toMatchObject({
      backend: 'claude',
      selected_model: 'gpt-5.4',
    })
  })

  it('updates thinking level', () => {
    expect(
      applySessionSettingToSession(baseSession, 'thinkingLevel', 'ultrathink')
    ).toMatchObject({
      selected_thinking_level: 'ultrathink',
      selected_execution_mode: 'plan',
    })
  })

  it('updates execution mode', () => {
    expect(
      applySessionSettingToSession(baseSession, 'executionMode', 'yolo')
    ).toMatchObject({
      selected_execution_mode: 'yolo',
      selected_thinking_level: 'off',
    })
  })
})
