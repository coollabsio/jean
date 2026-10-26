import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GeneralPane settings structure', () => {
  it('uses section cards for every AI backend pane', () => {
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
      'devin',
    ]) {
      expect(source).toContain(`'${backend}',`)
    }

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
      'pref-devin-section-cli',
      'pref-devin-section-settings',
    ]) {
      const anchorIndex = source.indexOf(`anchorId="${anchorId}"`)
      expect(anchorIndex, anchorId).toBeGreaterThan(-1)
      expect(source.slice(anchorIndex, anchorIndex + 120)).toContain(
        'variant="card"'
      )
    }
  })

  it('uses shared compact source selectors for managed backends', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )

    expect(source.match(/<BackendCliSourceSelect/g)).toHaveLength(8)
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

  it('renders Devin setup and default model settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const devinSection = source.slice(
      source.indexOf("{scope === 'devin' && ("),
      source.indexOf('{isGeneralScope && (')
    )

    expect(devinSection).toContain('devin_cli_source')
    expect(devinSection).toContain('selectedDevinModel')
    expect(devinSection).toContain('handleDevinLogin')
    expect(devinSection).toContain('handleDevinInstall')
    expect(devinSection).toContain('pref-devin-section-cli')
    expect(devinSection).toContain('pref-devin-section-settings')
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
      source.indexOf('Plan approval'),
      source.indexOf('AI Language')
    )

    expect(executionOverrides).toContain('buildReasoning.levels.map')
    expect(executionOverrides).toContain('yoloReasoning.levels.map')
    expect(executionOverrides).not.toContain('? codexReasoningOptions')
  })

  it('uses Grok models for build and yolo overrides when Grok is selected', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const executionOverrides = source.slice(
      source.indexOf('Plan approval'),
      source.indexOf('AI Language')
    )

    expect(
      executionOverrides.match(/effective(?:Build|Yolo)Backend === 'grok'/g)
    ).toHaveLength(2)
    expect(executionOverrides.match(/\? grokModelOptions/g)).toHaveLength(2)
  })

  // Regression #505: shared patchPreferences.isPending made the AI Language
  // Save button spin when model defaults (or any other General field) saved.
  it('scopes AI Language save loading to its own preferences mutation', () => {
    const generalSource = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const fieldSource = readFileSync(
      'src/components/preferences/panes/AiLanguageField.tsx',
      'utf8'
    )

    // Field lives in its own module with an independent mutation instance
    expect(generalSource).toContain(
      "import { AiLanguageField } from './AiLanguageField'"
    )
    expect(generalSource).toContain(
      '<AiLanguageField preferences={preferences} />'
    )
    expect(generalSource).not.toMatch(
      /<AiLanguageField[\s\S]*?patchPreferences=/
    )
    expect(fieldSource).toContain('usePatchPreferences()')
    expect(fieldSource).toContain('isAiLanguageSavePending')
    expect(fieldSource).toContain('disabled={!hasChanges || isSaving}')
    expect(fieldSource).not.toContain(
      'disabled={!hasChanges || patchPreferences.isPending}'
    )
  })

  it('renders the server preview hostname in general settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const fieldSource = readFileSync(
      'src/components/preferences/panes/BrowserDefaultHostField.tsx',
      'utf8'
    )
    const browserIndex = source.indexOf('title="Browser"')
    const archiveIndex = source.indexOf('title="Archive"')

    expect(browserIndex).toBeGreaterThan(-1)
    expect(browserIndex).toBeLessThan(archiveIndex)
    expect(source).toContain('anchorId="pref-general-section-browser"')
    expect(source).toContain(
      '<BrowserDefaultHostField preferences={preferences} />'
    )
    expect(fieldSource).toContain('browser_default_host')
    expect(fieldSource).toContain('usePatchPreferences()')
  })

  it('renders chat path and spellcheck toggles before auto-generate', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const chatIndex = source.indexOf('title="Chat"')
    const autoGenerateIndex = source.indexOf('title="Auto-generate"')
    const section = source.slice(chatIndex, autoGenerateIndex)

    expect(chatIndex).toBeGreaterThan(-1)
    expect(chatIndex).toBeLessThan(autoGenerateIndex)
    expect(section).toContain('anchorId="pref-general-section-chat"')
    expect(section).toContain('show_full_file_path')
    expect(section).toContain('spellcheck_enabled')
    expect(section).toContain('Show full file paths')
    expect(section).toContain('Spellcheck')
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
      "label={activeRemoteConnection ? 'Jean Client' : 'Jean'}"
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'label="Jean Server"'
    )
    expect(source.slice(versionSectionIndex, generalSettingsEnd)).toContain(
      'remoteServerVersion'
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

  it('marks the GitLab CLI settings section as beta', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const anchor = source.indexOf('anchorId="pref-gitlab-section-cli"')
    expect(anchor).toBeGreaterThan(-1)
    const section = source.slice(anchor - 250, anchor)
    expect(section).toContain('GitLab CLI')
    expect(section).toContain('<BetaBadge />')
    const githubCli = source.indexOf('title="GitHub CLI"')
    expect(githubCli).toBeGreaterThan(-1)
    expect(source.slice(githubCli, githubCli + 200)).not.toContain('<BetaBadge />')
  })

  it('offers a browser sign-out only when running as web access', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )

    const sectionIndex = source.indexOf('pref-general-section-session')
    expect(sectionIndex).toBeGreaterThan(-1)

    // The control must be gated on web access: the desktop app manages its
    // connection from the title bar, not from a token in localStorage. Match
    // the exact guard expression so an inverted or loosened condition fails.
    const guard = source.slice(Math.max(0, sectionIndex - 400), sectionIndex)
    expect(guard).toContain('isGeneralScope && isWebAccessView && (')
    expect(source).toContain('signOutOfWebAccess')
  })
})
