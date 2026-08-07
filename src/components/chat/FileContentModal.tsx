import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  lazy,
  Suspense,
} from 'react'
import {
  FileText,
  ImageIcon,
  Loader2,
  AlertCircle,
  Pencil,
  Eye,
  Save,
  ExternalLink,
} from 'lucide-react'
import { invoke } from '@/lib/transport'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { useSyntaxHighlighting } from '@/hooks/useSyntaxHighlighting'
import { getLanguageFromPath } from '@/lib/language-detection'
import { getFilename } from '@/lib/path-utils'
import { useTheme } from '@/hooks/use-theme'
import { canOpenInEditor } from '@/lib/environment'
import { usePreferences } from '@/services/preferences'
import { cn } from '@/lib/utils'
import type { SyntaxTheme } from '@/types/preferences'
import { toast } from 'sonner'

// Lazy load CodeEditor (Pierre File + edit mode) so the main bundle stays lean
const CodeEditor = lazy(() => import('@/components/ui/code-editor'))

function isMarkdownFile(filename: string | null | undefined): boolean {
  if (!filename) return false
  return /\.(md|markdown)$/i.test(filename)
}

function isImageFile(filename: string | null | undefined): boolean {
  if (!filename) return false
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(filename)
}

interface FileContentModalProps {
  /** File path to display, or null to close the modal */
  filePath: string | null
  /** Callback when modal is closed */
  onClose: () => void
}

/**
 * Syntax-highlighted code viewer component
 */
function SyntaxHighlightedCode({
  content,
  language,
  theme,
}: {
  content: string
  language: string
  theme: SyntaxTheme
}) {
  const { html, isLoading, error } = useSyntaxHighlighting(
    content,
    language,
    theme
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Highlighting...
      </div>
    )
  }

  if (error || !html) {
    // Fallback to plain text
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-3 bg-muted rounded-md select-text cursor-text">
        {content}
      </pre>
    )
  }

  return (
    <div
      className="text-xs [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:[overflow-wrap:anywhere] [&_code]:!bg-transparent [&_code]:whitespace-pre-wrap [&_code]:break-words p-3 bg-muted rounded-md overflow-x-hidden select-text cursor-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/**
 * Modal dialog for viewing and editing file content
 * Supports syntax highlighting and inline editing based on preferences
 */
interface FileBase64Content {
  data: string
  mimeType: string
}

export function FileContentModal({ filePath, onClose }: FileContentModalProps) {
  const [content, setContent] = useState<string | null>(null)
  const [editedContent, setEditedContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  /** data: URL for images loaded via backend (works for /tmp and remote) */
  const [imageSrc, setImageSrc] = useState<string | null>(null)

  const { theme } = useTheme()
  const { data: preferences } = usePreferences()

  // Resolve 'system' theme to actual dark/light
  const resolvedTheme = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  // Get syntax theme based on current theme mode
  const syntaxTheme: SyntaxTheme =
    resolvedTheme === 'dark'
      ? (preferences?.syntax_theme_dark ?? 'vitesse-black')
      : (preferences?.syntax_theme_light ?? 'github-light')

  // Always use Jean's Pierre inline editor for in-app file viewing — same on
  // desktop and mobile. External editors stay available via "Open in Editor".
  /** Bumps when content should remount the Pierre edit session (load / discard). */
  const [editorEpoch, setEditorEpoch] = useState(0)

  const loadFileContent = useCallback(async (path: string, signal: { cancelled: boolean }) => {
    setIsLoading(true)
    setError(null)
    setContent(null)
    setEditedContent(null)
    setIsEditing(false)
    setEditorEpoch(e => e + 1)

    try {
      const fileContent = await invoke<string>('read_file_content', { path })
      if (signal.cancelled) return
      setContent(fileContent)
      setEditedContent(fileContent)
      // Open in edit mode by default (matches mobile file browser)
      setIsEditing(true)
    } catch (err) {
      if (signal.cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!signal.cancelled) setIsLoading(false)
    }
  }, [])

  // Load images through the backend so remote/web and paths outside project
  // roots (e.g. /tmp screenshots) work — convertProjectFileSrc only serves
  // known project/worktree directories.
  const loadImageContent = useCallback(async (path: string, signal: { cancelled: boolean }) => {
    setIsLoading(true)
    setError(null)
    setImageError(false)
    setImageLoaded(false)
    setImageSrc(null)

    try {
      const result = await invoke<FileBase64Content>('read_file_base64', {
        path,
      })
      if (signal.cancelled) return
      setImageSrc(`data:${result.mimeType};base64,${result.data}`)
    } catch (err) {
      if (signal.cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setImageError(true)
    } finally {
      if (!signal.cancelled) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const signal = { cancelled: false }
    setImageError(false)
    setImageLoaded(false)
    setImageSrc(null)
    if (!filePath) {
      setContent(null)
      setEditedContent(null)
      setError(null)
      setIsLoading(false)
      setIsEditing(false)
      return () => {
        signal.cancelled = true
      }
    }
    if (isImageFile(filePath)) {
      setContent(null)
      setEditedContent(null)
      setIsEditing(false)
      void loadImageContent(filePath, signal)
    } else {
      void loadFileContent(filePath, signal)
    }
    return () => {
      signal.cancelled = true
    }
  }, [filePath, loadFileContent, loadImageContent])

  const filename = filePath ? getFilename(filePath) : filePath

  const isImage = isImageFile(filename)
  const isMarkdown = isMarkdownFile(filename)
  const language = filePath ? getLanguageFromPath(filePath) : 'text'

  // Check if content has been modified
  const hasChanges = isEditing && editedContent !== content

  // Handle save — stay in edit mode so the user can keep working
  const handleSave = useCallback(async () => {
    if (!filePath || editedContent === null) return

    setIsSaving(true)
    try {
      await invoke('write_file_content', {
        path: filePath,
        content: editedContent,
      })
      setContent(editedContent)
      toast.success('File saved')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save: ${message}`)
    } finally {
      setIsSaving(false)
    }
  }, [filePath, editedContent])

  // Handle open in external editor
  const handleOpenExternal = useCallback(async () => {
    if (!filePath) return

    try {
      await invoke('open_file_in_default_app', {
        path: filePath,
        editor: preferences?.editor,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to open: ${message}`)
    }
  }, [filePath, preferences?.editor])

  // Toggle edit mode
  const handleToggleEdit = useCallback(() => {
    if (isEditing && hasChanges) {
      // Discard changes and remount Pierre editor with original content
      setEditedContent(content)
      setEditorEpoch(e => e + 1)
    }
    setIsEditing(!isEditing)
  }, [isEditing, hasChanges, content])

  // Only the explicit X / DialogClose should dismiss — not outside click,
  // ESC, or a parent sheet closing underneath on mobile.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (hasChanges) {
          // Could add confirmation dialog here
          // For now, just discard and close
        }
        onClose()
      }
    },
    [hasChanges, onClose]
  )

  return (
    <Dialog open={!!filePath} onOpenChange={handleOpenChange}>
      <DialogContent
        preventClose
        // Sit above mobile sheets (z-80) so the viewer is interactive
        overlayClassName="z-[90]"
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 z-[90]"
      >
        <DialogTitle className="flex flex-col gap-1 px-4 pt-4 pr-14 sm:px-0 sm:pt-0 sm:pr-8">
          <div className="flex items-center gap-2">
            {isImage ? (
              <ImageIcon className="h-4 w-4 shrink-0" />
            ) : (
              <FileText className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{filename}</span>

            {/* Action buttons - only for non-image files */}
            {!isImage && content !== null && (
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                {isEditing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleToggleEdit}
                      disabled={isSaving}
                    >
                      <Eye className="h-4 w-4 sm:mr-1" />
                      <span className="hidden sm:inline">View</span>
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleSave}
                      disabled={!hasChanges || isSaving}
                    >
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4 sm:mr-1" />
                      )}
                      <span className="hidden sm:inline">Save</span>
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={handleToggleEdit}>
                    <Pencil className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Edit</span>
                  </Button>
                )}
                {canOpenInEditor() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenExternal}
                  >
                    <ExternalLink className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Open in Editor</span>
                  </Button>
                )}
              </div>
            )}
          </div>
          {filePath && (
            <span className="text-muted-foreground font-normal text-xs break-all [overflow-wrap:anywhere]">
              {filePath}
            </span>
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          View or edit the contents of {filename ?? 'the selected file'}.
        </DialogDescription>

        {/* Loading / error while content is not ready yet */}
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading file...
          </div>
        )}
        {error && (
          <div className="mx-4 sm:mx-0 flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="text-sm break-words">{error}</span>
          </div>
        )}

        {/* Pierre File editor (default — same on desktop and mobile) */}
        {!isLoading && !error && isEditing && content !== null ? (
          <div className="h-[calc(100dvh-7rem)] sm:h-[calc(85vh-6rem)] mt-2 px-4 pb-4 sm:px-0 sm:pb-0 min-w-0">
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Loading editor...
                </div>
              }
            >
              <CodeEditor
                key={`${filePath}:${editorEpoch}`}
                value={editedContent ?? content}
                fileName={filename ?? undefined}
                language={language}
                onChange={setEditedContent}
                className="h-full min-w-0"
              />
            </Suspense>
          </div>
        ) : !isLoading && !error ? (
          <ScrollArea className="h-[calc(100dvh-7rem)] sm:h-[calc(85vh-6rem)] mt-2 px-4 pb-4 sm:px-0 sm:pb-0">
            {isImage ? (
              <div className="flex flex-col items-center justify-center gap-3 p-4 min-h-[12rem]">
                {!imageLoaded && !imageError && imageSrc && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Loading image…
                  </div>
                )}
                {imageError ? (
                  <div className="flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md max-w-full">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="text-sm break-words">
                      {error ?? 'Failed to load image'}
                    </span>
                  </div>
                ) : imageSrc ? (
                  <img
                    src={imageSrc}
                    alt={filename ?? 'Image'}
                    className={cn(
                      'max-w-full max-h-[calc(85vh-8rem)] object-contain rounded-md',
                      !imageLoaded && 'hidden'
                    )}
                    onLoad={() => setImageLoaded(true)}
                    onError={() => {
                      setImageError(true)
                      setImageLoaded(false)
                    }}
                  />
                ) : null}
              </div>
            ) : content !== null ? (
              isMarkdown ? (
                <div className="p-3 select-text cursor-text break-words [overflow-wrap:anywhere]">
                  <Markdown className="text-sm">{content}</Markdown>
                </div>
              ) : (
                <SyntaxHighlightedCode
                  content={content}
                  language={language}
                  theme={syntaxTheme}
                />
              )
            ) : null}
          </ScrollArea>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
