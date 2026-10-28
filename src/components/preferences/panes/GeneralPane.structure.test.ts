import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GeneralPane settings structure', () => {
  it('keeps CLI and model sections for every AI backend', () => {
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
      expect(source, anchorId).toContain(`anchorId="${anchorId}"`)
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
      source.indexOf('label="Plan approval"'),
      source.indexOf('label="Auto-update AI backends"')
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
      source.indexOf('label="Plan approval"'),
      source.indexOf('label="Auto-update AI backends"')
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
    expect(generalSource).not.toMatch(/<AiLanguageField[^>]*patchPreferences=/)
    expect(fieldSource).toContain('usePatchPreferences()')
    expect(fieldSource).toContain('isAiLanguageSavePending')
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
    expect(source).toContain('title="Browser"')
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

  it('renders a compact version line after the Advanced section', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const advancedIndex = source.indexOf('title="Advanced"')
    const versionIndex = source.indexOf('id="pref-general-section-version"')
    const advancedEnd = source.indexOf('</SettingsSection>', advancedIndex)
    const versionLine = source.slice(
      versionIndex,
      source.indexOf('\n          </div>\n', versionIndex)
    )

    expect(source).toContain(
      "import { CLIENT_BUILD_INFO } from '@/lib/build-info'"
    )
    expect(advancedIndex).toBeGreaterThan(-1)
    expect(versionIndex).toBeGreaterThan(advancedEnd)
    for (const expected of [
      'CLIENT_BUILD_INFO.appVersion',
      "activeRemoteConnection ? 'Jean Client' : 'Jean'",
      'remoteServerVersion',
      '`https://github.com/coollabsio/jean/commit/${CLIENT_BUILD_INFO.gitSha}`',
      'CLIENT_BUILD_INFO.builtAt',
    ]) {
      expect(versionLine, expected).toContain(expected)
    }
  })

  it('keeps rarely used general options inside the collapsed Advanced section', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const advancedIndex = source.indexOf('title="Advanced"')
    const advanced = source.slice(
      advancedIndex,
      source.indexOf('</SettingsSection>', advancedIndex)
    )

    expect(advanced).toContain('defaultOpen={false}')
    for (const expected of [
      'label="Keep AI servers warm"',
      'label="Plan approval"',
      'label="Full-access plan approval"',
      'label="Auto-update AI backends"',
      '<WslSettingsFields',
      'debug_mode_enabled',
      'agents_enabled',
      "invoke('open_log_directory')",
    ]) {
      expect(advanced, expected).toContain(expected)
    }
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
    expect(source.slice(githubCli, githubCli + 200)).not.toContain(
      '<BetaBadge />'
    )
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
    expect(guard).toContain('{isWebAccessView && (')
    expect(
      source.lastIndexOf('{isGeneralScope && (', sectionIndex)
    ).toBeGreaterThan(-1)
    expect(source).toContain('signOutOfWebAccess')
  })
})
