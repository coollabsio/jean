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
import { invoke, convertFileSrc } from '@/lib/transport'
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
import { usePreferences } from '@/services/preferences'
import type { SyntaxTheme } from '@/types/preferences'
import { toast } from 'sonner'

// Lazy load CodeEditor since it's heavy
const CodeEditor = lazy(() =>
  import('@/components/ui/code-editor').then(mod => ({
    default: mod.CodeEditor,
  }))
)

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
      <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md select-text cursor-text">
        {content}
      </pre>
    )
  }

  return (
    <div
      className="text-xs [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent p-3 bg-muted rounded-md overflow-x-auto select-text cursor-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/**
 * Modal dialog for viewing and editing file content
 * Supports syntax highlighting and inline editing based on preferences
 */
export function FileContentModal({ filePath, onClose }: FileContentModalProps) {
  const [content, setContent] = useState<string | null>(null)
  const [editedContent, setEditedContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

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

  // Get file edit mode from preferences
  const fileEditMode = preferences?.file_edit_mode ?? 'external'

  const loadFileContent = useCallback(async (path: string) => {
    setIsLoading(true)
    setError(null)
    setContent(null)
    setEditedContent(null)
    setIsEditing(false)

    try {
      const fileContent = await invoke<string>('read_file_content', { path })
      setContent(fileContent)
      setEditedContent(fileContent)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (filePath && !isImageFile(filePath)) {
      loadFileContent(filePath)
    } else {
      // Reset state when modal closes or for image files
      setContent(null)
      setEditedContent(null)
      setError(null)
      setIsLoading(false)
      setIsEditing(false)
    }
  }, [filePath, loadFileContent])

  const filename = filePath ? getFilename(filePath) : filePath

  const isImage = isImageFile(filename)
  const isMarkdown = isMarkdownFile(filename)
  const language = filePath ? getLanguageFromPath(filePath) : 'text'

  // Check if content has been modified
  const hasChanges = isEditing && editedContent !== content

  // Handle save
  const handleSave = useCallback(async () => {
    if (!filePath || !editedContent) return

    setIsSaving(true)
    try {
      await invoke('write_file_content', {
        path: filePath,
        content: editedContent,
      })
      setContent(editedContent)
      setIsEditing(false)
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
      // Discard changes
      setEditedContent(content)
    }
    setIsEditing(!isEditing)
  }, [isEditing, hasChanges, content])

  // Handle modal close - warn if unsaved changes
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
      <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm">
        <DialogTitle className="flex flex-col gap-1 pr-8">
          <div className="flex items-center gap-2">
            {isImage ? (
              <ImageIcon className="h-4 w-4 shrink-0" />
            ) : (
              <FileText className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{filename}</span>

            {/* Action buttons - only for non-image files */}
            {!isImage && content !== null && (
              <div className="ml-auto flex items-center gap-2">
                {fileEditMode === 'inline' ? (
                  <>
                    {isEditing ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleToggleEdit}
                          disabled={isSaving}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={handleSave}
                          disabled={!hasChanges || isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4 mr-1" />
                          )}
                          Save
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleToggleEdit}
                      >
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenExternal}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Open in Editor
                  </Button>
                )}
              </div>
            )}
          </div>
          {filePath && (
            <span className="text-muted-foreground font-normal text-xs truncate">
              {filePath}
            </span>
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          View or edit the contents of {filename ?? 'the selected file'}.
        </DialogDescription>

        {/* CodeEditor renders outside ScrollArea since it has its own scroll */}
        {isEditing && fileEditMode === 'inline' && content !== null ? (
          <div className="h-[calc(85vh-6rem)] mt-2">
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Loading editor...
                </div>
              }
            >
              <CodeEditor
                value={editedContent ?? content}
                language={language}
                onChange={setEditedContent}
                className="h-full"
              />
            </Suspense>
          </div>
        ) : (
          <ScrollArea className="h-[calc(85vh-6rem)] mt-2">
            {isLoading && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading file...
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            )}
            {isImage && filePath ? (
              <div className="flex justify-center p-4">
                <img
                  src={convertFileSrc(filePath)}
                  alt={filename ?? 'Image'}
                  className="max-w-full max-h-[calc(85vh-8rem)] object-contain rounded-md"
                />
              </div>
            ) : content !== null ? (
              isMarkdown ? (
                <div className="p-3 select-text cursor-text">
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
        )}
      </DialogContent>
    </Dialog>
  )
}
