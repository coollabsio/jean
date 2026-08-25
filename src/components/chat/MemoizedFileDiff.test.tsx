import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { FileDiffMetadata } from '@pierre/diffs'
import { useUIStore } from '@/store/ui-store'
import { MemoizedFileDiff } from './MemoizedFileDiff'

const binaryImageDiff: FileDiffMetadata = {
  name: 'coolify-sponsors.png',
  type: 'new',
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: true,
  deletionLines: [],
  additionLines: [],
}

describe('MemoizedFileDiff', () => {
  it('previews binary images and opens them in the file viewer', () => {
    useUIStore.getState().setViewingFilePath(null)
    render(
      <MemoizedFileDiff
        fileDiff={binaryImageDiff}
        fileName="coolify-sponsors.png"
        rootPath="/repo/worktree"
        isBinary
        annotations={[]}
        selectedLines={null}
        themeType="dark"
        syntaxThemeDark="vitesse-black"
        syntaxThemeLight="github-light"
        diffStyle="unified"
        onLineSelected={() => undefined}
        onRemoveComment={() => undefined}
      />
    )

    const preview = screen.getByRole('img', {
      name: 'Preview coolify-sponsors.png',
    })
    expect(preview).toHaveAttribute(
      'src',
      '/api/project-files/%2Frepo%2Fworktree%2Fcoolify-sponsors.png'
    )

    fireEvent.click(preview)
    expect(useUIStore.getState().viewingFilePath).toBe(
      '/repo/worktree/coolify-sponsors.png'
    )
  })
})
