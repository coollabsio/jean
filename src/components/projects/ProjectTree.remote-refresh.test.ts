import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectTree remote refresh control', () => {
  it('shows the refresh control for remote server sections', () => {
    const source = readFileSync(
      'src/components/projects/ProjectTree.tsx',
      'utf8'
    )

    expect(source).toContain('<RemoteServerRefreshButton')
    expect(source).toContain('serverId={section.id}')
  })
})
