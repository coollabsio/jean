import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GeneralPane settings structure', () => {
  it('uses the Kimi-style header and cards for every AI backend pane', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )

    for (const backend of [
      'claude',
      'codex',
      'opencode',
      'cursor',
      'pi',
      'commandcode',
      'grok',
      'kimi',
    ]) {
      expect(source).toContain(`${backend}: {`)
    }
    expect(source).toContain('<BackendPaneHeader')

    for (const anchorId of [
      'pref-claude-section-cli',
      'pref-claude-section-settings',
      'pref-codex-section-cli',
      'pref-codex-section-settings',
      'pref-opencode-section-cli',
      'pref-opencode-section-settings',
      'pref-cursor-section-cli',
      'pref-cursor-section-settings',
      'pref-pi-section-cli',
      'pref-pi-section-settings',
      'pref-commandcode-section-cli',
      'pref-commandcode-section-settings',
      'pref-grok-section-cli',
      'pref-grok-section-settings',
      'pref-kimi-section-cli',
      'pref-kimi-section-settings',
    ]) {
      const anchorIndex = source.indexOf(`anchorId="${anchorId}"`)
      expect(anchorIndex, anchorId).toBeGreaterThan(-1)
      expect(source.slice(anchorIndex, anchorIndex + 120)).toContain(
        'variant="card"'
      )
    }
  })

  it('renders the Kimi auto-steer toggle inside Kimi settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const kimiSection = source.slice(
      source.indexOf("{scope === 'kimi' && ("),
      source.indexOf('{isGeneralScope && (')
    )

    expect(kimiSection).toContain('kimi_auto_steer_enabled')
    expect(kimiSection).toContain('handleKimiAutoSteerToggle')
    expect(kimiSection).toContain('pref-kimi-section-cli')
    expect(kimiSection).toContain('pref-kimi-section-settings')
  })

  it('renders the OpenCode auto-steer toggle inside OpenCode settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const opencodeSection = source.slice(
      source.indexOf("{scope === 'opencode' && ("),
      source.indexOf("{scope === 'cursor' && (")
    )

    expect(opencodeSection).toContain('opencode_auto_steer_enabled')
    expect(opencodeSection).toContain('handleOpenCodeAutoSteerToggle')
  })

  it('does not render a standalone Grok auth check button', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const grokSection = source.slice(
      source.indexOf("{scope === 'grok' && ("),
      source.indexOf('{isGeneralScope && (')
    )

    expect(grokSection).not.toContain('Check auth')
    expect(grokSection).not.toContain('grokCliQueryKeys.auth()')
  })

  it('renders build and yolo reasoning overrides from model capabilities', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const executionOverrides = source.slice(
      source.indexOf('Build execution'),
      source.indexOf('AI Language')
    )

    expect(executionOverrides).toContain('buildReasoning.levels.map')
    expect(executionOverrides).toContain('yoloReasoning.levels.map')
    expect(executionOverrides).not.toContain('? codexReasoningOptions')
  })

  it('renders the app version and build commit at the bottom of general settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const versionSectionIndex = source.indexOf('title="Version"')
    const generalSettingsEnd = source.indexOf(
      '\n        </>\n      )}',
      versionSectionIndex
    )

    expect(source).toContain(
      "import { CLIENT_BUILD_INFO } from '@/lib/build-info'"
    )
    expect(versionSectionIndex).toBeGreaterThan(-1)
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'CLIENT_BUILD_INFO.appVersion'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'CLIENT_BUILD_INFO.gitSha'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'Source commit used for this build'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'openExternal('
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      '`https://github.com/coollabsio/jean/commit/${CLIENT_BUILD_INFO.gitSha}`'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'CLIENT_BUILD_INFO.builtAt'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'toLocaleString()'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).not.toContain(
      '<SettingsSection'
    )
  })
})
