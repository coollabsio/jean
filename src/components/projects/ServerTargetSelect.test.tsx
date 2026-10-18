import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ServerTargetSelect } from './ServerTargetSelect'

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () =>
    new Map([
      ['local', { serverId: 'local', name: 'Local', status: 'local' }],
      [
        'dev-server',
        { serverId: 'dev-server', name: 'DEV Server', status: 'online' },
      ],
    ]),
}))

describe('ServerTargetSelect', () => {
  it('uses the shared Jean select control', () => {
    render(<ServerTargetSelect value="dev-server" onChange={() => undefined} />)

    const trigger = screen.getByRole('combobox', { name: 'Jean server' })
    expect(trigger).toHaveAttribute('data-slot', 'select-trigger')
    expect(trigger).toHaveTextContent('DEV Server')
  })
})
