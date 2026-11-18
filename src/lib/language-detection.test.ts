import { describe, expect, it } from 'vitest'
import { getLanguageFromPath, isLanguageSupported } from './language-detection'

describe('C# language detection', () => {
  it('maps C# source files to the Shiki csharp language', () => {
    expect(getLanguageFromPath('src/Services/Example.cs')).toBe('csharp')
    expect(getLanguageFromPath('Example.CS')).toBe('csharp')
    expect(getLanguageFromPath('scripts/build.csx')).toBe('csharp')
  })

  it('reports C# as syntax highlighting supported', () => {
    expect(isLanguageSupported(getLanguageFromPath('Program.cs'))).toBe(true)
  })

  it('does not treat unrelated extensions as C#', () => {
    expect(getLanguageFromPath('views/Index.cshtml')).not.toBe('csharp')
  })
})
