# Getting Started with Tauri React Template

Welcome! This guide will help you quickly set up and start customizing this Tauri React template for your desktop application.

## Quick Setup

### Prerequisites

Ensure you have the following installed:

- **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
- **Rust** (latest stable) - [Install with rustup](https://rustup.rs/)
- **Platform dependencies**:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft C++ Build Tools or Visual Studio
  - **Linux**: webkit2gtk, openssl, curl development packages

### Installation

1. **Clone or use this template**:

   ```bash
   git clone <your-repo-url>
   cd tauri-template
   ```

2. **Install dependencies**:

   ```bash
   bun install
   ```

3. **Start development**:

   ```bash
   bun run dev        # React dev server only
   bun run tauri:dev  # Full Tauri app + web-access dist watcher
   ```

4. **Verify everything works**:
   - The app should open in a desktop window
   - Try the command palette (⌘+K or Ctrl+K)
   - Test the preferences dialog (⌘+, or Ctrl+,)

### 🚀 Quick Template Setup (Claude Code Users)

If you're using **Claude Code**, you can use the `/init` command to automatically configure the template for your specific application:

```
/init
```

This will:

- Prompt you for your app name and description
- Update all configuration files with your app details
- Set up proper identifiers and metadata
- Configure GitHub workflows and release settings
- Run quality checks to ensure everything works

**This saves significant setup time and ensures consistency across all files!**

## Key Features Overview

### 🎯 Command System

- **Command Palette**: Press ⌘+K (Ctrl+K) to access all commands
- **Keyboard Shortcuts**: Native shortcuts for common actions
- **Menu Integration**: Commands work from both palette and menus

### 🎨 Modern UI

- **shadcn/ui components**: Beautiful, accessible components
- **Tailwind CSS**: Utility-first styling
- **Dark/Light themes**: Automatic system theme detection
- **Native feel**: Platform-specific styling and behaviors

### 💾 State Management

- **Zustand**: Global UI state (sidebar visibility, themes)
- **TanStack Query**: Server state and data caching
- **Persistent preferences**: Automatically saved to disk

### 🔧 Development Tools

- **Hot reload**: Instant feedback during development
- **TypeScript**: Full type safety
- **Testing**: Vitest + Testing Library setup
- **Quality gates**: ESLint, Prettier, Rust checks

## Customization Guide

### 1. Update App Identity

**File**: `src-tauri/tauri.conf.json`

```json
{
  "productName": "Your App Name",
  "version": "1.0.0",
  "identifier": "com.yourcompany.yourapp",
  "bundle": {
    "publisher": "Your Company Name"
  }
}
```

### 2. Add Your First Feature

**Create a new command**:

1. Add to `src/lib/commands/` (follow existing patterns)
2. Register in `src/lib/commands/registry.ts`
3. Add Rust backend function in `src-tauri/src/lib.rs`

**Example - Add a "New Project" command**:

```typescript
// src/lib/commands/project-commands.ts
export const projectCommands = [
  {
    id: 'new-project',
    label: 'New Project',
    description: 'Create a new project',
    group: 'project',
    shortcut: '⌘+N',
    execute: async context => {
      // Your logic here
      context.showToast('New project created!', 'success')
    },
  },
]
```

### 3. Customize the UI

**Add your own components**:

- Put reusable components in `src/components/`
- Use existing UI components from `src/components/ui/`
- Follow the established patterns in existing components

**Update the layout**:

- Modify `src/components/layout/MainWindowContent.tsx`
- Add sidebar content in `src/components/layout/LeftSideBar.tsx`

### 4. Add Persistent Data

**For simple preferences**:

- Add to `AppPreferences` in `src-tauri/src/lib.rs`
- Use the preferences service in React

**For complex data**:

- Use TanStack Query with the preferences service
- Follow patterns in `src/services/preferences.ts`

## Development Workflow

### Building and Testing

```bash
# Run all quality checks (recommended before commits)
bun run check:all

# Individual checks
bun run typecheck    # TypeScript checking
bun run lint         # ESLint
bun run test:run     # Run tests
bun run rust:clippy  # Rust linting
```

### Project Structure

```
src/                     # React frontend
├── components/          # Reusable UI components
│   ├── ui/             # shadcn/ui components
│   ├── layout/         # Layout components
│   └── ...             # Feature components
├── lib/                # Utilities and business logic
│   ├── commands/       # Command system
│   └── ...             # Other utilities
├── hooks/              # Custom React hooks
├── store/              # Zustand stores
├── services/           # API and external services
└── types/              # TypeScript type definitions

src-tauri/              # Rust backend
├── src/
│   ├── lib.rs         # Tauri commands and business logic
│   └── main.rs        # App entry point
├── capabilities/       # Security permissions
└── tauri.conf.json    # App configuration
```

## Next Steps

### Essential Reading

1. **[Architecture Guide](developer/architecture-guide.md)** - Understand the overall patterns
2. **[Command System](developer/command-system.md)** - Learn the command architecture
3. **[State Management](developer/state-management.md)** - Master the state management onion
4. **[Testing Guide](developer/testing.md)** - Write effective tests

### Recommended Customizations

1. **Replace placeholder content** with your app's functionality
2. **Add your own commands** following the established patterns
3. **Customize the theme** and branding
4. **Set up error tracking** for production
5. **Configure auto-updates** (see [SECURITY_PRODUCTION.md](SECURITY_PRODUCTION.md))

### Generating App Icons

You can create an app icon based on [this Figma Template](https://www.figma.com/design/1wLFubQxRb5mM0ZopsY14d/Tauri-Icon-Template?node-id=0-1&t=CclJKx6Z7vFqxA3z-1) and export it to `public/` as both SVG and a 512x512 PNG. You can then generate the required icons with `tauri icon ./public/icon.png`.

### Common Tasks

- **Add a new page**: Create component + route (if using routing)
- **Add persistent setting**: Update `AppPreferences` in Rust + React service
- **Add keyboard shortcut**: Register in command system
- **Add menu item**: Update menu system in `src-tauri/src/lib.rs`

## Getting Help

### Resources

- **[Tauri Documentation](https://tauri.app/)** - Official Tauri docs
- **[shadcn/ui Components](https://ui.shadcn.com/)** - UI component library
- **[Zustand Guide](https://zustand-demo.pmnd.rs/)** - State management
- **[TanStack Query](https://tanstack.com/query)** - Server state management

### Community

- **[Tauri Discord](https://discord.com/invite/tauri)** - Active community
- **[GitHub Issues](your-repo-issues)** - Report bugs or request features

### Debugging

- **React DevTools**: Install browser extension for React debugging
- **Tauri DevTools**: Built-in debugging tools (⌘+Shift+I)
- **Rust Logs**: Check console for Rust backend logs
- **Hot Reload Issues**: Restart `bun run tauri:dev`

---

**Next**: Once you're comfortable with the basics, dive into the [Architecture Guide](developer/architecture-guide.md) to understand the deeper patterns and design decisions.
