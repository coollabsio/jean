# Command System

The command system provides a unified way to register and execute actions throughout the app, enabling consistent behavior across keyboard shortcuts, menus, and the command palette.

## Architecture Overview

The application has a **two-layer command architecture**:

1. **React Command System** - For UI-level actions (command palette, menus)
2. **Tauri Backend Commands** - For all data operations (`invoke()` calls)

```
┌────────────────────────────────────────────────────┐
│                   React Layer                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Command      │  │ Keyboard     │  │ Native   │ │
│  │ Palette      │  │ Shortcuts    │  │ Menus    │ │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘ │
│         │                 │               │        │
│         └────────────┬────┴───────────────┘        │
│                      ▼                             │
│              CommandContext                        │
│         (UI actions, event dispatch)               │
└────────────────────────────────────────────────────┘
                       │
                       ▼ invoke()
┌────────────────────────────────────────────────────┐
│              Tauri Backend Layer                    │
│                 (146+ commands)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ chat/        │  │ projects/    │  │ terminal/│ │
│  │ commands.rs  │  │ commands.rs  │  │ cmds.rs  │ │
│  │ (40 cmds)    │  │ (57 cmds)    │  │ (8 cmds) │ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ gh_cli/      │  │ claude_cli/  │  │ lib.rs   │ │
│  │ commands.rs  │  │ commands.rs  │  │ (9 cmds) │ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
└────────────────────────────────────────────────────┘
```

## React Command System

### Quick Start

#### Defining Commands

```typescript
// src/lib/commands/navigation-commands.ts
export const navigationCommands: AppCommand[] = [
  {
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the sidebar',
    icon: Sidebar,
    group: 'navigation',
    execute: (context: CommandContext) => {
      const { leftSidebarVisible, setLeftSidebarVisible } =
        useUIStore.getState()
      setLeftSidebarVisible(!leftSidebarVisible)
    },
    isAvailable: () => true,
  },
]
```

#### Registering Commands

```typescript
// src/lib/commands/index.ts
import { navigationCommands } from './navigation-commands'
import { settingsCommands } from './settings-commands'

export function getAllCommands(
  context: CommandContext,
  searchValue = ''
): AppCommand[] {
  const allCommands = [...navigationCommands, ...settingsCommands].filter(
    command => command.isAvailable(context)
  )

  // Filter by search
  if (searchValue) {
    const search = searchValue.toLowerCase()
    return allCommands.filter(
      cmd =>
        cmd.label.toLowerCase().includes(search) ||
        cmd.description?.toLowerCase().includes(search)
    )
  }

  return allCommands
}
```

### Command Structure

Each command follows this interface:

```typescript
interface AppCommand {
  id: string // Unique identifier
  label: string // Display name
  description?: string // Help text for command palette
  icon?: React.ComponentType // Icon for UI
  group: string // Grouping for organization
  execute: (context: CommandContext) => void | Promise<void>
  isAvailable: (context: CommandContext) => boolean
}
```

### Command Context

The context provides all state and actions commands need:

```typescript
export function useCommandContext(): CommandContext {
  const commandContext = useMemo(
    () => ({
      // Direct access to actions (stable references)
      openPreferences: () => {
        window.dispatchEvent(new CustomEvent('open-preferences'))
      },

      openCommitModal: () => {
        window.dispatchEvent(new CustomEvent('open-commit-modal'))
      },

      openPullRequest: () => {
        window.dispatchEvent(new CustomEvent('open-pull-request'))
      },

      showToast: (message: string, type: NotificationType = 'info') => {
        notifications[type]('Command Executed', message)
      },

      // ... other app-wide actions
    }),
    []
  )

  return commandContext
}
```

**Key Pattern**: Commands use `getState()` directly in their execute functions to avoid render cascades:

```typescript
// ✅ Good: Direct store access
execute: () => {
  const { leftSidebarVisible, setLeftSidebarVisible } = useUIStore.getState()
  setLeftSidebarVisible(!leftSidebarVisible)
}

// ❌ Bad: Would cause unnecessary re-renders
const { leftSidebarVisible, setLeftSidebarVisible } = useUIStore()
execute: () => {
  setLeftSidebarVisible(!leftSidebarVisible)
}
```

## Tauri Backend Commands

All data operations flow through Tauri commands. The app has **146+ backend commands** across multiple modules.

### Command Distribution by Module

| Module           | Location                                     | Commands | Purpose                           |
| ---------------- | -------------------------------------------- | -------- | --------------------------------- |
| Chat             | `src-tauri/src/chat/commands.rs`             | 40       | Sessions, messages, AI operations |
| Projects         | `src-tauri/src/projects/commands.rs`         | 57       | Worktrees, git, file operations   |
| GitHub Issues    | `src-tauri/src/projects/github_issues.rs`    | 12       | Issue/PR fetching                 |
| Saved Contexts   | `src-tauri/src/projects/saved_contexts.rs`   | 4        | Context persistence               |
| Terminal         | `src-tauri/src/terminal/commands.rs`         | 8        | PTY management                    |
| GH CLI           | `src-tauri/src/gh_cli/commands.rs`           | 4        | GitHub CLI wrapper                |
| Claude CLI       | `src-tauri/src/claude_cli/commands.rs`       | 4        | Claude CLI wrapper                |
| Background Tasks | `src-tauri/src/background_tasks/commands.rs` | 8        | Async job management              |
| Core             | `src-tauri/src/lib.rs`                       | 9        | Preferences, UI state             |

### Invoking Tauri Commands

All Tauri commands are called via `invoke()` and should be wrapped in TanStack Query hooks:

```typescript
// src/services/preferences.ts
import { useQuery, useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: () => invoke<AppPreferences>('load_preferences'),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (preferences: AppPreferences) =>
      invoke('save_preferences', { preferences }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
    },
  })
}
```

### Background Operations with Toast Pattern

For operations that run outside of chat (background operations), use toast notifications:

```typescript
const handleBackgroundOperation = useCallback(async () => {
  const toastId = toast.loading('Operation in progress...')

  try {
    const result = await invoke<ResultType>('backend_command', { args })

    // Invalidate relevant queries to refresh UI
    queryClient.invalidateQueries({ queryKey: ['relevant-query'] })

    toast.success(`Success: ${result.message}`, { id: toastId })
  } catch (error) {
    toast.error(`Failed: ${error}`, { id: toastId })
  }
}, [queryClient])
```

**Current background operations using this pattern:**

- `handleSaveContext` - saves context with AI summarization
- `handleOpenPr` - creates PR with AI-generated title/body
- `handleCommit` - creates commit with AI-generated message
- `handleReview` - runs AI code review

## Integration Points

### Command Palette

Commands automatically appear in the command palette (Cmd+K):

```typescript
// src/components/command-palette/CommandPalette.tsx
export function CommandPalette() {
  const [searchValue, setSearchValue] = useState('')
  const commandContext = useCommandContext()
  const commands = getAllCommands(commandContext, searchValue)

  return (
    <Command>
      <CommandInput value={searchValue} onValueChange={setSearchValue} />
      <CommandList>
        {commands.map(command => (
          <CommandItem
            key={command.id}
            onSelect={() => command.execute(commandContext)}
          >
            {command.icon && <command.icon />}
            <span>{command.label}</span>
            {command.description && <span>{command.description}</span>}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
```

### Keyboard Shortcuts

See [keyboard-shortcuts.md](./keyboard-shortcuts.md) for details on the keybinding system that triggers commands.

### Native Menus

Menu events trigger commands through the event system. See [menus.md](./menus.md) for details.

## Adding New Commands

### For UI Actions (Command Palette/Menu)

#### Step 1: Create Command

```typescript
// src/lib/commands/my-feature-commands.ts
export const myFeatureCommands: AppCommand[] = [
  {
    id: 'my-action',
    label: 'My Action',
    description: 'Does something useful',
    group: 'my-feature',
    execute: context => {
      // Your logic here
      context.showToast('Action executed!')
    },
    isAvailable: () => true,
  },
]
```

#### Step 2: Register Commands

```typescript
// src/lib/commands/index.ts
import { myFeatureCommands } from './my-feature-commands'

export function getAllCommands(context: CommandContext, searchValue = '') {
  const allCommands = [
    ...navigationCommands,
    ...myFeatureCommands, // Add here
    ...settingsCommands,
  ]
  // ... rest of function
}
```

### For Data Operations (Tauri Command)

#### Step 1: Define Rust Command

```rust
// src-tauri/src/my_module/commands.rs
#[tauri::command]
pub async fn my_command(app: AppHandle, arg: String) -> Result<MyResult, String> {
    // Implementation
    Ok(result)
}
```

#### Step 2: Register in lib.rs

```rust
// src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    my_module::commands::my_command,
])
```

#### Step 3: Create TanStack Query Hook

```typescript
// src/services/my-service.ts
export function useMyQuery() {
  return useQuery({
    queryKey: ['my-query'],
    queryFn: () => invoke<MyResult>('my_command', { arg: 'value' }),
  })
}
```

## Command Groups

Organize commands into logical groups:

- **navigation**: Sidebar toggles, navigation actions
- **settings**: Preferences, configuration
- **git**: Commit, PR, diff operations
- **chat**: Session management, message operations
- **file**: File operations (when implemented)

## Best Practices

1. **Keep commands pure**: Commands should only call actions, not contain complex logic
2. **Use descriptive labels**: Clear, action-oriented names for the command palette
3. **Group logically**: Related commands should share a group
4. **Check availability**: Use `isAvailable` to hide commands when they don't apply
5. **Provide feedback**: Use `context.showToast()` or toast notifications for confirmation
6. **Stay consistent**: Follow established patterns for similar commands
7. **Wrap invoke() in TanStack Query**: Never call `invoke()` directly in components
8. **Use background toast pattern**: For non-chat operations that take time

## Command Context Performance

The command context is designed to be performance-optimized:

- Uses `useMemo` to create stable object references
- Commands access store state via `getState()` to avoid subscriptions
- Event-driven patterns (like `dispatchEvent`) prevent tight coupling

This ensures the command system doesn't cause render cascades or performance issues.
