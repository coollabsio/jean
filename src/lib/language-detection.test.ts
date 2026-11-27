import { bundledLanguages } from 'shiki'
import { describe, expect, it } from 'vitest'
import { getLanguageFromPath } from './language-detection'

describe('C# language detection', () => {
  it('maps C# source files to the Shiki csharp language', () => {
    expect(getLanguageFromPath('src/Services/Example.cs')).toBe('csharp')
    expect(getLanguageFromPath('Example.CS')).toBe('csharp')
    expect(getLanguageFromPath('scripts/build.csx')).toBe('csharp')
    expect(getLanguageFromPath('C:\\repo\\src\\Program.cs')).toBe('csharp')
  })

  it('uses a language id that Shiki bundles', () => {
    expect(getLanguageFromPath('Program.cs')).toBeOneOf(
      Object.keys(bundledLanguages)
    )
  })

  it('does not treat unrelated extensions as C#', () => {
    expect(getLanguageFromPath('views/Index.cshtml')).not.toBe('csharp')
  })
})
