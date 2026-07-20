import { useCallback } from 'react'
import { ChevronDown, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  getCodexUserInputRequestId,
  normalizeCodexQuestions,
  upsertCodexUserInputRequest,
} from '@/types/chat'
import { usePreferences } from '@/services/preferences'
import { chatQueryKeys, useSendMessage } from '@/services/chat'
import type { EffortLevel, ExecutionMode, Session } from '@/types/chat'
import {
  buildCodexDevUserInputRequest,
  CODEX_DEV_FLOWS,
  CODEX_DEV_PROMPTS,
  type CodexDevFlowDefinition,
} from './codex-dev-flows'

interface DevToolsDropdownProps {
  sessionId: string
  worktreeId: string
  worktreePath: string
  session?: Session | null
}

export function DevToolsDropdown({
  sessionId,
  worktreeId,
  worktreePath,
  session,
}: DevToolsDropdownProps) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const sendMessage = useSendMessage()

  const triggerFlow = useCallback(
    (flow: CodexDevFlowDefinition) => {
      const request = buildCodexDevUserInputRequest(flow)
      const store = useChatStore.getState()
      const pending = store.getPendingCodexUserInputRequests(sessionId)
      const next = upsertCodexUserInputRequest(pending, request)
      const toolCallId = getCodexUserInputRequestId(request)

      store.setPendingCodexUserInputRequests(sessionId, next)
      store.setWaitingForInput(sessionId, true)
      store.addToolCall(sessionId, {
        id: toolCallId,
        name: 'AskUserQuestion',
        input: { questions: normalizeCodexQuestions(request.questions) },
      })
      store.addToolBlock(sessionId, toolCallId)

      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: true,
        waitingForInputType: 'question',
        pendingCodexUserInputRequests: next,
      }).catch(() => undefined)

      toast.success(`Injected Codex dev flow: ${flow.label}`)
    },
    [sessionId, worktreeId, worktreePath]
  )

  const triggerPrompt = useCallback(
    async (prompt: string) => {
      const store = useChatStore.getState()
      store.setInputDraft(sessionId, prompt)

      const model =
        session?.selected_model ??
        preferences?.selected_codex_model ??
        'gpt-5.6-sol'
      const executionMode = (store.executionModes[sessionId] ??
        session?.selected_execution_mode ??
        'plan') as ExecutionMode
      const effortLevel = (store.effortLevels[sessionId] ??
        preferences?.default_codex_reasoning_effort ??
        'high') as EffortLevel

      store.setSelectedBackend(sessionId, 'codex')
      store.setSelectedModel(sessionId, model)
      store.setExecutionMode(sessionId, executionMode)
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old =>
          old
            ? {
                ...old,
                backend: 'codex',
                selected_model: model,
                selected_execution_mode: executionMode,
              }
            : old
      )

      await invoke('set_session_model', {
        worktreeId,
        worktreePath,
        sessionId,
        model,
      }).catch(err =>
        console.error('[Codex Dev Flow] Failed to persist model:', err)
      )

      await invoke('set_session_backend', {
        worktreeId,
        worktreePath,
        sessionId,
        backend: 'codex',
      }).catch(err =>
        console.error('[Codex Dev Flow] Failed to persist backend:', err)
      )

      sendMessage.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        message: prompt,
        model,
        executionMode,
        thinkingLevel: 'off',
        effortLevel,
        chromeEnabled: preferences?.chrome_enabled ?? false,
        aiLanguage: preferences?.ai_language,
        backend: 'codex',
      })
      store.clearInputDraft(sessionId)
      toast.success('Sent Codex dev prompt')
    },
    [
      preferences,
      queryClient,
      sendMessage,
      session,
      sessionId,
      worktreeId,
      worktreePath,
    ]
  )

  const defaultFlow = CODEX_DEV_FLOWS[0]
  if (!import.meta.env.DEV || !defaultFlow) return null

  return (
    <div className="hidden items-center rounded-md border border-border/50 bg-muted/50 sm:inline-flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className="h-7 rounded-r-none border-0 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => triggerFlow(defaultFlow)}
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            AI dev
          </Button>
        </TooltipTrigger>
        <TooltipContent>Inject provider dev test flows</TooltipContent>
      </Tooltip>
      <div className="h-4 w-px bg-border/50" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-6 rounded-l-none border-0 px-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Codex</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CODEX_DEV_FLOWS.map(flow => (
            <DropdownMenuItem key={flow.id} onSelect={() => triggerFlow(flow)}>
              <div className="flex flex-col">
                <span>{flow.label}</span>
                <span className="text-xs text-muted-foreground">
                  {flow.description}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Example prompts</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {CODEX_DEV_PROMPTS.map(prompt => (
                <DropdownMenuItem
                  key={prompt.id}
                  onSelect={() => triggerPrompt(prompt.prompt)}
                >
                  <div className="flex max-w-80 flex-col">
                    <span>{prompt.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {prompt.description}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Claude</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>Coming soon</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
