import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectSettingsDialog structure', () => {
  it('keeps project integrations in their own sidebar pane', () => {
    const dialog = readFileSync(
      'src/components/projects/ProjectSettingsDialog.tsx',
      'utf8'
    )
    const general = readFileSync(
      'src/components/projects/panes/GeneralPane.tsx',
      'utf8'
    )
    const integrations = readFileSync(
      'src/components/projects/panes/IntegrationsPane.tsx',
      'utf8'
    )

    expect(dialog).toContain("id: 'integrations' as const")
    expect(dialog).toContain('<IntegrationsPane projectId={safeProjectId} />')
    expect(general).not.toContain('Linear Integration')
    expect(general).not.toContain('Sentry Integration')
    expect(integrations).toContain('Linear Integration')
    expect(integrations).toContain('Sentry Integration')
  })
})
