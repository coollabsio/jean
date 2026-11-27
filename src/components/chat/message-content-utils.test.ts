import { describe, expect, it } from 'vitest'
import {
  appendPromptMetadataToPlainText,
  buildPromptAttachmentMetadata,
  decodePromptAttachmentMetadata,
  encodePromptAttachmentMetadata,
  extractDirectoryMentionPaths,
  parsePlainTextPromptMetadata,
  stripAllMarkers,
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
