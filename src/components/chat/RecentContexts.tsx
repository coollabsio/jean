import { useCallback, useMemo, useState } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { FileText, Loader2, Check, Link2, Eye, Ellipsis } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import {
  attachSavedContext,
  removeSavedContext,
  useAttachedSavedContexts,
} from '@/services/github'
import { useProjects } from '@/services/projects'
import type { SavedContextsResponse, SavedContext } from '@/types/chat'

/** Mirror Rust sanitize_for_filename: lowercase, keep alphanumeric/hyphen, collapse hyphens */
function sanitizeForFilename(s: string): string {
  return s
    .split('')
    .map(c => (/[a-zA-Z0-9-]/.test(c) ? c.toLowerCase() : '-'))
    .join('')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

interface RecentContextsProps {
  sessionId: string
  queryClient: QueryClient
  projectId?: string | null
}

export function RecentContexts({
  sessionId,
  queryClient,
  projectId,
}: RecentContextsProps) {
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{
    title: string
    content: string
  } | null>(null)

  const { data: contextsData } = useQuery({
    queryKey: ['session-context'],
    queryFn: () => invoke<SavedContextsResponse>('list_saved_contexts'),
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  const { data: attachedContexts } = useAttachedSavedContexts(sessionId)

  const { data: projects } = useProjects()

  // Collect display names of linked projects (e.g., "royal-camel", "other-repo")
  const linkedProjectNames = useMemo(() => {
    if (!projectId || !projects) return new Set<string>()
    const currentProject = projects.find(p => p.id === projectId)
    if (!currentProject?.linked_project_ids?.length) return new Set<string>()

    const names = new Set<string>()
    for (const linkedId of currentProject.linked_project_ids) {
      const linkedProject = projects.find(p => p.id === linkedId)
      if (linkedProject) {
        // Sanitize to match the filename format (e.g., "undead.coollabs.io" → "undead-coollabs-io")
        names.add(sanitizeForFilename(linkedProject.name))
      }
    }
    return names
  }, [projectId, projects])

  // Split into linked and other contexts, each sorted by recency, deduplicated by filename
  const { linkedContexts, otherContexts } = useMemo(() => {
    // Deduplicate by filename (unique per context file) — keep the most recent
    const sorted = (contextsData?.contexts ?? [])
      .slice()
      .sort((a, b) => b.created_at - a.created_at)
    const seenFilenames = new Set<string>()
    const deduped = sorted.filter(ctx => {
      if (seenFilenames.has(ctx.filename)) return false
      seenFilenames.add(ctx.filename)
      return true
    })

    if (linkedProjectNames.size === 0) {
      return {
        linkedContexts: [] as SavedContext[],
        otherContexts: deduped.slice(0, 5),
      }
    }

    const linked: SavedContext[] = []
    const other: SavedContext[] = []
    for (const ctx of deduped) {
      if (linkedProjectNames.has(ctx.project_name)) {
        if (linked.length < 5) linked.push(ctx)
      } else {
        if (other.length < 5) other.push(ctx)
      }
      if (linked.length >= 5 && other.length >= 5) break
    }
    return { linkedContexts: linked, otherContexts: other }
  }, [contextsData?.contexts, linkedProjectNames])

  // Build set of attached context keys (slug field contains filename-sans-ext as unique key)
  const attachedKeys = useMemo(
    () => new Set(attachedContexts?.map(c => c.slug) ?? []),
    [attachedContexts]
  )

  const handleToggle = useCallback(
    async (context: SavedContext) => {
      // Use filename sans .md as unique attachment key (slugs can collide across projects)
      const contextKey = context.filename.replace(/\.md$/, '')
      const isCurrentlyAttached = attachedKeys.has(contextKey)
      setLoadingIds(prev => new Set(prev).add(context.id))

      try {
        if (isCurrentlyAttached) {
          await removeSavedContext(sessionId, contextKey)
          toast.success(`Context "${context.name || context.slug}" removed`)
        } else {
          await attachSavedContext(sessionId, context.path, contextKey)
          toast.success(`Context "${context.name || context.slug}" attached`)
        }
        queryClient.invalidateQueries({
          queryKey: ['github', 'attached-contexts', sessionId],
        })
      } catch (error) {
        toast.error(`Failed: ${error}`)
      } finally {
        setLoadingIds(prev => {
          const next = new Set(prev)
          next.delete(context.id)
          return next
        })
      }
    },
    [sessionId, queryClient, attachedKeys]
  )

  const handlePreview = useCallback(async (ctx: SavedContext) => {
    try {
      const content = await invoke<string>('read_context_file', {
        path: ctx.path,
      })
      setPreview({ title: ctx.name || ctx.slug, content })
    } catch {
      toast.error('Failed to load context preview')
    }
  }, [])

  if (linkedContexts.length === 0 && otherContexts.length === 0) return null

  const renderButton = (ctx: SavedContext) => {
    const isLoading = loadingIds.has(ctx.id)
    const isAttached = attachedKeys.has(ctx.filename.replace(/\.md$/, ''))
    return (
      <div
        key={ctx.id}
        className="flex items-center w-[200px] rounded-md border border-border bg-muted/50 text-xs text-foreground transition-colors"
      >
        <button
          onClick={() => handleToggle(ctx)}
          disabled={isLoading}
          className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-3 py-1.5 hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 cursor-pointer rounded-l-md"
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : isAttached ? (
            <Check className="h-3 w-3 shrink-0 text-green-500" />
          ) : (
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{ctx.name || ctx.slug}</span>
        </button>
        <button
          onClick={e => {
            e.stopPropagation()
            handlePreview(ctx)
          }}
          className="px-1.5 py-1.5 border-l border-border hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer rounded-r-md text-muted-foreground"
        >
          <Eye className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 pb-4">
      {linkedContexts.length > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Link2 className="h-3 w-3 shrink-0" />
            Linked project contexts
          </span>
          <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
            {linkedContexts.map(renderButton)}
          </div>
        </div>
      )}
      {otherContexts.length > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-xs text-muted-foreground text-center items-center justify-center flex gap-2">
            Recent contexts{' '}
            <button
              onClick={() =>
                useUIStore.getState().setLoadContextModalOpen(true)
              }
              className="inline-flex items-center gap-0.5 text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
              title="Browse all contexts"
            >
              <Ellipsis className="inline h-3 w-3" />
            </button>
          </span>
          <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
            {otherContexts.map(renderButton)}
          </div>
        </div>
      )}
      {/* Preview dialog */}
      {preview && (
        <Dialog open={true} onOpenChange={() => setPreview(null)}>
          <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[calc(100vh-4rem)] sm:!rounded-xl font-sans flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                {preview.title}
              </DialogTitle>
            </DialogHeader>
            <ScrollArea className="flex-1 min-h-0">
              <Markdown className="p-4 text-sm">{preview.content}</Markdown>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
