import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageSettingsBadges } from './MessageSettingsBadges'

describe('MessageSettingsBadges', () => {
  it('renders Codex fast model labels instead of raw ids', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.5-fast"
        executionMode="yolo"
        thinkingLevel={undefined}
        effortLevel="medium"
        isCursor={false}
      />
    )

    expect(screen.getByText('Codex · GPT 5.5 Fast')).toBeVisible()
    expect(screen.getByText('· Yolo')).toBeVisible()
    expect(screen.getByText('· Medium')).toBeVisible()
  })

  it('renders Codex base model labels', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.4"
        executionMode="plan"
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Codex · GPT 5.4')).toBeVisible()
  })

  it('does not show Claude thinking labels for Codex models', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.5-fast"
        executionMode="plan"
        thinkingLevel="megathink"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Codex · GPT 5.5 Fast')).toBeVisible()
    expect(screen.queryByText('· Megathink')).toBeNull()
  })

  it('does not show Claude thinking labels for Grok models', () => {
    render(
      <MessageSettingsBadges
        model="grok/grok-4.5"
        executionMode="yolo"
        thinkingLevel="think"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText(/Grok/)).toBeVisible()
    expect(screen.queryByText('· Think')).toBeNull()
  })

  it('shows effort labels for Grok models', () => {
    render(
      <MessageSettingsBadges
        model="grok/grok-4.5"
        executionMode="yolo"
        thinkingLevel={undefined}
        effortLevel="medium"
        isCursor={false}
      />
    )

    expect(screen.getByText('· Yolo')).toBeVisible()
    expect(screen.getByText('· Medium')).toBeVisible()
  })

  it('keeps Claude model labels working', () => {
    render(
      <MessageSettingsBadges
        model="haiku"
        executionMode="plan"
        thinkingLevel="think"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Claude · Haiku')).toBeVisible()
    expect(screen.getByText('· Think')).toBeVisible()
  })

  it('renders Claude fast model labels instead of raw ids', () => {
    render(
      <MessageSettingsBadges
        model="claude-opus-4-6[1m]-fast"
        executionMode="plan"
        thinkingLevel={undefined}
        effortLevel="high"
        isCursor={false}
      />
    )

    expect(screen.getByText('Claude · Opus 4.6 (1M) Fast')).toBeVisible()
    expect(screen.getByText('· Plan')).toBeVisible()
    expect(screen.getByText('· High')).toBeVisible()
    expect(screen.queryByText('claude-opus-4-6[1m]-fast')).toBeNull()
  })

  it('prefixes future Claude model ids with Claude in prompt badges', () => {
    render(
      <MessageSettingsBadges
        model="claude-sonnet-5-1"
        executionMode="yolo"
        thinkingLevel="megathink"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Claude · claude-sonnet-5-1')).toBeVisible()
    expect(screen.getByText('· Yolo')).toBeVisible()
    expect(screen.getByText('· Megathink')).toBeVisible()
  })

  it('formats OpenCode slash models with backend prefix', () => {
    render(
      <MessageSettingsBadges
        model="opencode/openrouter/anthropic/claude-3.5-haiku"
        executionMode="build"
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('OpenCode · Claude 3.5 Haiku')).toBeVisible()
    expect(screen.getByText('· Build')).toBeVisible()
  })

  it('formats CommandCode prompt model labels with backend prefix', () => {
    render(
      <MessageSettingsBadges
        model="commandcode/deepseek/deepseek-v4-flash"
        executionMode="plan"
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Command Code · Deepseek V4 Flash')).toBeVisible()
    expect(
      screen.queryByText('Deepseek/deepseek V4 Flash (Commandcode)')
    ).toBeNull()
  })

  it('formats unknown slash models as provider labels without backend prefix', () => {
    render(
      <MessageSettingsBadges
        model="openrouter/anthropic/claude-3.5-haiku"
        executionMode={undefined}
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Claude 3.5 Haiku (Anthropic)')).toBeVisible()
  })

  it('formats Grok prompt model labels with backend prefix', () => {
    render(
      <MessageSettingsBadges
        model="grok/grok-4.5"
        executionMode="yolo"
        thinkingLevel={undefined}
        effortLevel="medium"
        isCursor={false}
      />
    )

    expect(screen.getByText('Grok · 4.5')).toBeVisible()
    expect(screen.getByText('· Yolo')).toBeVisible()
    expect(screen.getByText('· Medium')).toBeVisible()
    expect(screen.queryByText('Grok 4.5')).toBeNull()
  })

  it('formats Kimi Code prompt model labels with backend prefix', () => {
    render(
      <MessageSettingsBadges
        model="kimi/kimi-code/kimi-for-coding"
        executionMode="build"
        thinkingLevel="think"
        effortLevel="high"
        isCursor={false}
      />
    )

    expect(screen.getByText('Kimi Code · Kimi for Coding')).toBeVisible()
    expect(screen.getByText('· Build')).toBeVisible()
    expect(screen.getByText('· High')).toBeVisible()
  })

  it('treats PI models with codex provider names as PI models', () => {
    render(
      <MessageSettingsBadges
        model="pi/openai-codex/gpt-5.5"
        executionMode="plan"
        thinkingLevel="megathink"
        effortLevel="low"
        isCursor={false}
      />
    )

    expect(screen.getByText('PI · GPT 5.5 (OpenAI Codex)')).toBeVisible()
    expect(screen.getByText('· Plan')).toBeVisible()
    expect(screen.getByText('· Low')).toBeVisible()
    expect(screen.queryByText('· Megathink')).toBeNull()
  })

  it('falls back to raw ids for unknown non-slash models', () => {
    render(
      <MessageSettingsBadges
        model="unknown-model"
        executionMode={undefined}
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('unknown-model')).toBeVisible()
  })
})
