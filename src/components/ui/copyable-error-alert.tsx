import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

import { copyToClipboard } from '@/lib/clipboard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

interface CopyableErrorAlertProps {
  title: string
  error: string
  footer?: string
  copyLabel?: string
}

export function CopyableErrorAlert({
  title,
  error,
  footer,
  copyLabel = 'Copy error',
}: CopyableErrorAlertProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return

    const timeout = window.setTimeout(() => {
      setCopied(false)
    }, 2000)

    return () => window.clearTimeout(timeout)
  }, [copied])

  const handleCopy = useCallback(async () => {
    const text = [`${title}`, error, footer].filter(Boolean).join('\n\n')

    try {
      await copyToClipboard(text)
      setCopied(true)
      toast.success('Copied error details')
    } catch (err) {
      toast.error(`Failed to copy error details: ${err}`)
    }
  }, [error, footer, title])

  return (
    <Alert
      variant="destructive"
      className="border-destructive/50 bg-destructive/10"
    >
      <AlertCircle className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <AlertTitle>{title}</AlertTitle>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check />
                Copied
              </>
            ) : (
              <>
                <Copy />
                {copyLabel}
              </>
            )}
          </Button>
        </div>
        <AlertDescription className="w-full gap-3">
          <pre className="w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 text-xs text-destructive/90 select-text">
            {error}
          </pre>
          {footer ? <p>{footer}</p> : null}
        </AlertDescription>
      </div>
    </Alert>
  )
}
