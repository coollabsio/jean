# Keyboard Shortcuts

User-configurable keyboard shortcut system using native DOM event listeners, integrated with the command system for consistent behavior across the app.

## Quick Start

### All Keybindings (19 Total)

Keybindings are user-configurable in Preferences. Below are the defaults:

| Action                      | Default Shortcut | Description                             |
| --------------------------- | ---------------- | --------------------------------------- |
| `focus_chat_input`          | `Cmd+L`          | Move focus to chat textarea             |
| `toggle_left_sidebar`       | `Cmd+B`          | Show/hide projects sidebar              |
| `open_preferences`          | `Cmd+,`          | Open preferences dialog                 |
| `open_commit_modal`         | `Cmd+Shift+C`    | Open git commit dialog                  |
| `open_pull_request`         | `Cmd+Shift+P`    | Open pull request dialog                |
| `open_git_diff`             | `Cmd+G`          | Open git diff view                      |
| `execute_run`               | `Cmd+R`          | Start/stop workspace run script         |
| `open_in_modal`             | `Cmd+O`          | Open worktree in editor/terminal/finder |
| `open_magic_modal`          | `Cmd+M`          | Open magic git commands menu            |
| `new_session`               | `Cmd+T`          | Create new chat session                 |
| `next_session`              | `Cmd+Alt+Right`  | Switch to next session tab              |
| `previous_session`          | `Cmd+Alt+Left`   | Switch to previous session tab          |
| `close_session_or_worktree` | `Cmd+W`          | Close session or remove worktree        |
| `new_worktree`              | `Cmd+N`          | Create new worktree                     |
| `next_worktree`             | `Cmd+Alt+Down`   | Switch to next worktree                 |
| `previous_worktree`         | `Cmd+Alt+Up`     | Switch to previous worktree             |
| `cycle_execution_mode`      | `Shift+Tab`      | Cycle through Plan/Build/Yolo modes     |
| `approve_plan`              | `Cmd+Enter`      | Approve plan or answer question         |
| `restore_last_archived`     | `Cmd+Shift+T`    | Restore most recently archived item     |

**Note:** `Cmd` on Mac, `Ctrl` on Windows/Linux.

## Architecture

### TypeScript Type Definitions

All keybindings are defined in `src/types/keybindings.ts`:

```typescript
// Available keybinding actions
export type KeybindingAction =
  | 'focus_chat_input'
  | 'toggle_left_sidebar'
  | 'open_preferences'
  | 'open_commit_modal'
  | 'open_pull_request'
  | 'open_git_diff'
  | 'execute_run'
  | 'open_in_modal'
  | 'open_magic_modal'
  | 'new_session'
  | 'next_session'
  | 'previous_session'
  | 'close_session_or_worktree'
  | 'new_worktree'
  | 'next_worktree'
  | 'previous_worktree'
  | 'cycle_execution_mode'
  | 'approve_plan'
  | 'restore_last_archived'

// Shortcut string format: "mod+key" or "mod+shift+key"
export type ShortcutString = string

// Stored in preferences
export type KeybindingsMap = Record<string, ShortcutString>
```

### Default Keybindings

```typescript
export const DEFAULT_KEYBINDINGS: KeybindingsMap = {
  focus_chat_input: 'mod+l',
  toggle_left_sidebar: 'mod+b',
  open_preferences: 'mod+comma',
  open_commit_modal: 'mod+shift+c',
  open_pull_request: 'mod+shift+p',
  open_git_diff: 'mod+g',
  execute_run: 'mod+r',
  open_in_modal: 'mod+o',
  open_magic_modal: 'mod+m',
  new_session: 'mod+t',
  next_session: 'mod+alt+arrowright',
  previous_session: 'mod+alt+arrowleft',
  close_session_or_worktree: 'mod+w',
  new_worktree: 'mod+n',
  next_worktree: 'mod+alt+arrowdown',
  previous_worktree: 'mod+alt+arrowup',
  cycle_execution_mode: 'shift+tab',
  approve_plan: 'mod+enter',
  restore_last_archived: 'mod+shift+t',
}
```

### Centralized Event Handler

All keyboard shortcuts are managed in `useMainWindowEventListeners.ts`:

```typescript
export function useMainWindowEventListeners() {
  const commandContext = useCommandContext()
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()

  // Keep keybindings in a ref so the event handler always has the latest
  const keybindingsRef = useRef<KeybindingsMap>(DEFAULT_KEYBINDINGS)

  // Update ref when preferences change
  useEffect(() => {
    keybindingsRef.current = preferences?.keybindings ?? DEFAULT_KEYBINDINGS
  }, [preferences?.keybindings])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Convert the keyboard event to our shortcut string format
      const shortcut = eventToShortcutString(e)
      if (!shortcut) return

      // Look up matching action in keybindings
      const keybindings = keybindingsRef.current
      for (const [action, binding] of Object.entries(keybindings)) {
        if (binding === shortcut) {
          e.preventDefault()
          executeKeybindingAction(
            action as KeybindingAction,
            commandContext,
            queryClient
          )
          return
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [commandContext, queryClient])
}
```

### Action Execution

Each action is handled in the `executeKeybindingAction` function:

```typescript
function executeKeybindingAction(
  action: KeybindingAction,
  commandContext: ReturnType<typeof useCommandContext>,
  queryClient: QueryClient
) {
  switch (action) {
    case 'focus_chat_input':
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
      break
    case 'toggle_left_sidebar': {
      const { leftSidebarVisible, setLeftSidebarVisible } =
        useUIStore.getState()
      setLeftSidebarVisible(!leftSidebarVisible)
      break
    }
    case 'open_preferences':
      commandContext.openPreferences()
      break
    // ... etc for all actions
  }
}
```

## Keybinding Migration

When default keybindings change, the `migrateKeybindings` function ensures users get the new defaults if they haven't customized them:

```typescript
// src/services/preferences.ts

// Old default keybindings that have been changed - used for migration
const MIGRATED_KEYBINDINGS: Partial<Record<keyof KeybindingsMap, string>> = {
  toggle_left_sidebar: 'mod+1', // Changed to 'mod+b'
}

// Migrate keybindings: if a stored value matches an old default, use the new default
function migrateKeybindings(
  stored: KeybindingsMap | undefined
): KeybindingsMap {
  if (!stored) return DEFAULT_KEYBINDINGS

  const migrated = { ...stored }
  for (const [action, oldDefault] of Object.entries(MIGRATED_KEYBINDINGS)) {
    if (stored[action] === oldDefault) {
      // User had the old default, update to new default
      const newDefault = DEFAULT_KEYBINDINGS[action]
      if (newDefault) {
        migrated[action] = newDefault
      }
    }
  }
  return migrated
}
```

**Key insight:** This pattern preserves user customizations while updating defaults. If a user explicitly chose `mod+1`, they keep it. If they were using the old default, they get the new one.

## Persistence

Keybindings are stored in `preferences.json` via the Rust backend:

```rust
// src-tauri/src/lib.rs
pub struct AppPreferences {
    // ... other fields
    #[serde(default = "default_keybindings")]
    pub keybindings: std::collections::HashMap<String, String>,
}

fn default_keybindings() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    map.insert("focus_chat_input".to_string(), "mod+l".to_string());
    map.insert("toggle_left_sidebar".to_string(), "mod+1".to_string());
    // ... etc
    map
}
```

## Shortcut String Format

The format uses `mod` as a platform-agnostic modifier:

- `mod+key` → `Cmd+key` on Mac, `Ctrl+key` on Windows/Linux
- `mod+shift+key` → `Cmd+Shift+key` on Mac, `Ctrl+Shift+key` on Windows/Linux
- `shift+tab` → No modifier, just Shift+Tab

### Helper Functions

```typescript
// Convert keyboard event to shortcut string
export function eventToShortcutString(e: KeyboardEvent): ShortcutString | null {
  // Ignore modifier-only presses
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    return null
  }

  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')

  // Normalize key names
  let key = e.key.toLowerCase()
  if (key === ',') key = 'comma'
  // ... other normalizations

  parts.push(key)
  return parts.join('+')
}

// Format shortcut for display in UI
export function formatShortcutDisplay(shortcut: ShortcutString): string {
  const isMac = navigator.platform.includes('Mac')

  return shortcut
    .split('+')
    .map(part => {
      switch (part) {
        case 'mod':
          return isMac ? '⌘' : 'Ctrl'
        case 'shift':
          return isMac ? '⇧' : 'Shift'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'comma':
          return ','
        default:
          return part.toUpperCase()
      }
    })
    .join(' + ')
}
```

## Why Native DOM Events Instead of react-hotkeys-hook

We initially tried `react-hotkeys-hook` but encountered issues in the Tauri environment where shortcuts wouldn't fire consistently. Native DOM event listeners provide:

- **Reliable execution** in Tauri environment
- **Full control** over event handling
- **Better performance** with direct DOM access
- **Consistent behavior** across platforms

## Adding New Keybindings

### Step 1: Add Action Type

```typescript
// src/types/keybindings.ts
export type KeybindingAction =
  | /* existing actions */
  | 'my_new_action'
```

### Step 2: Add Default Binding

```typescript
// src/types/keybindings.ts
export const DEFAULT_KEYBINDINGS: KeybindingsMap = {
  // ... existing bindings
  my_new_action: 'mod+shift+m',
}
```

### Step 3: Add UI Definition

```typescript
// src/types/keybindings.ts
export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  // ... existing definitions
  {
    action: 'my_new_action',
    label: 'My New Action',
    description: 'Does something new',
    default_shortcut: 'mod+shift+m',
    category: 'navigation',
  },
]
```

### Step 4: Handle Action

```typescript
// src/hooks/useMainWindowEventListeners.ts
function executeKeybindingAction(action: KeybindingAction, ...) {
  switch (action) {
    // ... existing cases
    case 'my_new_action':
      // Your implementation
      break
  }
}
```

### Step 5: Update Rust Defaults (optional)

```rust
// src-tauri/src/lib.rs
fn default_keybindings() -> std::collections::HashMap<String, String> {
    // ... existing bindings
    map.insert("my_new_action".to_string(), "mod+shift+m".to_string());
    map
}
```

## Best Practices

1. **Use standard conventions**: Follow platform conventions for common actions
2. **Document shortcuts**: Update this file and the settings UI
3. **Test across platforms**: Verify shortcuts work on macOS and Windows/Linux
4. **Avoid conflicts**: Check existing shortcuts before adding new ones
5. **Support migration**: Add to `MIGRATED_KEYBINDINGS` when changing defaults
6. **Use `mod` prefix**: Allows cross-platform compatibility
7. **Provide feedback**: Use notifications or UI changes to confirm execution
