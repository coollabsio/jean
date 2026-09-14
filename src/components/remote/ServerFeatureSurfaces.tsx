import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { copyToClipboard } from '@/lib/clipboard'
import { isNativeApp } from '@/lib/environment'
import {
  validateExternalFeatureUrl,
  validateFeatureBridgeRequest,
  validateFeatureManifest,
} from '@/lib/feature-surface-bridge'
import { getRemoteConnections } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import type { FeatureSurfaceManifestEntry } from '@/types/server-capabilities'
import { notify } from '@/lib/notifications'
import { generateId } from '@/lib/uuid'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface SelectedSurface {
  serverId: string
  serverName: string
  surface: FeatureSurfaceManifestEntry
}

async function fetchSurfaceDocument(
  selected: SelectedSurface
): Promise<string> {
  const connection = getRemoteConnections().find(
    item => item.id === selected.serverId
  )
  if (!connection) throw new Error('The Jean server connection was removed.')
  const url = validateFeatureManifest(selected.surface, connection.url)
  if (!url)
    throw new Error('This feature surface is not compatible or trusted.')
  const response = await fetch(url, {
    headers: connection.token
      ? { Authorization: `Bearer ${connection.token}` }
      : undefined,
  })
  if (!response.ok)
    throw new Error(`Feature request failed (${response.status}).`)
  return response.text()
}

export function ServerFeatureSurfaces() {
  const snapshots = useServerConnectionSnapshots()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<SelectedSurface | null>(null)
  const [documentHtml, setDocumentHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const channel = useMemo(() => generateId(), [selected])
  const handledRequests = useRef(new Set<string>())
  const surfaces = [...snapshots.values()].flatMap(snapshot =>
    snapshot.status === 'online'
      ? snapshot.featureSurfaces.map(surface => ({
          serverId: snapshot.serverId,
          serverName: snapshot.name,
          surface,
        }))
      : []
  )

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setDocumentHtml(null)
    setError(null)
    handledRequests.current.clear()
    void fetchSurfaceDocument(selected)
      .then(html => {
        if (!cancelled) setDocumentHtml(html)
      })
      .catch(reason => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (!selected || event.source !== iframeRef.current?.contentWindow) return
      const request = validateFeatureBridgeRequest(
        event.data,
        selected.surface,
        channel
      )
      if (!request || handledRequests.current.has(request.requestId)) return
      handledRequests.current.add(request.requestId)

      let result: unknown = null
      let requestError: string | null = null
      try {
        if (request.permission === 'clipboard.write') {
          const text = request.payload.text
          if (typeof text !== 'string' || text.length > 8192)
            throw new Error('Invalid clipboard text.')
          if (!window.confirm(`Allow ${selected.surface.label} to copy text?`))
            throw new Error('Permission denied.')
          await copyToClipboard(text)
        } else if (request.permission === 'notification.show') {
          const title = request.payload.title
          const body = request.payload.body
          if (typeof title !== 'string' || title.length > 120)
            throw new Error('Invalid notification.')
          if (
            !window.confirm(
              `Allow ${selected.surface.label} to show a notification?`
            )
          )
            throw new Error('Permission denied.')
          await notify(
            title,
            typeof body === 'string' ? body.slice(0, 500) : undefined,
            { native: true }
          )
        } else if (request.permission === 'external.open') {
          const url = validateExternalFeatureUrl(request.payload.url)
          if (!url) throw new Error('Only HTTPS URLs can be opened.')
          if (!window.confirm(`Open ${url}?`))
            throw new Error('Permission denied.')
          await openUrl(url)
        } else if (request.permission === 'navigation.open') {
          const resourceKey = request.payload.resourceKey
          if (
            typeof resourceKey !== 'string' ||
            !resourceKey.startsWith(`${selected.serverId}:`)
          )
            throw new Error('Invalid resource.')
          window.dispatchEvent(
            new CustomEvent('server-feature:navigate', {
              detail: { resourceKey },
            })
          )
        } else if (request.permission === 'context.read') {
          result = {
            theme: document.documentElement.classList.contains('dark')
              ? 'dark'
              : 'light',
            locale: navigator.language,
          }
        }
      } catch (reason) {
        requestError = reason instanceof Error ? reason.message : String(reason)
      }
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'jean:bridge-result',
          channel,
          requestId: request.requestId,
          result,
          error: requestError,
        },
        '*'
      )
    },
    [channel, selected]
  )

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  if (!isNativeApp() || surfaces.length === 0) return null

  return (
    <>
      <button
        type="button"
        className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm text-muted-foreground hover:bg-muted/80 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Puzzle className="size-3.5" /> Features
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Server features</DialogTitle>
            <DialogDescription>
              Restricted features published by compatible Jean servers.
            </DialogDescription>
          </DialogHeader>
          {!selected ? (
            <div className="space-y-2">
              {surfaces.map(item => (
                <Button
                  key={`${item.serverId}:${item.surface.id}`}
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => setSelected(item)}
                >
                  {item.surface.label}
                  <span className="text-xs text-muted-foreground">
                    {item.serverName}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
              >
                Back
              </Button>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {!error && !documentHtml && (
                <p className="text-sm text-muted-foreground">Loading...</p>
              )}
              {documentHtml && (
                <iframe
                  ref={iframeRef}
                  title={selected.surface.label}
                  sandbox="allow-scripts"
                  srcDoc={documentHtml}
                  className="h-72 w-full rounded-md border bg-white"
                  onLoad={() =>
                    iframeRef.current?.contentWindow?.postMessage(
                      { type: 'jean:init', channel },
                      '*'
                    )
                  }
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
