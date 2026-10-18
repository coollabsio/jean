import { afterEach, describe, expect, it } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import {
  extractFilePath,
  getCurrentWorktree,
  resolveWorktreeFilePath,
} from './local-file'

describe('extractFilePath', () => {
  it.each([
    [
      '.showreel/out/coolify-showreel.mp4',
      '.showreel/out/coolify-showreel.mp4',
    ],
    ['src/main.ts:42', 'src/main.ts'],
    ['src/main.ts:42:7', 'src/main.ts'],
    ['/tmp/out/report.pdf', '/tmp/out/report.pdf'],
    ['C:\\repo\\file.txt', 'C:\\repo\\file.txt'],
    ['config/.env', 'config/.env'],
  ])('detects %s', (text, expected) => {
    expect(extractFilePath(text)).toBe(expected)
  })

  it.each([
    'console.log',
    'bun run check:all',
    'https://example.com/file.zip',
    'src/components',
    '.showreel/node_modules/ffmpeg -i out.mp4',
  ])('ignores %s', text => {
    expect(extractFilePath(text)).toBeNull()
  })
})

describe('resolveWorktreeFilePath', () => {
  it('joins relative paths with the worktree root', () => {
    expect(resolveWorktreeFilePath('./out/a.mp4', '/repo/')).toBe(
      '/repo/out/a.mp4'
    )
    expect(resolveWorktreeFilePath('out\\a.mp4', 'C:\\repo')).toBe(
      'C:\\repo\\out\\a.mp4'
    )
  })

  it('keeps absolute paths and needs a root for relative paths', () => {
    expect(resolveWorktreeFilePath('/tmp/a.txt', null)).toBe('/tmp/a.txt')
    expect(resolveWorktreeFilePath('a/b.txt', null)).toBeNull()
  })
})

describe('getCurrentWorktree', () => {
  afterEach(() => {
    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useChatStore.setState({
      activeWorktreeId: null,
      activeWorktreePath: null,
      worktreePaths: {},
    })
  })

  it('uses the active worktree when the session modal is closed', () => {
    useChatStore.setState({
      activeWorktreeId: 'wt-active',
      activeWorktreePath: '/repo/active',
    })
    expect(getCurrentWorktree()).toEqual({
      id: 'wt-active',
      path: '/repo/active',
    })
  })

  it('uses the session modal worktree on the canvas view', () => {
    useChatStore.setState({
      activeWorktreeId: null,
      activeWorktreePath: null,
      worktreePaths: { 'wt-modal': '/repo/modal' },
    })
    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'wt-modal',
    })
    expect(getCurrentWorktree()).toEqual({
      id: 'wt-modal',
      path: '/repo/modal',
    })
    expect(resolveWorktreeFilePath('docs/a.txt')).toBe('/repo/modal/docs/a.txt')
  })
})
