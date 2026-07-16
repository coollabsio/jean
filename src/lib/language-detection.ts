/**
 * Language detection utilities for syntax highlighting
 * Maps file extensions to shiki language IDs
 */

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',

  // Systems
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  zig: 'zig',

  // JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',

  // Scripting
  py: 'python',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  R: 'r',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'batch',
  cmd: 'batch',

  // Data/Config
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  csv: 'csv',
  ini: 'ini',
  env: 'dotenv',

  // Documentation
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  tex: 'latex',
  rst: 'rst',

  // Database
  sql: 'sql',
  prisma: 'prisma',
  graphql: 'graphql',
  gql: 'graphql',

  // DevOps
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  tf: 'terraform',
  hcl: 'hcl',
  nix: 'nix',

  // Other
  swift: 'swift',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  clj: 'clojure',
  cljs: 'clojure',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  fs: 'fsharp',
  fsx: 'fsharp',
  vim: 'viml',
  diff: 'diff',
  patch: 'diff',
  make: 'makefile',
  makefile: 'makefile',
  cmake: 'cmake',

  // Lock files / special
  lock: 'json', // package-lock, bun.lock are JSON
}

// Special filename mappings (case-insensitive)
const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmakelists: 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  podfile: 'ruby',
  fastfile: 'ruby',
  appfile: 'ruby',
  dangerfile: 'ruby',
  guardfile: 'ruby',
  'cargo.toml': 'toml',
  'cargo.lock': 'toml',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitattributes',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.development': 'dotenv',
  '.env.production': 'dotenv',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  '.babelrc': 'json',
}

/**
 * Get the shiki language ID from a file path
 * @param path - Full file path or filename
 * @returns shiki language ID, or 'text' if unknown
 */
export function getLanguageFromPath(path: string): string {
  const filename = path.split('/').pop()?.toLowerCase() ?? ''

  // Check filename mappings first (Dockerfile, Makefile, etc.)
  if (FILENAME_TO_LANGUAGE[filename]) {
    return FILENAME_TO_LANGUAGE[filename]
  }

  // Check for dotfile patterns
  const dotfileLang = FILENAME_TO_LANGUAGE[filename]
  if (dotfileLang) {
    return dotfileLang
  }

  // Get extension
  const ext = filename.includes('.')
    ? filename.split('.').pop()?.toLowerCase()
    : filename

  if (ext && EXTENSION_TO_LANGUAGE[ext]) {
    return EXTENSION_TO_LANGUAGE[ext]
  }

  return 'text'
}

/**
 * Check if a language is supported for syntax highlighting
 */
export function isLanguageSupported(language: string): boolean {
  return language !== 'text'
}
