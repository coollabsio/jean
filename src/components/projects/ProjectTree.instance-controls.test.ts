import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('project instance controls', () => {
  it('uses one stateful expansion control beside each instance label', () => {
    const source = readFileSync(
      'src/components/projects/ProjectTree.tsx',
      'utf8'
    )

    expect(source).toContain('data-testid="instance-title-actions"')
    expect(source).toContain('!areAllProjectsExpanded')
    expect(source).toContain(
      '<DisclosureChevron open={areAllProjectsExpanded} />'
    )
  })
})
