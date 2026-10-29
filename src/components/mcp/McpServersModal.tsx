import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { McpServersPane } from '@/components/preferences/panes/McpServersPane'
import { useUIStore } from '@/store/ui-store'

export function McpServersModal() {
  const open = useUIStore(state => state.mcpServersModalOpen)
  const setOpen = useUIStore(state => state.setMcpServersModalOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>MCP Servers</DialogTitle>
          <DialogDescription>
            All MCP servers across your installed AI backends. Sign in to
            servers that need authentication.
          </DialogDescription>
        </DialogHeader>
        <McpServersPane />
      </DialogContent>
    </Dialog>
  )
}
