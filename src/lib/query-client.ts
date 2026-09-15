import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't refetch on window focus in desktop app
      refetchOnWindowFocus: false,
      // Retry failed requests 1 time
      retry: 1,
      // Cache data for 5 minutes
      staleTime: 1000 * 60 * 5,
      // Keep data in cache for 10 minutes
      gcTime: 1000 * 60 * 10,
    },
    mutations: {
      // Retry failed mutations 1 time
      retry: 1,
    },
  },
})

// Git status is event-backed and can be emitted for worktrees that are no
// longer mounted. Use a shorter cache horizon so switching projects does not
// retain every historical status entry for the global query default lifetime.
queryClient.setQueryDefaults(['git-status'], {
  gcTime: 1000 * 60 * 2,
})
