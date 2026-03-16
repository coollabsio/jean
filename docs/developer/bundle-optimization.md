# Bundle Optimization Guide

This guide covers bundle size optimization for your Tauri React application, from the template's built-in optimizations to advanced techniques for production apps.

## Template's Current Optimizations

This template includes several bundle size optimizations out of the box:

### Rust Binary Optimizations (20-30% size reduction)

**File**: `src-tauri/Cargo.toml`

```toml
[profile.release]
codegen-units = 1        # Better LLVM optimization (slower build, smaller binary)
lto = true               # Link-time optimizations
opt-level = "s"          # Optimize for size over speed
panic = "abort"          # Don't include panic unwinding code
strip = true             # Remove debug symbols
```

### Tauri Build Optimizations

**File**: `src-tauri/tauri.conf.json`

```json
{
  "build": {
    "removeUnusedCommands": true
  }
}
```

This removes any Tauri commands that aren't actually called from your frontend.

### Vite Configuration

**File**: `vite.config.ts`

```typescript
{
  build: {
    chunkSizeWarningLimit: 600, // Prevents warnings for template's bundled components
  }
}
```

## Analyzing Bundle Size

### Built-in Analysis

Use the template's analysis script:

```bash
bun run build:analyze
```

This builds your app and provides guidance on analyzing the output.

### Manual Analysis

1. **Check output folder sizes**:

   ```bash
   bun run build
   du -sh dist/*
   ```

2. **Examine chunk details**:

   ```bash
   ls -lah dist/assets/
   ```

3. **Use browser dev tools**:
   - Open your built app in browser
   - Check Network tab for resource sizes
   - Use Coverage tab to find unused code

### Advanced Analysis Tools

For detailed analysis, consider these tools:

```bash
# Install bundle analyzer (optional)
bun add --dev vite-bundle-analyzer

# Or use webpack-bundle-analyzer on the dist folder
bunx webpack-bundle-analyzer dist/assets/index-*.js
```

## When You Need More Optimization

The template's optimizations are sufficient for most applications. Consider additional optimization when:

- Your built app is > 10MB
- Initial load time is > 3 seconds
- You have large dependencies you don't fully use
- You're building for bandwidth-constrained environments

## Manual Chunking Strategies

When your app grows large, you can implement manual chunking:

### Code Splitting by Route

```typescript
// src/components/routing/LazyRoutes.tsx
import { lazy } from 'react'

const Dashboard = lazy(() => import('../dashboard/Dashboard'))
const Settings = lazy(() => import('../settings/Settings'))
const Reports = lazy(() => import('../reports/Reports'))

export { Dashboard, Settings, Reports }
```

### Vendor Chunk Separation

**File**: `vite.config.ts`

```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu'],
          utils: ['date-fns', 'clsx', 'tailwind-merge'],
        },
      },
    },
  },
})
```

### Feature-based Chunking

```typescript
// For larger applications
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor'
          }
          if (id.includes('src/components/dashboard')) {
            return 'dashboard'
          }
          if (id.includes('src/components/settings')) {
            return 'settings'
          }
          if (id.includes('src/components/reports')) {
            return 'reports'
          }
        },
      },
    },
  },
})
```

## Dynamic Import Patterns

For heavy components that aren't always needed:

### Lazy Component Loading

```typescript
// src/components/heavy/LazyChart.tsx
import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui/button'

const Chart = lazy(() => import('./Chart'))

export function LazyChart() {
  const [showChart, setShowChart] = useState(false)

  return (
    <div>
      {!showChart ? (
        <Button onClick={() => setShowChart(true)}>
          Load Chart
        </Button>
      ) : (
        <Suspense fallback={<div>Loading chart...</div>}>
          <Chart />
        </Suspense>
      )}
    </div>
  )
}
```

### Dynamic Feature Loading

```typescript
// src/hooks/useDynamicFeature.ts
import { useState, useCallback } from 'react'

export function useDynamicFeature<T>() {
  const [feature, setFeature] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)

  const loadFeature = useCallback(
    async (importFn: () => Promise<{ default: T }>) => {
      setLoading(true)
      try {
        const module = await importFn()
        setFeature(module.default)
      } catch (error) {
        console.error('Failed to load feature:', error)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  return { feature, loading, loadFeature }
}
```

## Tree Shaking Optimization

### Import Optimization

```typescript
// ❌ Imports entire library
import * as icons from 'lucide-react'

// ✅ Import only what you need
import { Search, Settings, User } from 'lucide-react'

// ❌ Imports entire utility library
import _ from 'lodash'

// ✅ Import specific functions
import { debounce } from 'lodash-es'
```

### Library-specific Optimizations

```typescript
// For date-fns
import { format } from 'date-fns/format'
import { parseISO } from 'date-fns/parseISO'

// For Radix UI - already optimized in template
import { Dialog, DialogContent } from '@radix-ui/react-dialog'
```

## Advanced Techniques

### Preloading Critical Chunks

```typescript
// src/utils/preload.ts
export function preloadRoute(routeImport: () => Promise<any>) {
  // Preload when user hovers over navigation
  const link = document.createElement('link')
  link.rel = 'modulepreload'
  link.href = routeImport.toString()
  document.head.appendChild(link)
}
```

### Service Worker Caching

```typescript
// For Progressive Web App features
// Consider workbox for advanced caching strategies
```

### Asset Optimization

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    assetsInlineLimit: 4096, // Inline assets smaller than 4kb
    cssCodeSplit: true, // Split CSS by entry points
    minify: 'terser', // Use terser for better minification
    terserOptions: {
      compress: {
        drop_console: true, // Remove console.log in production
        drop_debugger: true,
      },
    },
  },
})
```

## Common Pitfalls and Solutions

### Issue: Large Initial Bundle

**Problem**: Everything loads at once

**Solution**: Implement route-based code splitting

```typescript
// Use React.lazy for route components
const Dashboard = lazy(() => import('./Dashboard'))
```

### Issue: Duplicate Dependencies

**Problem**: Same library bundled multiple times

**Solution**: Check for version conflicts

```bash
bun pm ls react
# Note: bun doesn't have a dedupe command, reinstall dependencies if needed
bun install
```

### Issue: Unused shadcn/ui Components

**Problem**: Template includes components you don't use

**Solution**: Remove unused components (but consider keeping for future use)

```bash
rm src/components/ui/unused-component.tsx
# Update index files accordingly
```

### Issue: Large Date/Time Libraries

**Problem**: date-fns or moment.js are too large

**Solution**: Use lighter alternatives or tree-shake

```typescript
// Instead of moment.js (heavy)
import { format } from 'date-fns/format'

// Or use native Intl API
new Intl.DateTimeFormat('en-US').format(date)
```

## Monitoring Bundle Size

### CI/CD Integration

Add bundle size monitoring to your GitHub Actions:

```yaml
# .github/workflows/bundle-size.yml
- name: Check bundle size
  run: |
    bun run build
    size=$(du -sb dist | cut -f1)
    echo "Bundle size: $size bytes"
    if [ $size -gt 5000000 ]; then
      echo "Bundle too large!"
      exit 1
    fi
```

### Development Monitoring

```bash
# Add to package.json scripts
"size-check": "bun run build && bundlesize"
```

## Performance Testing

### Measuring Impact

```bash
# Test build size
cd src-tauri
cargo build --release
ls -lah target/release/tauri-app

# Test bundle size
bun run build
du -sh dist/
```

### Load Time Testing

```typescript
// Add performance monitoring
performance.mark('app-start')
// ... your app loads
performance.mark('app-ready')
performance.measure('app-load-time', 'app-start', 'app-ready')
```

## Tauri-Specific Optimizations

### Plugin Optimization

Only include plugins you use:

```toml
# src-tauri/Cargo.toml - Remove unused plugins
[dependencies]
# tauri-plugin-fs = "2"        # Remove if not used
# tauri-plugin-dialog = "2"    # Remove if not used
```

### Capability Permissions

Minimize permissions in `src-tauri/capabilities/desktop.json`:

```json
{
  "permissions": [
    "core:default",
    // Only include what you actually use
    "fs:read-file"
  ]
}
```

## Conclusion

Start with the template's built-in optimizations. As your app grows, implement these techniques progressively:

1. **First**: Use route-based code splitting
2. **Then**: Optimize imports and remove unused dependencies
3. **Finally**: Implement advanced chunking strategies

Remember: **Measure before optimizing**. Use `bun run build:analyze` to understand your bundle before making changes.

The goal is a balance between bundle size and complexity. Don't over-optimize prematurely—focus on user experience first.
