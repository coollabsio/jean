import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('project row activity time', () => {
  it('shows relative time without a leading clock icon', () => {
    const source = readFileSync(
      'src/components/dashboard/ProjectCanvasView.tsx',
      'utf8'
    )

    expect(source).not.toContain('<Clock3 className="h-3 w-3" />')
    expect(source).toContain('{lastActivity}')
  })
})
