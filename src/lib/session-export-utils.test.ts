import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import {
  generateExportFileName,
  getSessionForExport,
  copyTextToClipboard,
  writeSessionExportFile,
} from './session-export-utils'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: vi.fn(),
}))

describe('session export utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
    })

    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    })
  })
  it('fetches session for export using camelCase get_session args', async () => {
    const mockSession = {
      id: 'session-1',
      name: 'Session 1',
      order: 0,
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
      messages: [],
      backend: 'claude',
    }

    vi.mocked(invoke).mockResolvedValueOnce(mockSession)

    const result = await getSessionForExport('wt-1', '/tmp/wt', 'session-1')

    expect(result).toEqual(mockSession)
    expect(invoke).toHaveBeenCalledWith('get_session', {
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      sessionId: 'session-1',
    })
  })

  it('writes export file into session-exports after ensuring directory exists', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    const relativePath = await writeSessionExportFile(
      '/tmp/worktree',
      'session.md',
      '# Session'
    )

    expect(relativePath).toBe('session-exports/session.md')
    expect(invoke).toHaveBeenNthCalledWith(1, 'create_dir_all', {
      path: '/tmp/worktree/session-exports',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'write_file_content', {
      path: '/tmp/worktree/session-exports/session.md',
      content: '# Session',
    })
  })

  it('falls back to document.execCommand when navigator clipboard is denied', async () => {
    vi.mocked(isNativeApp).mockReturnValue(false)

    const denied = new DOMException('Denied', 'NotAllowedError')
    const writeTextMock = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(denied)

    const execSpy = vi
      .spyOn(document, 'execCommand')
      .mockImplementation(() => true)

    await copyTextToClipboard('hello')

    expect(writeTextMock).toHaveBeenCalledWith('hello')
    expect(execSpy).toHaveBeenCalledWith('copy')
  })

  it('throws when both browser clipboard and fallback copy fail', async () => {
    vi.mocked(isNativeApp).mockReturnValue(false)

    const denied = new DOMException('Denied', 'NotAllowedError')
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(denied)

    vi.spyOn(document, 'execCommand').mockImplementation(() => false)

    await expect(copyTextToClipboard('hello')).rejects.toThrowError(
      /NotAllowedError|Denied/
    )
  })

  it('creates a sanitized export file name with markdown extension', () => {
    const fileName = generateExportFileName('My Session: test/export!')

    expect(fileName).toMatch(/^my-session-test-export-\d{4}-\d{2}-\d{2}\.md$/)
  })

  it('falls back to date-only filename when session name sanitizes to empty', () => {
    const fileName = generateExportFileName('!!!')

    expect(fileName).toMatch(/^-\d{4}-\d{2}-\d{2}\.md$/)
  })
})
