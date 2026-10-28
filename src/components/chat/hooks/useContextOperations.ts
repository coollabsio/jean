import { useCallback } from 'react'
import { useUIStore } from '@/store/ui-store'

interface UseContextOperationsReturn {
  /** Opens modal to select saved context */
  handleLoadContext: () => void
  /** Whether the load context modal is open */
  loadContextModalOpen: boolean
  /** Setter for load context modal open state */
  setLoadContextModalOpen: (open: boolean) => void
}

/** Hook for loading saved contexts as attachments. */
export function useContextOperations(): UseContextOperationsReturn {
  const loadContextModalOpen = useUIStore(state => state.loadContextModalOpen)
  const setLoadContextModalOpen = useUIStore(
    state => state.setLoadContextModalOpen
  )

  const handleLoadContext = useCallback(() => {
    setLoadContextModalOpen(true)
  }, [setLoadContextModalOpen])

  return {
    handleLoadContext,
    loadContextModalOpen,
    setLoadContextModalOpen,
  }
}
