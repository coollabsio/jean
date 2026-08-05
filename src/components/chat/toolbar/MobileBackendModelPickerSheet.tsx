import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { CliBackend, CustomCliProfile } from '@/types/preferences'
import { BackendModelPickerContent } from '@/components/chat/toolbar/BackendModelPickerContent'
import { useToolbarDropdownShortcuts } from '@/components/chat/toolbar/useToolbarDropdownShortcuts'
import { useIsMobile } from '@/hooks/use-mobile'

interface MobileBackendModelPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionHasMessages?: boolean
  providerLocked?: boolean
  selectedBackend: CliBackend
  selectedProvider: string | null
  selectedModel: string
  installedBackends: CliBackend[]
  customCliProfiles: CustomCliProfile[]
  onModelChange: (model: string) => void
  onBackendModelChange: (backend: CliBackend, model: string) => void
  /** Fired after a model is selected (picker already closed). */
  onAfterModelSelect?: (backend: CliBackend, model: string) => void
}

export function MobileBackendModelPickerSheet({
  open,
  onOpenChange,
  sessionHasMessages,
  providerLocked,
  selectedBackend,
  selectedProvider,
  selectedModel,
  installedBackends,
  customCliProfiles,
  onModelChange,
  onBackendModelChange,
  onAfterModelSelect,
}: MobileBackendModelPickerSheetProps) {
  const isMobile = useIsMobile()

  useToolbarDropdownShortcuts({
    setModelDropdownOpen: onOpenChange,
    enabled: isMobile,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[75svh] max-h-[75svh] min-h-0 overflow-hidden rounded-t-xl p-0"
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-base">
            Select Backend &amp; Model
          </SheetTitle>
          <SheetDescription className="sr-only">
            Search and select the backend and model for this chat session.
          </SheetDescription>
        </SheetHeader>
        <BackendModelPickerContent
          open={open}
          selectedBackend={selectedBackend}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          installedBackends={installedBackends}
          customCliProfiles={customCliProfiles}
          sessionHasMessages={sessionHasMessages}
          providerLocked={providerLocked}
          onModelChange={onModelChange}
          onBackendModelChange={onBackendModelChange}
          onRequestClose={() => onOpenChange(false)}
          onAfterSelect={onAfterModelSelect}
          className="min-h-0"
          commandListClassName="!max-h-none min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        />
      </SheetContent>
    </Sheet>
  )
}
