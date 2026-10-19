import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import { FilePreview } from './FilePreview'
import type { PendingFile } from '@/types/chat'

const { preferences } = vi.hoisted(() => ({
  preferences: { show_full_file_path: false },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: preferences }),
}))

const file: PendingFile = {
  id: 'file-1',
  relativePath: 'packages/web/src/components/Button.tsx',
  extension: 'tsx',
  isDirectory: false,
}

const directory: PendingFile = {
  id: 'dir-1',
  relativePath: 'packages/mobile/src',
  extension: '',
  isDirectory: true,
}

describe('FilePreview', () => {
  beforeEach(() => {
    preferences.show_full_file_path = false
  })

  it('shows filenames and the full path in the tooltip', async () => {
    const user = userEvent.setup()
    render(<FilePreview files={[file]} onRemove={vi.fn()} />)

    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.queryByText(file.relativePath)).not.toBeInTheDocument()

    await user.hover(screen.getByText('Button.tsx'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      file.relativePath
    )
  })

  it('shows the full relative path when the preference is enabled', async () => {
    preferences.show_full_file_path = true
    const user = userEvent.setup()
    render(
      <FilePreview
        files={[{ ...file, sourceProjectName: 'web' }]}
        onRemove={vi.fn()}
      />
    )

    expect(screen.getByText(file.relativePath)).toBeInTheDocument()

    await user.hover(screen.getByText(file.relativePath))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      `web: ${file.relativePath}`
    )
  })

  it('keeps a trailing slash on directory mentions', () => {
    preferences.show_full_file_path = true
    render(<FilePreview files={[directory]} onRemove={vi.fn()} />)

    expect(screen.getByText('packages/mobile/src/')).toBeInTheDocument()
  })

  it('removes a pending file from the filename badge', () => {
    const onRemove = vi.fn()
    render(<FilePreview files={[file]} onRemove={onRemove} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }))

    expect(onRemove).toHaveBeenCalledWith(file.id)
  })
})
