import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Sparkles, X } from 'lucide-react'
import type { SessionDigest } from '@/types/chat'

interface RecapBannerProps {
  digest: SessionDigest | null
  isOpen: boolean
  onClose: () => void
  isGenerating?: boolean
}

export function RecapBanner({
  digest,
  isOpen,
  onClose,
  isGenerating,
}: RecapBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const prevDigestRef = useRef(digest)

  // Auto-expand when digest arrives (was null -> now has value)
  useEffect(() => {
    if (digest && !prevDigestRef.current) {
      setExpanded(true)
    }
    prevDigestRef.current = digest
  }, [digest])

  if (!isOpen) return null

  const showExpanded = digest && expanded

  return (
    <div className="relative z-20 border-b border-border bg-muted/60 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="flex items-start gap-2 py-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />

          <div className="min-w-0 flex-1">
            {isGenerating && !digest ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Generating recap...
              </div>
            ) : digest ? (
              <div className="space-y-1">
                <p
                  className={`text-xs text-foreground ${showExpanded ? '' : 'line-clamp-1'}`}
                >
                  {digest.chat_summary}
                </p>
                {showExpanded && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Last action:
                    </span>{' '}
                    {digest.last_action}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No recap available
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {digest && (
              <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {showExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
