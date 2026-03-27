# Contributing to Jean

## Prerequisites

- **Node.js** LTS (v20+)
- **bun** ([https://bun.sh](https://bun.sh))
- **Rust** stable toolchain ([rustup.rs](https://rustup.rs))

### Platform-specific dependencies

**macOS**: Xcode Command Line Tools

```bash
xcode-select --install
```

**Linux** (Debian/Ubuntu/Linux Mint):

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev patchelf

# Ubuntu/Linux Mint: prefer Ayatana AppIndicator (avoids conflicts between old libappindicator3 and Ayatana packages)
sudo apt install libayatana-appindicator3-dev

# Debian/older distros (if Ayatana packages are unavailable):
# sudo apt install libappindicator3-dev
```

**Linux** (Arch Linux/Manjaro):

```bash
sudo pacman -S webkit2gtk-4.1 librsvg patchelf libayatana-appindicator
```

**Linux Remote Desktop (RDP/xrdp)**: See [Linux Remote Development](#linux-remote-development-rdpxrdp) section below.

**Windows**: No additional dependencies

## Quick Start

```bash
# Clone the repository
git clone https://github.com/coollabsio/jean.git
cd jean

# Install dependencies
bun install

# Start development
bun run tauri:dev # Also keeps the web-access dist rebuilt in the background
```

## Project Structure

```
jean/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── hooks/              # Custom React hooks
│   ├── services/           # TanStack Query hooks
│   ├── store/              # Zustand stores
│   └── types/              # TypeScript interfaces
├── src-tauri/              # Rust backend
│   └── src/
│       ├── lib.rs          # Core logic
│       ├── chat/           # Chat operations
│       ├── projects/       # Worktree/git operations
│       └── terminal/       # PTY management
├── docs/developer/         # Architecture documentation
└── package.json
```

## Development Commands

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `bun run tauri:dev`     | Start app in development mode and rebuild web dist |
| `bun run tauri:dev:rdp` | Start in dev mode with RDP/remote desktop support  |
| `bun run check:all`     | **Run all quality checks (must pass before PR)**   |
| `bun run typecheck`     | TypeScript type checking                           |
| `bun run lint`          | ESLint (zero warnings enforced)                    |
| `bun run lint:fix`      | Auto-fix lint issues                               |
| `bun run format`        | Format code with Prettier                          |
| `bun run test`          | Run Vitest in watch mode                           |
| `bun run test:run`      | Run tests once                                     |
| `bun run rust:clippy`   | Rust linting (warnings = errors)                   |
| `bun run rust:fmt`      | Format Rust code                                   |

## Code Style

### TypeScript/React

- **Strict mode** enabled
- **ESLint** with zero warnings tolerance
- **Prettier** formatting:
  - No semicolons
  - Single quotes
  - 2-space indentation
  - Trailing commas (ES5)

### Rust

- **rustfmt** for formatting
- **clippy** with warnings as errors

## Key Patterns

Before contributing, familiarize yourself with these patterns (see `docs/developer/` for details):

### State Management

```
useState (component) → Zustand (global UI) → TanStack Query (persistent data)
```

### Callback Pattern (Important!)

Use `getState()` in callbacks to avoid render cascades:

```typescript
// Good - stable callback
const handleAction = useCallback(() => {
  const { data, setData } = useStore.getState()
  setData(newData)
}, [])

// Bad - re-creates on every state change
const { data, setData } = useStore()
const handleAction = useCallback(() => setData(newData), [data, setData])
```

### Backend Communication

All Tauri commands are wrapped in TanStack Query hooks in `src/services/`.

## Testing

- **Frontend**: Vitest + React Testing Library
- **Backend**: `cargo test`
- **Run before PR**: `bun run check:all`

## Linux Remote Development (RDP/xrdp)

When developing on Linux via remote desktop (RDP/xrdp), you may encounter noisy EGL/Mesa/ZINK warnings like:

- `libEGL warning: failed to create dri2 screen`
- `MESA: ZINK: failed to choose pdev`

This is common in VM/RDP environments where GPU acceleration is unavailable. Use the provided wrapper script:

```bash
# Auto-detects RDP session and enables software rendering
bun run tauri:dev:rdp

# Force software rendering (useful if auto-detection doesn't work)
bun run tauri:dev:rdp -- --force
```

Or manually set environment variables:

```bash
LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=x11 bun run tauri:dev
```

**Note**: Software rendering is slower than hardware acceleration, but in RDP setups hardware acceleration is typically unavailable anyway. This approach provides cleaner logs and more consistent startup.

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run `bun run check:all` - all checks must pass
5. Commit with clear messages
6. Push and open a Pull Request

## Documentation

- `docs/developer/architecture-guide.md` - High-level architecture
- `docs/developer/state-management.md` - State patterns
- `docs/developer/command-system.md` - Command architecture
- `docs/developer/testing.md` - Testing guidelines

## Questions?

Open an issue or reach out to [@heyandras](https://x.com/heyandras).
