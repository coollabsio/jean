import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@/lib/transport'
import {
  Check,
  Copy,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { openExternal } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useWorktrees } from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { resolveMagicPromptProvider } from '@/types/preferences'
import { useChatStore } from '@/store/chat-store'

interface UpdatePrResponse {
  title: string
  body: string
}

type Phase = 'generate' | 'result'

export function UpdatePrDialog() {
  const { updatePrModalOpen, setUpdatePrModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: preferences } = usePreferences()

  const { data: worktrees } = useWorktrees(selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const worktree = worktrees?.find(w => w.id === selectedWorktreeId) ?? null

  const prNumber = worktree?.pr_number
  const prUrl = worktree?.pr_url
  const worktreePath = worktree?.path

  // Local state
  const [phase, setPhase] = useState<Phase>('generate')
  const [generatedTitle, setGeneratedTitle] = useState('')
  const [generatedBody, setGeneratedBody] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [copied, setCopied] = useState(false)

  const generateContent = useCallback(async () => {
    if (!worktreePath) return

    setPhase('generate')
    setIsGenerating(true)

    const activeSessionId = selectedWorktreeId
      ? useChatStore.getState().activeSessionIds[selectedWorktreeId]
      : undefined

    try {
      const result = await invoke<UpdatePrResponse>(
        'generate_pr_update_content',
        {
          worktreePath,
          sessionId: activeSessionId ?? null,
          customPrompt: preferences?.magic_prompts?.pr_content,
          model: preferences?.magic_prompt_models?.pr_content_model,
          customProfileName: resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'pr_content_provider',
            preferences?.default_provider
          ),
        }
      )
      setGeneratedTitle(result.title)
      setGeneratedBody(result.body)
      setPhase('result')
    } catch (error) {
      toast.error(`Failed to generate PR content: ${error}`)
      setUpdatePrModalOpen(false)
    } finally {
      setIsGenerating(false)
    }
  }, [worktreePath, selectedWorktreeId, preferences, setUpdatePrModalOpen])

  // Start generating when modal opens
  useEffect(() => {
    if (updatePrModalOpen && worktreePath && prNumber) {
      generateContent()
    }
  }, [updatePrModalOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setPhase('generate')
        setGeneratedTitle('')
        setGeneratedBody('')
        setIsGenerating(false)
        setIsUpdating(false)
        setCopied(false)
      }
      setUpdatePrModalOpen(open)
    },
    [setUpdatePrModalOpen]
  )

  const handleCopy = useCallback(async () => {
    const text = `# ${generatedTitle}\n\n${generatedBody}`
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [generatedTitle, generatedBody])

  const handleUpdatePr = useCallback(async () => {
    if (!worktreePath || !prNumber) return

    setIsUpdating(true)
    try {
      await invoke('update_pr_description', {
        worktreePath,
        prNumber,
        title: generatedTitle,
        body: generatedBody,
      })

      toast.success(`PR #${prNumber} updated`, {
        action: prUrl
          ? {
              label: 'Open',
              onClick: () => openExternal(prUrl),
            }
          : undefined,
      })
      setUpdatePrModalOpen(false)
    } catch (error) {
      toast.error(`Failed to update PR: ${error}`)
    } finally {
      setIsUpdating(false)
    }
  }, [
    worktreePath,
    prNumber,
    prUrl,
    generatedTitle,
    generatedBody,
    setUpdatePrModalOpen,
  ])

  return (
    <Dialog open={updatePrModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="!max-w-lg h-[500px] p-0 flex flex-col">
        <DialogHeader className="px-4 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="h-4 w-4" />
            {phase === 'generate' ? 'Generating...' : `Update PR #${prNumber}`}
          </DialogTitle>
        </DialogHeader>

        {phase === 'generate' && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Generating PR description for{' '}
                <span className="font-medium text-foreground">#{prNumber}</span>
                ...
              </span>
            </div>
          </div>
        )}

        {phase === 'result' && (
          <div className="flex flex-col flex-1 min-h-0 px-4 pb-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Title
              </label>
              <Input
                value={generatedTitle}
                onChange={e => setGeneratedTitle(e.target.value)}
                className="text-sm"
              />
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Body
              </label>
              <Textarea
                value={generatedBody}
                onChange={e => setGeneratedBody(e.target.value)}
                className="flex-1 min-h-0 text-sm resize-none font-mono"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={generateContent}
                disabled={isGenerating}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1.5 ${isGenerating ? 'animate-spin' : ''}`}
                />
                Regenerate
              </Button>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={handleCopy}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                size="sm"
                onClick={handleUpdatePr}
                disabled={isUpdating || !generatedTitle.trim()}
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {isUpdating ? 'Updating...' : `Update PR #${prNumber}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
