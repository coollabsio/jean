# Testing

Testing patterns and utilities for both Rust and TypeScript code, with comprehensive test coverage and quality gates.

## Quick Start

### Running Tests

```bash
# Run all tests and checks
bun run check:all

# Individual test commands
bun run test        # TypeScript tests (watch mode)
bun run test:run    # TypeScript tests (single run)
bun run test:e2e    # E2E browser tests (Playwright)
bun run rust:test   # Rust tests
```

### Writing a Simple Test

```typescript
// src/components/ui/Button.test.tsx
import { render, screen } from '@testing-library/react'
import { Button } from './Button'

test('renders button with text', () => {
  render(<Button>Click me</Button>)
  expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument()
})
```

## E2E Testing

### Architecture

E2E tests run **Playwright against a Vite dev server** (not the native Tauri app). Since macOS WKWebView doesn't expose WebDriver, we mock the Tauri transport layer in the browser:

1. Vite serves the React app on port **1421** using `e2e/vite.config.e2e.ts`
2. Tauri plugin imports (`@tauri-apps/plugin-*`) are aliased to stubs
3. `window.__JEAN_E2E_MOCK__` flag is set via `page.addInitScript()`
4. `src/lib/transport.ts` detects the flag and routes `invoke()` / `listen()` to mock handlers instead of real Tauri IPC

### File Structure

```
e2e/
├── fixtures/
│   ├── tauri-mock.ts        # Playwright fixtures: mockPage, emitEvent, responseOverrides
│   ├── invoke-handlers.ts   # Static command→response map (all Tauri commands)
│   └── mock-data.ts         # Mock preferences, worktrees, projects, models
├── tests/
│   ├── app-loads.spec.ts
│   ├── chat-messaging.spec.ts
│   ├── keyboard-shortcuts.spec.ts
│   ├── model-selection.spec.ts
│   ├── navigation.spec.ts
│   ├── preferences.spec.ts
│   ├── session-management.spec.ts
│   └── theme-switching.spec.ts
├── playwright.config.ts
└── vite.config.e2e.ts
```

### Running Tests

```bash
bun run test:e2e              # Run all E2E tests
bun run test:e2e -- --ui      # Open Playwright UI mode
bun run test:e2e -- tests/chat-messaging.spec.ts  # Run specific file
```

The dev server starts automatically on port 1421. If you already have it running (`bun run dev:e2e`), Playwright reuses it (`reuseExistingServer: true` when not in CI).

### Writing a New Test

```typescript
// e2e/tests/my-feature.spec.ts
import { test, activateWorktree } from '../fixtures/tauri-mock'
import { expect } from '@playwright/test'

test.describe('My Feature', () => {
  test('does something', async ({ mockPage }) => {
    // mockPage is a regular Playwright Page with mocks pre-injected
    await activateWorktree(mockPage, 'My Worktree')

    // Interact with the app
    await mockPage.getByRole('button', { name: 'Click me' }).click()
    await expect(mockPage.getByText('Result')).toBeVisible()
  })
})
```

### Mock Transport System

#### Static Handlers (`invoke-handlers.ts`)

Every Tauri command needs an entry here, even if the response is `null`. This is the default response map:

```typescript
// e2e/fixtures/invoke-handlers.ts
export const invokeHandlers: Record<string, unknown> = {
  load_preferences: null, // Overridden by mock-data.ts
  get_worktrees: [], // Overridden by mock-data.ts
  get_sessions: { sessions: [], active_session_id: null },
  rename_session: null,
  send_chat_message: null,
  // ... all other commands
}
```

When adding a new Tauri command to the app, add its default response here or tests will fail with an unhandled invoke error.

#### Dynamic Handlers (`tauri-mock.ts`)

Some commands need stateful behavior (e.g., creating sessions updates the session list). These are defined as dynamic handlers inside `tauri-mock.ts`'s `addInitScript`:

```typescript
// Inside addInitScript — runs in browser context
if (cmd === 'create_session') {
  const newSession = { id: `session-${Date.now()}`, name: 'New Session', ... }
  store.sessions.push(newSession)
  store.active_session_id = newSession.id
  return newSession
}
```

Current dynamic handlers: `get_sessions`, `create_session`, `rename_session`, `set_active_session`, `set_session_model`, `get_session`, `send_chat_message`.

#### Override Precedence

`responseOverrides` (per-test) > dynamic handlers > static handlers:

```typescript
test('with custom sessions', async ({ mockPage }) => {
  // This test's responseOverrides will be merged in the fixture
})

// Use the responseOverrides fixture to override specific commands:
test.use({
  responseOverrides: {
    get_sessions: { sessions: [customSession], active_session_id: 'custom-id' },
  },
})
```

### Event Simulation

Tauri events (like chat streaming) are simulated via the `emitEvent` fixture:

```typescript
test('streaming response', async ({ mockPage, emitEvent }) => {
  const sessionId = 'session-1'

  // Simulate chat streaming lifecycle
  await emitEvent('chat:sending', {
    session_id: sessionId,
    worktree_id: 'wt-1',
  })
  await emitEvent('chat:chunk', { session_id: sessionId, content: 'Hello ' })
  await emitEvent('chat:chunk', { session_id: sessionId, content: 'world!' })

  // Check streaming content BEFORE chat:done (content is in Zustand streaming state)
  await expect(mockPage.getByText('Hello world!')).toBeVisible()

  await emitEvent('chat:done', { session_id: sessionId, worktree_id: 'wt-1' })
})
```

**Important**: Verify streaming content _before_ `chat:done`. After `chat:done`, TanStack Query refetches `get_session` which may return empty messages (unless the dynamic handler has the messages stored).

### Common Patterns

#### Activating a Worktree

Most tests need an active worktree before interacting with sessions/chat:

```typescript
import { activateWorktree } from '../fixtures/tauri-mock'

await activateWorktree(mockPage, 'My Worktree')
// Now the chat view is visible with session tabs, toolbar, textarea
```

#### Shadcn Select/Combobox Selectors

Shadcn `<Select>` renders as `button[role="combobox"]`. Find by current value text:

```typescript
// Find the theme selector showing "System"
const themeSelect = mockPage.locator('button[role="combobox"]', {
  hasText: 'System',
})
await themeSelect.click()
await mockPage.getByRole('option', { name: 'Dark' }).click()
```

#### Force-clicking DnD Sortable Elements

Session tabs use DnD sortable which intercepts pointer events. Use `force: true`:

```typescript
await input.click({ force: true })
await mockPage.keyboard.type('New Name')
await mockPage.keyboard.press('Enter')
```

### Key Mock Data Settings

## TypeScript Testing

### Test Framework: Vitest + Testing Library

**Setup:**

- **Vitest**: Fast test runner with Jest-compatible API
- **@testing-library/react**: React component testing utilities
- **@testing-library/jest-dom**: Additional matchers

### Test Structure

```typescript
// src/lib/utils.test.ts
import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn utility', () => {
  it('combines classes correctly', () => {
    expect(cn('class1', 'class2')).toBe('class1 class2')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible')
  })
})
```

### Component Testing

```typescript
// src/components/layout/MainWindow.test.tsx
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MainWindow } from './MainWindow'

// Test wrapper with providers
function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

test('renders main layout components', () => {
  render(
    <TestWrapper>
      <MainWindow />
    </TestWrapper>
  )

  expect(screen.getByRole('banner')).toBeInTheDocument() // Title bar
  expect(screen.getByRole('complementary')).toBeInTheDocument() // Sidebar
})
```

### Hook Testing

```typescript
// src/hooks/useUIStore.test.ts
import { renderHook, act } from '@testing-library/react'
import { useUIStore } from './useUIStore'

test('toggles sidebar visibility', () => {
  const { result } = renderHook(() => useUIStore())

  expect(result.current.leftSidebarVisible).toBe(true)

  act(() => {
    result.current.setLeftSidebarVisible(false)
  })

  expect(result.current.leftSidebarVisible).toBe(false)
})
```

### Mocking Tauri APIs

```typescript
// src/test/setup.ts
import { vi } from 'vitest'

// Mock Tauri APIs for tests
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))
```

### Testing Async Operations

```typescript
// src/services/preferences.test.ts
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { usePreferences } from './preferences'

const mockInvoke = vi.mocked(invoke)

test('loads preferences successfully', async () => {
  const mockPreferences = { theme: 'dark' }
  mockInvoke.mockResolvedValue(mockPreferences)

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const { result } = renderHook(() => usePreferences(), { wrapper })

  await waitFor(() => {
    expect(result.current.isSuccess).toBe(true)
  })

  expect(result.current.data).toEqual(mockPreferences)
  expect(mockInvoke).toHaveBeenCalledWith('load_preferences')
})
```

### Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

## Rust Testing

### Test Structure

```rust
// src-tauri/src/lib.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preferences_default() {
        let prefs = AppPreferences::default();
        assert_eq!(prefs.theme, "system");
    }

    #[tokio::test]
    async fn test_save_emergency_data() {
        // Create a test app handle (requires more setup)
        // This is a simplified example
        let filename = "test-data".to_string();
        let data = serde_json::json!({"test": "value"});

        // Test the function logic
        assert!(filename.len() > 0);
        assert!(!filename.contains(".."));
    }
}
```

### Integration Tests

```rust
// src-tauri/tests/integration_test.rs
use tauri::test::{mock_app, mock_context};

#[tokio::test]
async fn test_app_commands() {
    let app = mock_app();
    let context = mock_context();

    // Test Tauri commands in isolation
    // This requires more setup depending on your commands
}
```

### Testing File Operations

```rust
#[cfg(test)]
mod file_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_filename_validation() {
        // Test valid filenames
        assert!(is_valid_filename("test-file"));
        assert!(is_valid_filename("data123"));

        // Test invalid filenames
        assert!(!is_valid_filename("../etc/passwd"));
        assert!(!is_valid_filename("test/file"));
        assert!(!is_valid_filename("test\\file"));
    }

    #[tokio::test]
    async fn test_file_operations() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.json");

        let test_data = serde_json::json!({"key": "value"});

        // Test write operation
        let content = serde_json::to_string_pretty(&test_data).unwrap();
        fs::write(&file_path, content).unwrap();

        // Test read operation
        let read_content = fs::read_to_string(&file_path).unwrap();
        let parsed_data: serde_json::Value = serde_json::from_str(&read_content).unwrap();

        assert_eq!(parsed_data, test_data);
    }
}

fn is_valid_filename(filename: &str) -> bool {
    !filename.contains("..") && !filename.contains("/") && !filename.contains("\\")
}
```

## Quality Gates

### The `check:all` Command

```json
// package.json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "format:check": "prettier --check \"src/**/*.{ts,tsx,js,jsx,css,md}\"",
    "rust:fmt:check": "cd src-tauri && cargo fmt --check",
    "rust:clippy": "cd src-tauri && cargo clippy -- -D warnings",
    "rust:test": "cd src-tauri && cargo test",
    "test:run": "vitest run",
    "check:all": "bun run typecheck && bun run lint && bun run format:check && bun run test:run && bun run rust:fmt:check && bun run rust:clippy && bun run rust:test"
  }
}
```

### CI Integration

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable

      - run: bun install --frozen-lockfile
      - run: bun run check:all
```

## Test Organization

### File Structure

```
src/
├── components/
│   ├── ui/
│   │   ├── Button.tsx
│   │   └── Button.test.tsx
│   └── layout/
│       ├── MainWindow.tsx
│       └── MainWindow.test.tsx
├── hooks/
│   ├── useUIStore.ts
│   └── useUIStore.test.ts
├── services/
│   ├── preferences.ts
│   └── preferences.test.ts
└── test/
    ├── setup.ts          # Global test setup
    ├── utils.ts          # Test utilities
    └── mocks/            # Mock data
        └── preferences.ts

src-tauri/
├── src/
│   └── lib.rs            # Includes #[cfg(test)] modules
└── tests/
    └── integration_test.rs
```

### Test Utilities

```typescript
// src/test/utils.ts
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactNode } from 'react'

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0, // TanStack Query v5 renamed cacheTime to gcTime
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient()

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}
```

### Mock Data

```typescript
// src/test/mocks/preferences.ts
export const mockPreferences = {
  theme: 'dark',
  // Add other mock preference fields
}

export const mockPreferencesDefault = {
  theme: 'system',
}
```

## Testing Patterns

### Testing State Management

```typescript
// Test Zustand store
test('store state updates correctly', () => {
  const { result } = renderHook(() => useUIStore())

  act(() => {
    result.current.setLeftSidebarVisible(false)
  })

  expect(result.current.leftSidebarVisible).toBe(false)
})
```

### Testing Commands

```typescript
// Test command execution
test('command executes correctly', () => {
  const mockContext = {
    showToast: vi.fn(),
    openPreferences: vi.fn(),
  }

  const command = navigationCommands.find(cmd => cmd.id === 'toggle-sidebar')
  command?.execute(mockContext)

  // Assert expected behavior
})
```

### Testing Error Handling

```typescript
test('handles API errors gracefully', async () => {
  mockInvoke.mockRejectedValue(new Error('Network error'))

  const { result } = renderHook(() => usePreferences(), {
    wrapper: TestProviders,
  })

  await waitFor(() => {
    expect(result.current.isError).toBe(true)
  })

  expect(result.current.error).toBeInstanceOf(Error)
})
```

## Best Practices

### TypeScript Testing

1. **Use Testing Library**: Prefer user-centric testing with @testing-library
2. **Mock external dependencies**: Mock Tauri APIs and external services
3. **Test user interactions**: Focus on how users interact with components
4. **Avoid implementation details**: Test behavior, not internal implementation
5. **Use proper cleanup**: Ensure tests don't affect each other

### Rust Testing

1. **Unit test pure functions**: Test business logic in isolation
2. **Use temporary directories**: For file system tests
3. **Test error conditions**: Ensure proper error handling
4. **Mock external dependencies**: Use dependency injection for testability
5. **Test async code properly**: Use `#[tokio::test]` for async tests

### General Testing

1. **Write tests first**: Consider TDD for complex features
2. **Keep tests simple**: One assertion per test when possible
3. **Use descriptive names**: Test names should explain the scenario
4. **Test edge cases**: Include boundary conditions and error cases
5. **Maintain test coverage**: Aim for high coverage of critical paths

The testing system ensures code quality and reliability while making it easy to add tests for new features as the application grows.
