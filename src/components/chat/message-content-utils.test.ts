import { describe, expect, it } from 'vitest'
import {
  appendPromptMetadataToPlainText,
  buildPromptAttachmentMetadata,
  decodePromptAttachmentMetadata,
  encodePromptAttachmentMetadata,
  extractDirectoryMentionPaths,
  isAgentUpdateMessage,
  isAgentUpdateTurn,
  parsePlainTextPromptMetadata,
  splitAgentUpdateTurns,
  stripAllMarkers,
  chatContinuedJournalId,
  isChatContinuedMessage,
} from './message-content-utils'

describe('message-content-utils prompt metadata', () => {
  const content = [
    'Please review this',
    '[Image attached: /tmp/image.png - Use the Read tool to view this image]',
    '[Text file attached: /tmp/paste.txt - Use the Read tool to view this file]',
    '[File: src/App.tsx - Use the Read tool to view this file]',
    '[Directory: src/components - Use Glob and Read tools to explore this directory]',
    '[Skill: /Users/me/.codex/skills/foo/SKILL.md - Read and use this skill to guide your response]',
  ].join('\n\n')

  it('builds metadata including images, text files, files, dirs, and skills', () => {
    expect(extractDirectoryMentionPaths(content)).toEqual(['src/components'])

    const metadata = buildPromptAttachmentMetadata(content, path =>
      path.includes('/foo/') ? 'foo' : path
    )

    expect(metadata).toEqual({
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: ['/tmp/paste.txt'],
      files: [
        { path: 'src/App.tsx', isDirectory: false },
        { path: 'src/components', isDirectory: true },
      ],
      skills: [
        {
          name: 'foo',
          path: '/Users/me/.codex/skills/foo/SKILL.md',
        },
      ],
    })
  })

  it('round-trips metadata through plain text sentinel and strips markers', () => {
    const cleanText = stripAllMarkers(content)
    const metadata = buildPromptAttachmentMetadata(content, () => 'foo')
    const copiedText = appendPromptMetadataToPlainText(cleanText, metadata)

    const parsed = parsePlainTextPromptMetadata(copiedText)

    expect(parsed.text).toBe('Please review this')
    expect(parsed.metadata).toEqual(metadata)
  })

  it('decodes old metadata with string file paths', () => {
    const encoded = encodeURIComponent(
      JSON.stringify({
        images: ['/tmp/image.png'],
        textFiles: [],
        files: ['src/App.tsx'],
        skills: [],
      })
    )

    expect(decodePromptAttachmentMetadata(encoded)).toEqual({
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: [],
      files: [{ path: 'src/App.tsx', isDirectory: false }],
      skills: [],
    })
  })

  it('encodes and decodes new metadata', () => {
    const metadata = buildPromptAttachmentMetadata(content, () => 'foo')
    expect(
      decodePromptAttachmentMetadata(encodePromptAttachmentMetadata(metadata))
    ).toEqual(metadata)
  })
})

describe('isAgentUpdateMessage', () => {
  it('detects Jean agent updates, also with skill markers', () => {
    const update =
      '[Jean agent update] Automatic message from Jean, not from the user.\n\n### 1. delegation\nDone.'
    expect(isAgentUpdateMessage(update)).toBe(true)
    expect(
      isAgentUpdateMessage(
        `${update}\n\n[Skill: /s/SKILL.md - Read and use this skill to guide your response]`
      )
    ).toBe(true)
    expect(isAgentUpdateMessage('Please check [Jean agent update]')).toBe(false)
  })
})

describe('chat continued message', () => {
  const content =
    '[Jean chat continued] Automatic message from Jean, not from the user.\nYour previous chat (42 messages) was long, so Jean archived it. Jean saved its end as journal entry #17.'

  it('reads the journal entry and stays in the chat with its recap', () => {
    expect(isChatContinuedMessage(content)).toBe(true)
    expect(chatContinuedJournalId(content)).toBe(17)
    const messages = [
      { role: 'user', content },
      { role: 'assistant', content: 'Saved. Recap: ...' },
    ]
    expect(splitAgentUpdateTurns(messages).chat).toEqual(messages)
  })

  it('has no journal entry when the save failed', () => {
    expect(
      chatContinuedJournalId(
        '[Jean chat continued] Jean could not save it to the journal.'
      )
    ).toBeNull()
    expect(isChatContinuedMessage('hello')).toBe(false)
  })
})

describe('splitAgentUpdateTurns', () => {
  const update = '[Jean agent update] Automatic message from Jean.'
  const msgs = [
    { role: 'user', content: 'Fix 10 issues' },
    { role: 'assistant', content: 'Started 10 sessions.' },
    { role: 'user', content: update },
    { role: 'assistant', content: '#1 is done.' },
    { role: 'assistant', content: 'Nine still run.' },
    { role: 'user', content: 'Status?' },
    { role: 'assistant', content: 'Nine still run.' },
  ]

  it('moves update turns out of the chat', () => {
    const { chat, updates } = splitAgentUpdateTurns(msgs)
    expect(chat.map(m => m.content)).toEqual([
      'Fix 10 issues',
      'Started 10 sessions.',
      'Status?',
      'Nine still run.',
    ])
    expect(updates.map(m => m.content)).toEqual([
      '#1 is done.',
      'Nine still run.',
    ])
  })

  it('returns the same array without updates', () => {
    const plain = msgs.slice(0, 2)
    expect(splitAgentUpdateTurns(plain).chat).toBe(plain)
  })

  it('detects an update turn by the newest user message', () => {
    expect(isAgentUpdateTurn(msgs.slice(0, 4))).toBe(true)
    expect(isAgentUpdateTurn(msgs)).toBe(false)
    expect(isAgentUpdateTurn([])).toBe(false)
  })
})
