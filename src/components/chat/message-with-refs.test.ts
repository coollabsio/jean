import { describe, expect, it } from 'vitest'
import { buildMessageWithRefs } from './message-with-refs'
import type { QueuedMessage } from '@/types/chat'

function queuedMessage(overrides: Partial<QueuedMessage>): QueuedMessage {
  return {
    id: 'queued-1',
    message: '',
    pendingImages: [],
    pendingFiles: [],
    pendingSkills: [],
    pendingTextFiles: [],
    model: 'sonnet',
    provider: null,
    executionMode: 'build',
    thinkingLevel: 'off',
    queuedAt: 1,
    ...overrides,
  }
}

describe('buildMessageWithRefs', () => {
  it('adds one context line per agent chat mention', () => {
    // Same input and output as the jean-core queued message test
    const message = buildMessageWithRefs(
      queuedMessage({
        message: 'Ask @Reviewer about @coolify on @home',
        mentions: [
          { type: 'agent', id: 'reviewer-1', name: 'Reviewer' },
          {
            type: 'project',
            id: 'p-9',
            name: 'coolify',
            serverName: 'Home',
          },
          {
            type: 'remote_jean',
            id: 'srv-1',
            name: 'home',
            url: 'https://home.example',
          },
        ],
      })
    )

    expect(message).toBe(
      'Ask @Reviewer about @coolify on @home\n\n[Mentioned agent: Reviewer (agentId: reviewer-1)]\n[Mentioned project: coolify (projectId: p-9, on remote Jean: Home)]\n[Mentioned remote Jean: home (serverId: srv-1, url: https://home.example)]'
    )
  })

  it('adds a natural default prompt for image-only messages', () => {
    const message = buildMessageWithRefs(
      queuedMessage({
        pendingImages: [
          {
            id: 'img-1',
            path: '/tmp/screenshot.png',
            filename: 'screenshot.png',
          },
        ],
      })
    )

    expect(message).toBe(
      'Please check this image and tell me what is wrong.\n\n[Image attached: /tmp/screenshot.png - Use the Read tool to view this image]'
    )
  })

  it('keeps user text before image references', () => {
    const message = buildMessageWithRefs(
      queuedMessage({
        message: 'What does this error mean?',
        pendingImages: [
          {
            id: 'img-1',
            path: '/tmp/error.png',
            filename: 'error.png',
          },
        ],
      })
    )

    expect(message).toBe(
      'What does this error mean?\n\n[Image attached: /tmp/error.png - Use the Read tool to view this image]'
    )
  })

  it('keeps existing attachment references before image references', () => {
    const message = buildMessageWithRefs(
      queuedMessage({
        pendingFiles: [
          {
            id: 'file-1',
            relativePath: 'src/App.tsx',
            extension: 'tsx',
            isDirectory: false,
          },
        ],
        pendingImages: [
          {
            id: 'img-1',
            path: '/tmp/screenshot.png',
            filename: 'screenshot.png',
          },
        ],
      })
    )

    expect(message).toBe(
      '[File: src/App.tsx - Use the Read tool to view this file]\n\n[Image attached: /tmp/screenshot.png - Use the Read tool to view this image]'
    )
  })

  it('uses absolute paths for linked-project file references', () => {
    const message = buildMessageWithRefs(
      queuedMessage({
        pendingFiles: [
          {
            id: 'file-1',
            relativePath: 'docs/intro.md',
            sourceRootPath: '/tmp/docs',
            sourceProjectId: 'docs',
            sourceProjectName: 'Docs',
            extension: 'md',
            isDirectory: false,
          },
        ],
      })
    )

    expect(message).toBe(
      '[File: /tmp/docs/docs/intro.md - Use the Read tool to view this file]'
    )
  })
})
