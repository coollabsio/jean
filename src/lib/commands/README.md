# Simplified Command System

A lightweight, extensible command system that enables consistent behavior across keyboard shortcuts, menus, and command palette.

## Architecture

**80/20 Approach**: Maximum extensibility with minimal complexity

1. **Command Definition**: Pure objects with predictable structure
2. **Command Context**: Essential actions commands need
3. **Command Registry**: Simple Map-based storage and execution

## Usage

### Using Commands in Components

```typescript
import { executeCommand, useCommandContext } from '@/lib/commands'

function MyComponent() {
  const context = useCommandContext()

  const handleButtonClick = () => {
    executeCommand('toggle-sidebar', context)
  }

  return (
    <button onClick={handleButtonClick}>
      Toggle Sidebar
    </button>
  )
}
```

### Adding New Commands

1. **Create commands** (e.g., `my-feature-commands.ts`):

```typescript
import { useUIStore } from '@/store/ui-store'
import type { AppCommand } from '@/types/commands'

export const myFeatureCommands: AppCommand[] = [
  {
    id: 'my-action',
    label: 'My Action',
    description: 'Description of what this does',

    execute: context => {
      // Direct store access using getState() pattern
      const currentState = useUIStore.getState()

      // Call actions: context.toggleSidebar()
      // Show feedback: context.showToast('Done!', 'success')
    },

    isAvailable: () => {
      // Optional availability check
      return useUIStore.getState().someCondition
    },
  },
]
```

2. **Register commands in `index.ts`**:

```typescript
import { myFeatureCommands } from './my-feature-commands'

export function initializeCommandSystem(): void {
  registerCommands(projectCommands)
  registerCommands(myFeatureCommands) // Add here
}
```

3. **Update CommandContext if needed**:

If your commands need new actions, add them to:

- `CommandContext` interface in `types/commands.ts`
- `useCommandContext` hook in `hooks/use-command-context.ts`

## Performance Patterns

### getState() Pattern in Commands

Commands use direct store access for optimal performance:

```typescript
execute: context => {
  // ✅ Good: Direct store access in commands
  const { sidebarVisible, toggleSidebar } = useUIStore.getState()
  if (!sidebarVisible) {
    toggleSidebar()
  }
}
```

### Minimal Context

Context only provides essential actions, no state subscriptions:

```typescript
// Only essential actions - no state values
export function useCommandContext(): CommandContext {
  const { toggleSidebar } = useUIStore()
  return { toggleSidebar /* other actions */ }
}
```

## Available Commands

### Project Commands

- `add-project` - Add an existing git repository as a project
- `init-project` - Create a new project from scratch

### Debug Commands

- `notification.test-toast` - Show a test toast notification

## Command Structure (Simplified)

```typescript
interface AppCommand {
  id: string // Unique identifier
  label: string // Display name
  description?: string // Optional description
  execute: (context) => void // Execution function
  isAvailable?: (context) => boolean // Optional availability check
  shortcut?: string // Optional keyboard shortcut
}
```

## Key Simplifications

- ✅ **Registry**: Extensible Map-based storage
- ✅ **Performance**: Direct getState() access in commands
- ✅ **Essential Context**: Only actions, no state subscriptions
- ❌ **Removed**: Complex finding functions, hook wrappers, unused utilities
- ❌ **Removed**: Group-based organization (YAGNI)
- ❌ **Removed**: Over-abstracted availability patterns

This gives you **extensibility for teams** while keeping the **complexity minimal**.
