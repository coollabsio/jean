import type { QueuedMessage } from '@/types/chat'

const IMAGE_ONLY_DEFAULT_PROMPT =
  'Please check this image and tell me what is wrong.'

function fileReferencePath(file: QueuedMessage['pendingFiles'][number]) {
  if (!file.sourceRootPath) return file.relativePath
  return `${file.sourceRootPath.replace(/\/+$/, '')}/${file.relativePath.replace(/^\/+/, '')}`
}

/**
 * Build full message text with attachment references for the backend.
 *
 * When the user sends only an image, include a natural instruction before the
 * internal image path reference so the backend receives an actionable prompt.
 */
export function buildMessageWithRefs(queuedMsg: QueuedMessage): string {
  let message = queuedMsg.message

  if (queuedMsg.pendingFiles.length > 0) {
    const fileRefs = queuedMsg.pendingFiles
      .map(f => {
        const path = fileReferencePath(f)
        return f.isDirectory
          ? `[Directory: ${path} - Use Glob and Read tools to explore this directory]`
          : `[File: ${path} - Use the Read tool to view this file]`
      })
      .join('\n')
    message = message ? `${message}\n\n${fileRefs}` : fileRefs
  }

  if (queuedMsg.pendingSkills.length > 0) {
    const skillRefs = queuedMsg.pendingSkills
      .map(
        s =>
          `[Skill: ${s.path} - Read and use this skill to guide your response]`
      )
      .join('\n')
    message = message ? `${message}\n\n${skillRefs}` : skillRefs
  }

  if (queuedMsg.pendingImages.length > 0) {
    if (!message) {
      message = IMAGE_ONLY_DEFAULT_PROMPT
    }
    const imageRefs = queuedMsg.pendingImages
      .map(
        img =>
          `[Image attached: ${img.path} - Use the Read tool to view this image]`
      )
      .join('\n')
    message = `${message}\n\n${imageRefs}`
  }

  if (queuedMsg.pendingTextFiles.length > 0) {
    if (!message) {
      message = 'Please check the attached text as reference.'
    }
    const textFileRefs = queuedMsg.pendingTextFiles
      .map(
        tf =>
          `[Text file attached: ${tf.path} - Use the Read tool to view this file]`
      )
      .join('\n')
    message = `${message}\n\n${textFileRefs}`
  }

  return message
}
