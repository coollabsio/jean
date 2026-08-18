import { Check, File, FileText, Loader2, Terminal, Wand2 } from 'lucide-react'
import type { QueuedMessage } from '@/types/chat'
import { getFilename } from '@/lib/path-utils'
import { ImageLightbox } from './ImageLightbox'

export function WorktreeSetupProgress({
  setupScript,
  queuedPrompt,
  queuedMessage,
}: {
  setupScript: string
  queuedPrompt?: string
  queuedMessage?: QueuedMessage
}) {
  const prompt = queuedMessage?.message ?? queuedPrompt
  const hasQueuedContent = Boolean(prompt || queuedMessage)

  return (
    <section
      aria-label="Worktree setup in progress"
      className="mx-auto my-6 w-full max-w-3xl space-y-5 font-sans"
    >
      {hasQueuedContent && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
            {prompt && (
              <p className="whitespace-pre-wrap break-words">{prompt}</p>
            )}
            {queuedMessage && (
              <div
                aria-label="Queued attachments"
                className={prompt ? 'mt-3 flex flex-wrap gap-2' : 'flex flex-wrap gap-2'}
              >
                {queuedMessage.pendingImages.map(image =>
                  image.loading ? (
                    <div
                      key={image.id}
                      aria-label="Attachment processing"
                      className="flex h-14 w-14 items-center justify-center rounded-md bg-primary-foreground/10"
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : (
                    <ImageLightbox
                      key={image.id}
                      src={image.path}
                      alt={image.filename}
                      thumbnailClassName="h-14 w-14 rounded-md object-cover ring-1 ring-primary-foreground/20"
                    />
                  )
                )}
                {queuedMessage.pendingTextFiles.map(file => (
                  <span
                    key={file.id}
                    className="inline-flex max-w-48 items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 text-xs"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{file.filename}</span>
                  </span>
                ))}
                {queuedMessage.pendingFiles.map(file => (
                  <span
                    key={file.id}
                    className="inline-flex max-w-48 items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 text-xs"
                  >
                    <File className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {getFilename(file.relativePath)}
                    </span>
                  </span>
                ))}
                {queuedMessage.pendingSkills.map(skill => (
                  <span
                    key={skill.id}
                    className="inline-flex max-w-48 items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 text-xs"
                  >
                    <Wand2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">/{skill.name}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-primary-foreground/70">
              Queued until setup finishes
            </p>
          </div>
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border bg-card px-4 py-3 shadow-sm">
          <h2 className="text-sm font-semibold">Preparing your workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasQueuedContent
              ? 'Your prompt will start automatically as soon as project setup is complete.'
              : 'Project setup is running in the background.'}
          </p>

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <div className="flex items-center gap-3 text-muted-foreground">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span>Worktree ready</span>
            </div>
            <div className="flex items-center gap-3 font-medium">
              <Loader2
                className="h-4 w-4 animate-spin text-primary"
                aria-hidden="true"
              />
              <span>Running project setup</span>
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            You can leave this view — setup will keep running.
          </p>

          <details className="group mt-3 text-xs text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:text-foreground">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              Show setup command
            </summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
              {setupScript}
            </pre>
          </details>
        </div>
      </div>
    </section>
  )
}
