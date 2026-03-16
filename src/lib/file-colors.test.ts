import { describe, it, expect } from 'vitest'
import {
  getExtensionColor,
  getExtension,
  EXTENSION_COLORS,
} from './file-colors'

describe('getExtensionColor', () => {
  it('returns correct color for TypeScript files', () => {
    expect(getExtensionColor('ts')).toBe('text-blue-500')
    expect(getExtensionColor('tsx')).toBe('text-blue-500')
  })

  it('returns correct color for JavaScript files', () => {
    expect(getExtensionColor('js')).toBe('text-yellow-500')
    expect(getExtensionColor('jsx')).toBe('text-yellow-500')
  })

  it('returns correct color for Rust files', () => {
    expect(getExtensionColor('rs')).toBe('text-orange-500')
  })

  it('returns correct color for Python files', () => {
    expect(getExtensionColor('py')).toBe('text-green-500')
  })

  it('returns correct color for config files', () => {
    expect(getExtensionColor('json')).toBe('text-yellow-600')
    expect(getExtensionColor('toml')).toBe('text-gray-400')
    expect(getExtensionColor('yaml')).toBe('text-red-400')
    expect(getExtensionColor('yml')).toBe('text-red-400')
  })

  it('returns correct color for markup files', () => {
    expect(getExtensionColor('md')).toBe('text-gray-500')
    expect(getExtensionColor('html')).toBe('text-orange-400')
    expect(getExtensionColor('css')).toBe('text-pink-500')
  })

  it('returns fallback color for unknown extensions', () => {
    expect(getExtensionColor('unknown')).toBe('text-muted-foreground')
    expect(getExtensionColor('')).toBe('text-muted-foreground')
    expect(getExtensionColor('xyz')).toBe('text-muted-foreground')
  })
})

describe('getExtension', () => {
  it('extracts extension from simple filename', () => {
    expect(getExtension('file.ts')).toBe('ts')
    expect(getExtension('component.tsx')).toBe('tsx')
    expect(getExtension('data.json')).toBe('json')
  })

  it('extracts extension from path', () => {
    expect(getExtension('src/lib/utils.ts')).toBe('ts')
    expect(getExtension('/home/user/project/main.rs')).toBe('rs')
    expect(getExtension('components/Button/index.tsx')).toBe('tsx')
  })

  it('handles files with multiple dots', () => {
    expect(getExtension('file.test.ts')).toBe('ts')
    expect(getExtension('component.stories.tsx')).toBe('tsx')
    expect(getExtension('config.production.json')).toBe('json')
  })

  it('returns lowercase extension', () => {
    expect(getExtension('FILE.TS')).toBe('ts')
    expect(getExtension('README.MD')).toBe('md')
    expect(getExtension('Data.JSON')).toBe('json')
  })

  it('returns empty string for files without extension', () => {
    expect(getExtension('Makefile')).toBe('')
    expect(getExtension('Dockerfile')).toBe('')
    expect(getExtension('.gitignore')).toBe('gitignore')
  })

  it('handles edge cases', () => {
    expect(getExtension('')).toBe('')
    expect(getExtension('.')).toBe('')
    expect(getExtension('file.')).toBe('')
  })
})

describe('EXTENSION_COLORS constant', () => {
  it('has all expected extensions', () => {
    const expectedExtensions = [
      'ts',
      'tsx',
      'js',
      'jsx',
      'rs',
      'py',
      'json',
      'md',
      'css',
      'html',
      'toml',
      'yaml',
      'yml',
    ]
    expectedExtensions.forEach(ext => {
      expect(EXTENSION_COLORS).toHaveProperty(ext)
    })
  })
})
