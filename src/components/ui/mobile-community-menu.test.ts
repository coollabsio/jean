import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mobile community menu actions', () => {
  for (const path of [
    'src/components/chat/toolbar/DockBurgerButton.tsx',
  ]) {
    it(`puts GitHub and Sponsor in ${path}`, () => {
      const source = readFileSync(path, 'utf8')

      expect(source).toContain('Jean on GitHub')
      expect(source).toContain('Sponsor Jean')
      expect(source).toContain("openExternal('https://github.com/coollabsio/jean')")
      expect(source).toContain("openExternal('https://jean.build/sponsorships/')")
    })
  }
})
