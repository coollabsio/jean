import { describe, expect, it } from 'vitest'
import { getLanguageFromPath } from './language-detection'

describe('getLanguageFromPath', () => {
  it('detects C# source files for syntax highlighting', () => {
    expect(getLanguageFromPath('/projects/Birds/Program.cs')).toBe('csharp')
    expect(getLanguageFromPath('COMPONENT.CS')).toBe('csharp')
  })
})
