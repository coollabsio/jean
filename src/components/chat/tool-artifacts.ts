import type { ToolCall } from '@/types/chat'

export type ToolArtifactType = 'image' | 'link' | 'file'

export interface ToolArtifactAction {
  label: string
  url?: string
  path?: string
}

export interface ToolArtifact {
  id: string
  type: ToolArtifactType
  title: string
  subtitle?: string
  url?: string
  path?: string
  alt?: string
  actions?: ToolArtifactAction[]
}

const MAX_VISIT_DEPTH = 8
const MAX_PARSED_TEXT_LENGTH = 200_000
const IMAGE_URL_RE =
  /\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#].*)?$/i
const CANVA_THUMBNAIL_HOST_RE =
  /^https:\/\/(?:design\.canva\.ai|document-export\.canva\.com)\//i
const SIGNED_URL_RE = /[?&](?:X-Amz-Signature|Expires|Signature)=/i
const URL_RE = /https?:\/\/[^\s"'<>)}\]]+/gi
const ABSOLUTE_PATH_RE =
  /(?:^|[\s(["'])((?:\/(?:home|tmp|var|mnt|workspace|Users)\/)[^\s"'<>)}\]]+)/g
const FILE_FIELD_NAMES = new Set([
  'path',
  'file',
  'file_path',
  'filepath',
  'output_path',
  'artifact_path',
  'design_file',
])
const URL_FIELD_NAMES = new Set([
  'url',
  'open_url',
  'openUrl',
  'edit_url',
  'editUrl',
  'view_url',
  'viewUrl',
  'create_url',
  'createUrl',
])

export function extractToolArtifacts(
  toolCall: Pick<ToolCall, 'name' | 'output'>
): ToolArtifact[] {
  if (toolCall.name === 'FileChange' || toolCall.name === 'Monitor') return []
  if (!toolCall.output) return []

  const collector = new ArtifactCollector(toolCall.name)
  for (const value of expandToolOutput(toolCall.output)) {
    visitValue(value, [], collector, 0)
  }
  return collector.toArray()
}

export function sanitizeToolOutput(
  output: string | undefined,
  artifacts: ToolArtifact[]
): string {
  if (!output) return ''

  let sanitized = output
  for (const artifact of artifacts) {
    if (artifact.type !== 'image' || !artifact.url) continue
    sanitized = sanitized
      .split(artifact.url)
      .join('[image preview URL redacted]')
  }

  return sanitized.replace(URL_RE, url =>
    SIGNED_URL_RE.test(url) ? '[signed preview URL redacted]' : url
  )
}

class ArtifactCollector {
  private readonly seen = new Set<string>()
  private readonly artifacts: ToolArtifact[] = []

  constructor(private readonly toolName: string) {}

  add(artifact: Omit<ToolArtifact, 'id'>): void {
    const identity = [
      artifact.type,
      artifact.url ?? '',
      artifact.path ?? '',
    ].join('|')
    if (this.seen.has(identity)) return
    this.seen.add(identity)
    this.artifacts.push({
      ...artifact,
      id: `${this.toolName || 'tool'}-${this.artifacts.length}-${hashIdentity(identity)}`,
    })
  }

  toArray(): ToolArtifact[] {
    return this.artifacts
  }
}

function expandToolOutput(output: string): unknown[] {
  const values: unknown[] = [output]
  const parsed = parseJsonMaybe(output)
  if (parsed !== undefined) values.push(parsed)
  return values
}

function visitValue(
  value: unknown,
  path: string[],
  collector: ArtifactCollector,
  depth: number
): void {
  if (depth > MAX_VISIT_DEPTH) return

  if (typeof value === 'string') {
    const parsed = parseJsonMaybe(value)
    if (parsed !== undefined) {
      visitValue(parsed, path, collector, depth + 1)
      return
    }
    collectFromText(value, collector)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitValue(item, [...path, String(index)], collector, depth + 1)
    )
    return
  }

  if (!isRecord(value)) return

  collectRecordArtifacts(value, path, collector)

  for (const [key, child] of Object.entries(value)) {
    if (shouldSkipNestedLinkKey(value, key)) continue
    visitValue(child, [...path, key], collector, depth + 1)
  }
}

function collectRecordArtifacts(
  record: Record<string, unknown>,
  path: string[],
  collector: ArtifactCollector
): void {
  collectDesignLink(record, collector)
  collectNestedThumbnails(record, collector)
  collectNestedDesignLinks(record, collector)
  collectThumbnail(record, path, collector)
  collectFieldUrls(record, path, collector)
  collectFieldPaths(record, collector)
}

function collectDesignLink(
  record: Record<string, unknown>,
  collector: ArtifactCollector,
  titleOverride?: string
): void {
  const editUrl = getString(record.edit_url) ?? getString(record.editUrl)
  const viewUrl = getString(record.view_url) ?? getString(record.viewUrl)
  if (!editUrl && !viewUrl) return

  const title = titleOverride ?? getTitle(record) ?? 'Design'
  const actions = compactActions([
    editUrl ? { label: 'Edit', url: editUrl } : undefined,
    viewUrl ? { label: 'View', url: viewUrl } : undefined,
  ])

  collector.add({
    type: 'link',
    title,
    subtitle: 'Canva design',
    url: viewUrl ?? editUrl,
    actions,
  })
}

function collectNestedDesignLinks(
  record: Record<string, unknown>,
  collector: ArtifactCollector
): void {
  if (record.thumbnail || record.thumbnails) return

  for (const key of ['urls', 'links']) {
    const nested = record[key]
    if (!isRecord(nested)) continue
    collectDesignLink(nested, collector, getTitle(record))
  }
}

function collectNestedThumbnails(
  record: Record<string, unknown>,
  collector: ArtifactCollector
): void {
  const nestedThumbnails = [
    record.thumbnail,
    ...(Array.isArray(record.thumbnails) ? record.thumbnails : []),
  ]

  for (const thumbnail of nestedThumbnails) {
    if (!isRecord(thumbnail)) continue

    const url = getString(thumbnail.url)
    if (!url || !isHttpUrl(url)) continue
    if (!isImageUrl(url) && !isThumbnailContext(['thumbnail'], thumbnail)) {
      continue
    }

    const title = getTitle(record) ?? getTitle(thumbnail) ?? 'Preview'
    collector.add({
      type: 'image',
      title,
      subtitle: 'Image preview',
      url,
      alt: title,
      actions: imageActionsFromRecords(record, thumbnail),
    })
  }
}

function collectThumbnail(
  record: Record<string, unknown>,
  path: string[],
  collector: ArtifactCollector
): void {
  const url = getString(record.url)
  if (!url || !isHttpUrl(url)) return
  if (!isThumbnailContext(path, record) && !isImageUrl(url)) return

  const title = getTitle(record) ?? 'Preview'
  const openUrl = getString(record.open_url) ?? getString(record.openUrl)
  const designUrl =
    !isImageUrl(url) && !CANVA_THUMBNAIL_HOST_RE.test(url)
      ? undefined
      : getString(record.design_url) ??
        getString(record.designUrl) ??
        getString(record.view_url) ??
        getString(record.viewUrl)
  const fallbackUrl =
    getString(record.create_url) ?? getString(record.createUrl)
  const actions = compactActions([
    openUrl ? { label: 'Open', url: openUrl } : undefined,
    designUrl ? { label: 'View', url: designUrl } : undefined,
    fallbackUrl ? { label: 'Open', url: fallbackUrl } : undefined,
  ])

  collector.add({
    type: 'image',
    title,
    subtitle: 'Image preview',
    url,
    alt: title,
    actions,
  })
}

function imageActionsFromRecords(
  record: Record<string, unknown>,
  thumbnail: Record<string, unknown>
): ToolArtifactAction[] {
  const thumbnailOpenUrl =
    getString(thumbnail.open_url) ?? getString(thumbnail.openUrl)
  const editUrl = getString(record.edit_url) ?? getString(record.editUrl)
  const viewUrl = getString(record.view_url) ?? getString(record.viewUrl)
  const nestedUrls = getNestedUrlRecord(record)
  const nestedEditUrl =
    getString(nestedUrls?.edit_url) ?? getString(nestedUrls?.editUrl)
  const nestedViewUrl =
    getString(nestedUrls?.view_url) ?? getString(nestedUrls?.viewUrl)
  const openUrl = getString(record.url)

  return compactActions([
    thumbnailOpenUrl ? { label: 'Open', url: thumbnailOpenUrl } : undefined,
    editUrl ?? nestedEditUrl
      ? { label: 'Edit', url: editUrl ?? nestedEditUrl }
      : undefined,
    viewUrl ?? nestedViewUrl
      ? { label: 'View', url: viewUrl ?? nestedViewUrl }
      : undefined,
    openUrl ? { label: 'Open', url: openUrl } : undefined,
  ])
}

function getNestedUrlRecord(
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  for (const key of ['urls', 'links']) {
    const nested = record[key]
    if (isRecord(nested)) return nested
  }
  return undefined
}

function collectFieldUrls(
  record: Record<string, unknown>,
  path: string[],
  collector: ArtifactCollector
): void {
  for (const [key, value] of Object.entries(record)) {
    if (!URL_FIELD_NAMES.has(key) || typeof value !== 'string') continue
    if (!isHttpUrl(value)) continue
    if (isThumbnailContext([...path, key], record) || isImageUrl(value)) {
      collector.add({
        type: 'image',
        title: getTitle(record) ?? 'Preview',
        subtitle: 'Image preview',
        url: value,
        alt: getTitle(record) ?? 'Preview',
      })
      continue
    }
    if (record.thumbnail || record.thumbnails) continue
    collector.add({
      type: 'link',
      title: getTitle(record) ?? labelFromUrlKey(key),
      subtitle: value,
      url: value,
      actions: [{ label: labelFromUrlKey(key), url: value }],
    })
  }
}

function collectFieldPaths(
  record: Record<string, unknown>,
  collector: ArtifactCollector
): void {
  for (const [key, value] of Object.entries(record)) {
    if (!FILE_FIELD_NAMES.has(key) || typeof value !== 'string') continue
    if (!isAbsoluteLocalPath(value)) continue
    collector.add({
      type: 'file',
      title: getTitle(record) ?? filenameFromPath(value),
      subtitle: value,
      path: value,
      actions: [{ label: 'Open file', path: value }],
    })
  }
}

function collectFromText(text: string, collector: ArtifactCollector): void {
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0]
    if (isImageUrl(url)) {
      collector.add({
        type: 'image',
        title: filenameFromPath(url),
        subtitle: 'Image preview',
        url,
        alt: filenameFromPath(url),
      })
    } else {
      collector.add({
        type: 'link',
        title: 'Link',
        subtitle: url,
        url,
        actions: [{ label: 'Open', url }],
      })
    }
  }

  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const filePath = match[1]
    if (!filePath || !isAbsoluteLocalPath(filePath)) continue
    collector.add({
      type: 'file',
      title: filenameFromPath(filePath),
      subtitle: filePath,
      path: filePath,
      actions: [{ label: 'Open file', path: filePath }],
    })
  }
}

function parseJsonMaybe(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed.length > MAX_PARSED_TEXT_LENGTH) return undefined
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function isThumbnailContext(
  path: string[],
  record: Record<string, unknown>
): boolean {
  return (
    path.some(part => /thumbnail|preview|image/i.test(part)) ||
    typeof record.width === 'number' ||
    typeof record.height === 'number'
  )
}

function shouldSkipNestedLinkKey(
  record: Record<string, unknown>,
  key: string
): boolean {
  if ((key === 'urls' || key === 'links') && (record.thumbnail || record.thumbnails)) {
    return true
  }

  return (
    (key === 'edit_url' ||
      key === 'editUrl' ||
      key === 'view_url' ||
      key === 'viewUrl') &&
    Boolean(record.edit_url || record.editUrl || record.view_url || record.viewUrl)
  )
}

function compactActions(
  actions: (ToolArtifactAction | undefined)[]
): ToolArtifactAction[] {
  return actions.filter((action): action is ToolArtifactAction =>
    Boolean(action)
  )
}

function getTitle(record: Record<string, unknown>): string | undefined {
  for (const key of ['title', 'name', 'display_name', 'displayName', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function labelFromUrlKey(key: string): string {
  if (/edit/i.test(key)) return 'Edit'
  if (/view/i.test(key)) return 'View'
  if (/create/i.test(key)) return 'Create'
  return 'Open'
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isImageUrl(value: string): boolean {
  return IMAGE_URL_RE.test(value) || CANVA_THUMBNAIL_HOST_RE.test(value)
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^\/(?:home|tmp|var|mnt|workspace|Users)\//.test(value)
}

function filenameFromPath(value: string): string {
  try {
    const withoutQuery = value.split(/[?#]/, 1)[0] ?? value
    return withoutQuery.split('/').filter(Boolean).pop() ?? value
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hashIdentity(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
