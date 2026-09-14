import { describe, expect, it } from 'vitest'
import { resolveHeaderServerLabel } from './server-context'

const remotes = [
  {
    id: 'build',
    name: 'Build server',
    url: 'https://build.test',
    token: 'secret',
    enabled: true,
  },
]

describe('resolveHeaderServerLabel', () => {
  it('shows all servers on the combined dashboard', () => {
    expect(resolveHeaderServerLabel(null, remotes)).toBe('All servers')
  })

  it('shows Local for existing unscoped projects', () => {
    expect(resolveHeaderServerLabel('project-1', remotes)).toBe('Local')
  })

  it('shows the owner name for a remote project', () => {
    expect(resolveHeaderServerLabel('build:project-1', remotes)).toBe(
      'Build server'
    )
  })
})
