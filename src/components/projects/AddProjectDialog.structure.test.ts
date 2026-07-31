import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-structure guards for New Project + remote directory browser.
 * Nested Radix dialogs trap focus poorly and have been tied to WebView2
 * freezes when alt-tabbing on Windows (issue #575).
 */
describe('AddProjectDialog structure', () => {
  const source = readFileSync(
    resolve(__dirname, 'AddProjectDialog.tsx'),
    'utf8'
  )

  it('does not nest DirectoryBrowser inside the New Project Dialog', () => {
    // DirectoryBrowser must be a sibling fragment child, not under <Dialog>.
    expect(source).toMatch(
      /return \(\s*<>[\s\S]*<Dialog[\s\S]*<\/Dialog>[\s\S]*<DirectoryBrowser/
    )
    // Guard against re-introducing nested-dialog markup.
    expect(source).not.toMatch(
      /<Dialog[^>]*>[\s\S]*<>[\s\S]*<DirectoryBrowser/
    )
  })

  it('keeps New Project open under the remote directory browser', () => {
    // Sibling dialogs: New Project stays mounted so canceling the browser
    // returns to it (no controlled-open race with browserMode).
    expect(source).toContain('open={addProjectDialogOpen}')
    expect(source).not.toContain(
      'open={addProjectDialogOpen && browserMode === null}'
    )
  })
})
