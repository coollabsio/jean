import { Button } from '@/components/ui/button'
import { ApprovalCard } from './ApprovalCard'
import type { CodexDynamicToolCallRequest } from '@/types/chat'

interface CodexDynamicToolCallRequestProps {
  request: CodexDynamicToolCallRequest
  onRespondUnsupported: () => void
}

export function CodexDynamicToolCallRequest({
  request,
  onRespondUnsupported,
}: CodexDynamicToolCallRequestProps) {
  const toolName = request.namespace
    ? `${request.namespace}/${request.tool}`
    : request.tool

  return (
    <ApprovalCard
      title="Unsupported Codex dynamic tool call"
      actions={
        <>
          <Button size="sm" onClick={onRespondUnsupported}>
            Respond unsupported
          </Button>
        </>
      }
    >
      <div className="mb-2 text-xs text-muted-foreground">Tool: {toolName}</div>
      <pre className="overflow-x-auto rounded bg-background/60 p-2 text-[11px] whitespace-pre-wrap break-words">
        {JSON.stringify(request.arguments, null, 2)}
      </pre>
    </ApprovalCard>
  )
}
