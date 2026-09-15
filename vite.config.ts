import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'

const host = process.env.TAURI_DEV_HOST

function gitSha(): string {
  try {
    return execSync('git rev-parse --short=12 HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const appVersion = packageVersion()
const buildGitSha = gitSha()
const builtAt = new Date().toISOString()
const webBuildInfo = {
  webBuildId:
    process.env.JEAN_WEB_BUILD_ID ?? `${appVersion}-${buildGitSha}-${builtAt}`,
  appVersion,
  gitSha: buildGitSha,
  builtAt,
}

function jeanWebBuildInfoPlugin(): Plugin {
  return {
    name: 'jean-web-build-info',
    writeBundle(options) {
      const outDir = path.resolve(String(options.dir ?? 'dist'))
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        path.join(outDir, 'jean-build.json'),
        `${JSON.stringify(webBuildInfo, null, 2)}\n`
      )
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), jeanWebBuildInfoPlugin()],
  define: {
    __JEAN_WEB_BUILD_INFO__: JSON.stringify(webBuildInfo),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 600, // Prevent warnings for template's bundled components
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          if (id.includes('@xterm') || id.includes('ghostty-web')) {
            return 'terminal'
          }
          if (
            id.includes('react-markdown') ||
            id.includes('rehype-raw') ||
            id.includes('remark-gfm') ||
            id.includes('remend')
          ) {
            return 'markdown'
          }
          // Pierre edit mode is only needed when a code editor / editable diff opens.
          if (
            id.includes('@pierre/diffs/edit') ||
            id.includes('@pierre/diffs/dist/edit') ||
            id.includes('@pierre/diffs/dist/editor')
          ) {
            return 'pierre-edit'
          }
          if (id.includes('@tauri-apps')) return 'tauri'

          return undefined
        },
      },
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}))
