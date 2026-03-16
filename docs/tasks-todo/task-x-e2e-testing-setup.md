# E2E Testing Setup for Local Tauri App

## Overview

Set up E2E testing to test real UI workflows with a running Tauri app locally.

## Platform Limitation

**WebDriver desktop testing**: Linux/Windows only - **macOS not supported** by Tauri's WebDriver approach.

---

## Option A: Playwright + Tauri Mocks (Recommended for macOS)

Tests frontend with mocked IPC - fast, works on all platforms.

### Install

```bash
bun add --dev @playwright/test
npx playwright install chromium
```

### Files to create

**`playwright.config.ts`:**

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    env: { VITE_PLAYWRIGHT: 'true' },
  },
})
```

**`src/main.tsx` addition:**

```typescript
if (import.meta.env.VITE_PLAYWRIGHT === 'true') {
  const { mockIPC } = await import('@tauri-apps/api/mocks')
  mockIPC((cmd) => {
    if (cmd === 'load_preferences') return { theme: 'system', ... }
    // Add more mocks as needed
  })
}
```

**`e2e/chat.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test'

test('chat interface loads', async ({ page }) => {
  await page.goto('http://localhost:1420')
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible()
})
```

### Run

```bash
npx playwright test
```

---

## Option B: WebdriverIO + tauri-driver (Full E2E - Linux/Windows only)

Tests actual Rust backend. Requires built app.

### Install

```bash
cargo install tauri-driver --locked
bun add --dev @wdio/cli @wdio/local-runner @wdio/mocha-framework
```

### Files to create

**`wdio.conf.js`:**

```javascript
import { spawn } from 'child_process'

let tauriDriver

export const config = {
  runner: 'local',
  port: 4444,
  specs: ['./e2e/**/*.wdio.ts'],

  beforeSession: () => {
    tauriDriver = spawn('tauri-driver', [], { stdio: 'inherit' })
  },

  afterSession: () => tauriDriver?.kill(),

  capabilities: [
    {
      'tauri:options': {
        application: './src-tauri/target/debug/jean',
      },
    },
  ],
}
```

### Run

```bash
bun run tauri:build -- --debug  # Build first
npx wdio run wdio.conf.js
```

---

## Recommendation

For **macOS**, use **Option A (Playwright + mocks)**:

- Works on macOS
- Tests UI workflows with controlled backend responses
- Fast iteration (no full build needed)

For true E2E with real backend, test on Linux VM or CI pipeline.

---

## References

- [Tauri v2 Testing Overview](https://v2.tauri.app/develop/tests/)
- [Tauri WebDriver Setup](https://v2.tauri.app/develop/tests/webdriver/)
- [Tauri API Mocking](https://v2.tauri.app/develop/tests/mocking/)
- [WebdriverIO Example](https://v2.tauri.app/develop/tests/webdriver/example/webdriverio/)
