import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { Textarea } from '@/components/ui/textarea'
import type { CodexMcpElicitationRequest } from '@/types/chat'

interface CodexMcpElicitationRequestProps {
  request: CodexMcpElicitationRequest
  onAccept: (content?: unknown, meta?: unknown) => void
  onDecline: () => void
  onCancel: () => void
}

function initialJsonValue(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '{}'
  const record = schema as Record<string, unknown>
  const properties =
    typeof record.properties === 'object' && record.properties !== null
      ? (record.properties as Record<string, unknown>)
      : null
  if (!properties) return '{}'

  const seed: Record<string, unknown> = {}
  for (const [key, rawProp] of Object.entries(properties)) {
    const prop =
      typeof rawProp === 'object' && rawProp !== null
        ? (rawProp as Record<string, unknown>)
        : {}
    if ('default' in prop) {
      seed[key] = prop.default
    } else {
      seed[key] = ''
    }
  }
  return JSON.stringify(seed, null, 2)
}

export function CodexMcpElicitationRequest({
  request,
  onAccept,
  onDecline,
  onCancel,
}: CodexMcpElicitationRequestProps) {
  const [rawContent, setRawContent] = useState(() =>
    initialJsonValue(request.requested_schema)
  )

  const parsedContent = useMemo(() => {
    if (request.mode !== 'form') return { value: undefined, error: null }
    try {
      return { value: JSON.parse(rawContent), error: null }
    } catch (error) {
      return { value: undefined, error: String(error) }
    }
  }, [rawContent, request.mode])

  return (
    <div className="my-3 rounded border border-muted bg-muted/30 p-4 font-mono text-sm">
      <div className="mb-2 font-semibold">
        MCP server “{request.server_name}” needs input
      </div>
      <div className="mb-3 text-muted-foreground">
        <Markdown>{request.message}</Markdown>
      </div>

      {request.mode === 'url' ? (
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
        >
          Open authorization URL
        </a>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Provide JSON content for the requested schema.
          </div>
          <Textarea
            value={rawContent}
            onChange={e => setRawContent(e.target.value)}
            className="min-h-32 font-mono text-xs"
          />
          {parsedContent.error && (
            <div className="text-xs text-destructive">
              {parsedContent.error}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            onAccept(request.mode === 'form' ? parsedContent.value : undefined)
          }
          disabled={request.mode === 'form' && !!parsedContent.error}
        >
          Accept
        </Button>
        <Button size="sm" variant="secondary" onClick={onDecline}>
          Decline
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
