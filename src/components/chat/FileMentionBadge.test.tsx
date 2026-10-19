import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { FileMentionBadge } from './FileMentionBadge'

const { preferences } = vi.hoisted(() => ({
  preferences: { show_full_file_path: false },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: preferences }),
}))

vi.mock('@/lib/transport', () => ({
  invokeForOptionalServer: vi.fn(),
}))

const path = 'src/components/Button.tsx'

describe('FileMentionBadge', () => {
  beforeEach(() => {
    preferences.show_full_file_path = false
  })

  it('shows the filename and keeps the full path in the tooltip', async () => {
    render(<FileMentionBadge path={path} worktreePath="/tmp/repo" />)

    const badge = screen.getByRole('button', { name: 'Button.tsx' })
    fireEvent.focus(badge)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(path)
  })

  it('shows the full relative path when the preference is enabled', async () => {
    preferences.show_full_file_path = true
    render(<FileMentionBadge path={path} worktreePath="/tmp/repo" />)

    const badge = screen.getByRole('button', { name: path })
    fireEvent.focus(badge)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(path)
  })

  it('keeps a trailing slash on directory mentions', () => {
    preferences.show_full_file_path = true
    render(
      <FileMentionBadge
        path="packages/web/src"
        worktreePath="/tmp/repo"
        isDirectory
      />
    )

    expect(
      screen.getByRole('button', { name: 'packages/web/src/' })
    ).toBeInTheDocument()
  })

  it('prefixes the tooltip with the source project without dropping the path', async () => {
    render(
      <FileMentionBadge
        path={path}
        worktreePath="/tmp/repo"
        sourceProjectName="web"
      />
    )

    fireEvent.focus(screen.getByRole('button', { name: 'Button.tsx' }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(`web: ${path}`)
  })
})
