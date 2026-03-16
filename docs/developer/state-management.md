# State Management

## Overview

### Local Component State -> `useState`

State that is only relevant to a single component (e.g., the value of an input field, whether a dropdown is open) uses the standard React `useState` and `useReducer` hooks.

### Global UI State -> Zustand

Transient global state related to the UI (e.g., `isSidebarVisible`, `isCommandPaletteOpen`) uses Zustand stores.

**Current implementation:** The `useChatStore` is a monolithic ~1600 line store handling sessions, streaming, execution modes, and more. While decomposition is recommended for new features, the existing store works and shouldn't be refactored without good reason.

### All Persisted State -> Tanstack Query

Data that originates from outside of the react app, either from the Rust backend (eg read from disk) or from external services and APIs uses TanStack Query. All `invoke` calls should be wrapped in `useQuery` or `useMutation` hooks within the `src/services/` directory. This handles loading, error, and caching states automatically.

### Data on local disk

Certain settings data should be persisted to local storage (in addition to or instead of to any remote backend system). This should usually be written to the applications support directory (eg. ``~/Library/Application Support/com.myapp.app/recovery/` on macOS). This is handled by Tauri's [filesystem plugin](https://v2.tauri.app/plugin/file-system/) and should be accessed and written in the same way as any other state which is not "owned" by the React App... ie via Tanstack Query.

## The "Onion" Pattern: Three-Layer State Architecture

The most critical architectural decision is how to organize state management. We discovered a three-layer "onion" approach that provides optimal performance and maintainability:

#### Layer 1: Server State (TanStack Query)

Use TanStack Query for state that:

- Comes from the Tauri backend (file system, external APIs)
- Benefits from caching and automatic refetching
- Needs to be synchronized across components
- Has loading, error, and success states

Example:

```typescript
// Query for server data
const {
  data: userData,
  isLoading,
  error,
} = useQuery({
  queryKey: ['user', userId, 'profile'],
  queryFn: () => invokeCommand('get_user_profile', { userId }),
  enabled: !!userId,
})
```

#### Layer 2: Client State (Zustand Stores)

Zustand stores handle global UI state. Examples:

```typescript
// UIStore - UI layout state
interface UIState {
  sidebarVisible: boolean
  commandPaletteOpen: boolean
  toggleSidebar: () => void
  setCommandPaletteOpen: (open: boolean) => void
}
```

**Current store structure:**

- `useChatStore` - Sessions, streaming, execution modes, tool calls (~1600 lines)
- `useUIStore` - Sidebar visibility, modal state, layout
- `useProjectsStore` - Project selection, expansion state

#### Layer 3: Local State (React useState)

Keep state local when it:

- Only affects UI presentation
- Is derived from props or global state
- Doesn't need persistence
- Is tightly coupled to component lifecycle

```typescript
// UI presentation state
const [windowWidth, setWindowWidth] = useState(window.innerWidth)
const [isDropdownOpen, setIsDropdownOpen] = useState(false)
```

### Store Boundary Guidelines

**UIStore** - Use for:

- Panel visibility
- Layout state
- UI modes and navigation
- Command palette state
- Modal open states

**ChatStore** - Use for:

- Active worktree/session tracking
- Streaming content and tool calls
- Execution modes per session
- Input drafts
- AI review results

**ProjectsStore** - Use for:

- Selected project/worktree IDs
- Expanded project/folder state
- Worktree status tracking

## State Persistence Hooks

### useUIStatePersistence

Handles persistence of UI state across app restarts:

```typescript
// src/hooks/useUIStatePersistence.ts
export function useUIStatePersistence() {
  const { data: uiState, isSuccess: uiStateLoaded } = useUIState()
  const { mutate: saveUIState } = useSaveUIState()

  // Initialize stores from persisted state on app load
  useEffect(() => {
    if (!uiStateLoaded || !uiState) return
    // Restore sidebar size, visibility, active worktree, etc.
    // ...
  }, [uiStateLoaded, uiState])

  // Subscribe to store changes and debounce saves (500ms)
  useEffect(() => {
    const debouncedSave = debounce((state: UIState) => {
      saveUIState(state)
    }, 500)

    const unsub = useChatStore.subscribe(state => {
      // Detect changes and trigger save
      debouncedSave(getCurrentUIState())
    })

    return () => unsub()
  }, [])
}
```

**Key patterns:**

- Debounced saves (500ms) to avoid excessive writes
- Change detection to only save when needed
- Set → Array conversion for JSON serialization
- Validates worktrees still exist before restoring

### useSessionStatePersistence

Handles per-session state that's stored in session files (not ui-state.json):

- Answered questions
- Submitted answers
- Fixed findings
- Permission denials

## Implementation Examples

### Basic Zustand Store

```typescript
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface UIState {
  sidebarVisible: boolean
  toggleSidebar: () => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      sidebarVisible: true,
      toggleSidebar: () =>
        set(state => ({ sidebarVisible: !state.sidebarVisible })),
    }),
    { name: 'ui-store' }
  )
)
```

### TanStack Query with Tauri Commands

```typescript
import { useQuery, useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

// Query hook
export function useUserProfile(userId: string) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: () => invoke<User>('get_user', { userId }),
    enabled: !!userId,
    gcTime: 1000 * 60 * 10, // TanStack Query v5 uses gcTime (not cacheTime)
  })
}

// Mutation hook
export function useUpdateUserProfile() {
  return useMutation({
    mutationFn: (userData: Partial<User>) => invoke('update_user', userData),
    onSuccess: () => {
      // Invalidate and refetch user queries
      queryClient.invalidateQueries({ queryKey: ['user'] })
    },
  })
}
```

## Critical Anti-Patterns

### Zustand Getter Function Anti-Pattern

**CRITICAL:** Never subscribe to a getter function and call it directly in JSX. This creates NO subscription to the underlying data.

```typescript
// ❌ BAD: Subscribes to function reference (stable), NOT to viewingLogsTab data
const isViewingLogs = useChatStore(state => state.isViewingLogs)
return isViewingLogs(worktreeId) ? <LogsView /> : <ChatView />
// viewingLogsTab changes will NOT trigger re-render!

// ✅ GOOD: Subscribes to actual data - triggers re-render when data changes
const isViewingLogsTab = useChatStore(state =>
  state.activeWorktreeId ? state.viewingLogsTab[state.activeWorktreeId] ?? false : false
)
return isViewingLogsTab ? <LogsView /> : <ChatView />
```

**When getter functions ARE okay:**

- Passing to memoized children as props (children handle their own rendering)
- Using inside `useMemo` with proper data dependencies
- Using inside callbacks obtained via `getState()`

**The bug:** Zustand selectors subscribe to whatever the selector returns. If you return a function, you subscribe to that function reference (which never changes), not the data the function reads internally.

### Store Subscription in Callbacks Anti-Pattern

```typescript
// ❌ BAD: Re-creates on every state change
const { currentData, updateData } = useStore()
const handleAction = useCallback(() => {
  updateData(currentData.modified)
}, [currentData, updateData]) // Cascades on every change

// ✅ GOOD: Stable callback, no cascades
const handleAction = useCallback(() => {
  const { currentData, updateData } = useStore.getState()
  updateData(currentData.modified)
}, []) // Empty deps - stable reference
```

## Performance Patterns

### The `getState()` Pattern

Use `getState()` for callbacks that need current state to avoid render cascades:

```typescript
// ✅ Good: Stable callback, no cascades
const handleAction = useCallback(() => {
  const { data, setData } = useStore.getState()
  setData(newData)
}, []) // Empty deps = stable

// ❌ Bad: Store subscription causes re-renders
const { data, setData } = useStore()
const handleAction = useCallback(() => {
  setData(newData)
}, [data, setData]) // Re-creates on every change!
```

See [performance-patterns.md](./performance-patterns.md) for more.
