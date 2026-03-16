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
