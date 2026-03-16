# Architectural Patterns

Core architectural patterns and their implementation in this Tauri + React template. This document serves as a reference for the key patterns that make the system work together cohesively.

## State Management Patterns

### The "Onion" Pattern

Three-layer state hierarchy prevents chaos and ensures predictable data flow:

```
┌─────────────────────────────────────┐
│           useState                  │  ← Component UI State
│  ┌─────────────────────────────────┐│
│  │          Zustand                ││  ← Global UI State
│  │  ┌─────────────────────────────┐││
│  │  │      TanStack Query         │││  ← Persistent Data
│  │  └─────────────────────────────┘││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

**See:** [state-management.md](./state-management.md) for complete implementation details.

### Performance Pattern: `getState()`

Critical pattern to avoid render cascades:

```typescript
// ✅ Good: Direct access, stable callback
const handleAction = useCallback(() => {
  const { data, setData } = useStore.getState()
  setData(data.modified)
}, [])

// ❌ Bad: Subscription causes cascades
const { data, setData } = useStore()
const handleAction = useCallback(() => {
  setData(data.modified)
}, [data, setData]) // Re-creates constantly
```

**See:** [performance-patterns.md](./performance-patterns.md) for complete performance patterns.

## Command System Pattern

Unified action dispatch that decouples UI triggers from implementations:

```typescript
// Commands are pure objects
export const myCommands: AppCommand[] = [
  {
    id: 'my-action',
    label: 'My Action',
    execute: context => {
      context.performAction()
    },
    isAvailable: context => context.canPerformAction,
  },
]
```

**Integration Points:**

- Command Palette (Cmd+K)
- Keyboard Shortcuts
- Native Menus
- Context Menus (future)

**See:** [command-system.md](./command-system.md) for complete implementation.

## Event-Driven Bridge Pattern

Loose coupling between Rust and React through events:

### Rust → React

```rust
// Menu click emits event
app.on_menu_event(|app, event| {
    let _ = app.emit("menu-preferences", ());
});
```

### React → Rust

```typescript
// Command invocation with error handling
const result = await invoke<Result>('my_command', { args })
```

**See:** [menus.md](./menus.md) and [keyboard-shortcuts.md](./keyboard-shortcuts.md) for specific implementations.

## Security Patterns

### Path Validation

```rust
fn is_blocked_directory(path: &Path) -> bool {
    let blocked = ["/System/", "/usr/", "/etc/", "/.ssh/"];
    blocked.iter().any(|pattern| path.starts_with(pattern))
}
```

### Input Sanitization

```rust
pub fn sanitize_filename(filename: &str) -> String {
    filename.chars()
        .filter(|c| !['/', '\\', ':', '*', '?', '"', '<', '>', '|'].contains(c))
        .collect()
}
```

### Atomic File Operations

```rust
// Write to temp file, then rename (atomic)
std::fs::write(&temp_path, content)?;
std::fs::rename(&temp_path, &final_path)?;
```

**See:** [data-persistence.md](./data-persistence.md) for complete file operation patterns.

## Component Architecture Pattern

### Hierarchical Responsibility

```
MainWindow (Orchestration)
├── Layout Components (Structure)
├── Content Components (Data + Presentation)
└── UI Components (Pure Presentation)
```

### Hook Extraction Pattern

```typescript
// Extract complex logic into focused hooks
export function useFeatureLogic() {
  const [state, setState] = useState()

  useEffect(() => {
    // Complex side effects
  }, [])

  return { state, actions }
}
```

## Integration Patterns

### Multi-Source Event Coordination

Same action, multiple triggers:

```typescript
// Keyboard shortcut
case ',': commandContext.openPreferences()

// Menu event
listen('menu-preferences', () => commandContext.openPreferences())

// Command palette
{ id: 'preferences', execute: (ctx) => ctx.openPreferences() }
```

### Cross-System Communication

```typescript
// Event-driven communication between systems
window.dispatchEvent(new CustomEvent('action-completed'))
window.addEventListener('action-completed', handleAction)
```

## Testing Patterns

### Component Testing

```typescript
function TestWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={testQueryClient}>
      {children}
    </QueryClientProvider>
  )
}
```

### Hook Testing

```typescript
const { result } = renderHook(() => useMyHook(), {
  wrapper: TestWrapper,
})
```

**See:** [testing.md](./testing.md) for complete testing strategies.

## Development Patterns

### Quality Gates

```bash
bun run check:all  # All checks must pass
```

### Documentation-Driven Development

1. Read relevant docs first
2. Follow established patterns
3. Update docs for new patterns
4. Test comprehensively

## Pattern Dependencies

Understanding how patterns work together:

```
Command System
├── Depends on: State Management (context)
├── Integrates with: Keyboard Shortcuts, Menus
└── Enables: Consistent behavior across UI

State Management
├── Enables: Performance (getState pattern)
├── Supports: Data Persistence, UI State
└── Foundation for: All other systems

Event-Driven Bridge
├── Enables: Rust-React communication
├── Supports: Security (validation in Rust)
└── Foundation for: Menus, Updates, Notifications
```

## Adding New Patterns

When you discover a new pattern:

1. **Document it** - Add to appropriate focused doc file
2. **Reference it here** - Add summary and cross-reference
3. **Test it** - Ensure it works with existing patterns
4. **Teach it** - Make it discoverable for AI agents and developers

## Anti-Patterns to Avoid

1. **State in wrong layer** - Always follow the onion model
2. **Direct coupling** - Use command system and events
3. **Subscription in callbacks** - Use `getState()` pattern
4. **Skipping validation** - Always validate inputs in Rust
5. **Magic patterns** - Prefer explicit, clear code

These patterns work together to create a maintainable, performant, and secure foundation for desktop applications.
