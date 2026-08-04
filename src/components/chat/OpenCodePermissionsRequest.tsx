import { Button } from '@/components/ui/button'
import type { OpenCodePermissionRequest } from '@/types/chat'

interface OpenCodePermissionsRequestProps {
  request: OpenCodePermissionRequest
  onOnce: () => void
  onAlways: () => void
  onReject: () => void
}

function formatPermissionLabel(permission: string): string {
  switch (permission) {
    case 'external_directory':
      return 'External directory access'
    case 'bash':
      return 'Shell command'
    case 'edit':
      return 'File edit'
    case 'read':
      return 'File read'
    case 'webfetch':
      return 'Web fetch'
    case 'websearch':
      return 'Web search'
    case 'doom_loop':
      return 'Repeated tool call'
    default:
      return permission.replace(/_/g, ' ')
  }
}

/**
 * Approval card for OpenCode permission.asked / permission.v2.asked prompts.
 * Outcomes match OpenCode's native UI: once / always / reject.
 */
export function OpenCodePermissionsRequest({
  request,
  onOnce,
  onAlways,
  onReject,
}: OpenCodePermissionsRequestProps) {
  const patterns = request.patterns?.length
    ? request.patterns
    : request.always?.length
      ? request.always
      : []
  const alwaysPatterns = request.always?.length ? request.always : patterns
  // Avoid a redundant "Always would approve" section when it matches patterns.
  const alwaysDiffers =
    alwaysPatterns.length > 0 &&
    (alwaysPatterns.length !== patterns.length ||
      alwaysPatterns.some((p, i) => p !== patterns[i]))

  return (
    <div className="my-3 rounded border border-muted bg-muted/30 p-4 font-mono text-sm">
      <div className="mb-2 font-semibold">
        OpenCode needs permission: {formatPermissionLabel(request.permission)}
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        {request.working_dir ? (
          <div>
            <div className="font-medium text-foreground">Working directory</div>
            <div className="break-all">{request.working_dir}</div>
          </div>
        ) : null}
        {patterns.length > 0 ? (
          <div>
            <div className="font-medium text-foreground">Requested paths</div>
            <ul className="list-disc space-y-1 pl-4">
              {patterns.map(pattern => (
                <li key={pattern} className="break-all">
                  {pattern}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {alwaysDiffers ? (
          <div>
            <div className="font-medium text-foreground">
              Always would approve
            </div>
            <ul className="list-disc space-y-1 pl-4">
              {alwaysPatterns.map(pattern => (
                <li key={`always-${pattern}`} className="break-all">
                  {pattern}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {request.tool_call_id ? (
          <div>
            <div className="font-medium text-foreground">Tool call</div>
            <div className="break-all">{request.tool_call_id}</div>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onOnce}>
          Allow once
        </Button>
        <Button size="sm" variant="secondary" onClick={onAlways}>
          Allow always
        </Button>
        <Button size="sm" variant="ghost" onClick={onReject}>
          Deny
        </Button>
      </div>
    </div>
  )
}
