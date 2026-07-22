import {
  createBundledHighlighter,
  createSingletonShorthands,
} from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'

const createHighlighter = createBundledHighlighter({
  langs: {
    bash: () => import('@shikijs/langs/bash'),
  },
  themes: {
    'vitesse-black': () => import('@shikijs/themes/vitesse-black'),
    'vitesse-light': () => import('@shikijs/themes/vitesse-light'),
  },
  engine: () => createJavaScriptRegexEngine(),
})

const { codeToTokens } = createSingletonShorthands(createHighlighter)

export async function highlightBash(command: string, isDark: boolean) {
  return codeToTokens(command, {
    lang: 'bash',
    theme: isDark ? 'vitesse-black' : 'vitesse-light',
  })
}
