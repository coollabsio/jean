import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MainWindowContent project loading fallback', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/layout/MainWindowContent.tsx`,
    'utf8'
  )

  it('reuses the Jean loading screen to avoid a loading-state flicker', () => {
    expect(source).toContain(
      "import { JeanLoadingScreen } from '@/components/shared/JeanLoadingScreen'"
    )
    expect(source).toContain('fallback={<JeanLoadingScreen />}')
    expect(source).not.toContain('Loading project')
  })
})
