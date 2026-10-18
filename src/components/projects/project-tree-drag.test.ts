import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import { haveSameProjectServer } from './project-tree-drag'

const project = (id: string, serverId?: string): Project =>
  ({ id, serverId }) as Project

describe('project tree drag ownership', () => {
  it('allows local items and items from the same remote server', () => {
    expect(haveSameProjectServer(project('one'), project('two'))).toBe(true)
    expect(
      haveSameProjectServer(project('one', 'remote'), project('two', 'remote'))
    ).toBe(true)
  })

  it('blocks drops across Jean servers', () => {
    expect(
      haveSameProjectServer(project('one', 'remote'), project('two', 'other'))
    ).toBe(false)
    expect(
      haveSameProjectServer(project('one'), project('two', 'remote'))
    ).toBe(false)
  })
})
