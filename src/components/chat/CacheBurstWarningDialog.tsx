import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

/**
 * Shown before an effort-level change on a conversation that already has a
 * cache. Switching effort can purge that cache, so the next turn may cost
 * more (issue #687).
 */
export function CacheBurstWarningDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (dontShowAgain: boolean) => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  useEffect(() => {
    if (open) setDontShowAgain(false)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Changing effort may reset your prompt cache</DialogTitle>
          <DialogDescription>
            Switching reasoning effort can invalidate the cached context for
            this conversation. The next message may cost more and take longer
            while the full context is sent again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            id="cache-burst-dont-show-again"
            checked={dontShowAgain}
            onCheckedChange={checked => setDontShowAgain(checked === true)}
          />
          <Label
            htmlFor="cache-burst-dont-show-again"
            className="cursor-pointer text-sm text-muted-foreground"
          >
            Don&apos;t warn me again
          </Label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(dontShowAgain)}>
            Change effort
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
