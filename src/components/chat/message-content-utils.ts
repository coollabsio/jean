/** Regex to extract image paths from message content */
const IMAGE_ATTACHMENT_REGEX =
  /\[Image attached: (.+?) - Use the Read tool to view this image\]/g

/** Regex to extract text file paths from message content */
const TEXT_FILE_ATTACHMENT_REGEX =
  /\[Text file attached: (.+?) - Use the Read tool to view this file\]/g

/** Regex to extract file mention paths from message content */
const FILE_MENTION_REGEX =
  /\[File: (.+?) - Use the Read tool to view this file\]/g

/** Regex to extract directory mention paths from message content */
const DIRECTORY_MENTION_REGEX =
  /\[Directory: (.+?) - Use Glob and Read tools to explore this directory\]/g

/** Regex to extract skill paths from message content */
const SKILL_ATTACHMENT_REGEX =
  /\[Skill: (.+?) - Read and use this skill to guide your response\]/g

const JEAN_PROMPT_TEXT_METADATA_REGEX =
  /\n?\n?<!-- jean-prompt:([^>]+) -->\s*$/u

export interface PromptAttachmentMetadata {
  v: 1
  images: string[]
  textFiles: string[]
  files: { path: string; isDirectory: boolean }[]
  skills: { name: string; path: string }[]
}

interface LegacyPromptAttachmentMetadata {
  v?: number
  images?: string[]
  textFiles?: string[]
  files?: string[] | { path: string; isDirectory?: boolean }[]
  skills?: { name: string; path: string }[]
}

/** Extract image paths from message content */
export function extractImagePaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = IMAGE_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  IMAGE_ATTACHMENT_REGEX.lastIndex = 0
  return paths
}

/** Extract text file paths from message content */
export function extractTextFilePaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = TEXT_FILE_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  TEXT_FILE_ATTACHMENT_REGEX.lastIndex = 0
  return paths
}

/** Remove image attachment markers from content for cleaner display */
export function stripImageMarkers(content: string): string {
  return content.replace(IMAGE_ATTACHMENT_REGEX, '').trim()
}

/** Remove text file attachment markers from content for cleaner display */
export function stripTextFileMarkers(content: string): string {
  return content.replace(TEXT_FILE_ATTACHMENT_REGEX, '').trim()
}

/** Extract file mention paths from message content (deduplicated) */
export function extractFileMentionPaths(content: string): string[] {
  const paths = new Set<string>()
  let match
  while ((match = FILE_MENTION_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.add(match[1])
    }
  }
  // Reset regex lastIndex for next use
  FILE_MENTION_REGEX.lastIndex = 0
  return Array.from(paths)
}

/** Remove file mention markers from content for cleaner display */
export function stripFileMentionMarkers(content: string): string {
  return content.replace(FILE_MENTION_REGEX, '').trim()
}

/** Extract directory mention paths from message content (deduplicated) */
export function extractDirectoryMentionPaths(content: string): string[] {
  const paths = new Set<string>()
  let match
  while ((match = DIRECTORY_MENTION_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.add(match[1])
    }
  }
  DIRECTORY_MENTION_REGEX.lastIndex = 0
  return Array.from(paths)
}

/** Build attachment metadata from a sent user message. */
export function buildPromptAttachmentMetadata(
  content: string,
  getSkillName: (path: string) => string
): PromptAttachmentMetadata {
  const fileMentions = extractFileMentionPaths(content).map(path => ({
    path,
    isDirectory: false,
  }))
  const directoryMentions = extractDirectoryMentionPaths(content).map(path => ({
    path,
    isDirectory: true,
  }))

  return {
    v: 1,
    images: extractImagePaths(content),
    textFiles: extractTextFilePaths(content),
    files: [...fileMentions, ...directoryMentions],
    skills: extractSkillPaths(content).map(path => ({
      name: getSkillName(path),
      path,
    })),
  }
}

function normalizePromptAttachmentMetadata(
  metadata: LegacyPromptAttachmentMetadata
): PromptAttachmentMetadata {
  return {
    v: 1,
    images: metadata.images ?? [],
    textFiles: metadata.textFiles ?? [],
    files: (metadata.files ?? []).map(file =>
      typeof file === 'string'
        ? { path: file, isDirectory: false }
        : { path: file.path, isDirectory: file.isDirectory ?? false }
    ),
    skills: metadata.skills ?? [],
  }
}

export function encodePromptAttachmentMetadata(
  metadata: PromptAttachmentMetadata
): string {
  return encodeURIComponent(JSON.stringify(metadata))
}

export function decodePromptAttachmentMetadata(
  encoded: string
): PromptAttachmentMetadata | null {
  try {
    return normalizePromptAttachmentMetadata(
      JSON.parse(decodeURIComponent(encoded)) as LegacyPromptAttachmentMetadata
    )
  } catch {
    return null
  }
}

/** Append hidden-ish metadata for plain-text-only clipboard fallbacks. */
export function appendPromptMetadataToPlainText(
  text: string,
  metadata: PromptAttachmentMetadata
): string {
  return `${text}\n\n<!-- jean-prompt:${encodePromptAttachmentMetadata(metadata)} -->`
}

/** Parse and strip plain-text fallback metadata from pasted text. */
export function parsePlainTextPromptMetadata(text: string): {
  text: string
  metadata: PromptAttachmentMetadata | null
} {
  const match = text.match(JEAN_PROMPT_TEXT_METADATA_REGEX)
  if (!match?.[1]) return { text, metadata: null }
  return {
    text: text.replace(JEAN_PROMPT_TEXT_METADATA_REGEX, ''),
    metadata: decodePromptAttachmentMetadata(match[1]),
  }
}

/** Remove directory mention markers from content for cleaner display */
export function stripDirectoryMentionMarkers(content: string): string {
  return content.replace(DIRECTORY_MENTION_REGEX, '').trim()
}

/** Extract skill paths from message content (deduplicated) */
export function extractSkillPaths(content: string): string[] {
  const paths = new Set<string>()
  let match
  while ((match = SKILL_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.add(match[1])
    }
  }
  // Reset regex lastIndex for next use
  SKILL_ATTACHMENT_REGEX.lastIndex = 0
  return Array.from(paths)
}

/** Remove skill attachment markers from content for cleaner display */
export function stripSkillMarkers(content: string): string {
  return content.replace(SKILL_ATTACHMENT_REGEX, '').trim()
}

/** Strip all attachment markers from message content */
export function stripAllMarkers(content: string): string {
  return stripSkillMarkers(
    stripDirectoryMentionMarkers(
      stripFileMentionMarkers(stripTextFileMarkers(stripImageMarkers(content)))
    )
  )
}
