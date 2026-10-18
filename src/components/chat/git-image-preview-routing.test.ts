import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(file: string): string {
  return fs.readFileSync(path.resolve(__dirname, file), 'utf8')
}

describe('Git image preview routing', () => {
  it('passes the worktree path and owner through Changes and Commits', () => {
    const modal = readSource('GitDiffModal.tsx')
    const commits = readSource('CommitsTabView.tsx')

    expect(modal).toContain('resourceOwnerId={diffRequest?.worktreeId}')
    expect(modal).toContain('worktreeId={diffRequest.worktreeId}')
    expect(commits).toContain('rootPath={worktreePath}')
    expect(commits).toContain('resourceOwnerId={worktreeId}')
    expect(commits).toContain('isBinary={selectedFile.isBinary}')
  })
})
