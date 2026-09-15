import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('session menu order', () => {
  it('shows Set Status first in the session tab context menu', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'SessionChatModal.tsx'),
      'utf8'
    )
    const menu = source.match(
      /<ContextMenuContent className="w-64">([\s\S]*?)<ContextMenuSeparator \/>/
    )?.[1]

    expect(menu).toBeDefined()
    expect(menu?.indexOf('<SessionStatusMenu')).toBeLessThan(
      menu?.indexOf('handleStartRename') ?? -1
    )
    expect(menu?.indexOf('<SessionStatusMenu')).toBeLessThan(
      menu?.indexOf('setLabelTargetSessionId') ?? -1
    )
  })
})
