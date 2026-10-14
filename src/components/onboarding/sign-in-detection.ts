/**
 * Pure helpers that pull a sign-in URL and device code out of CLI login
 * terminal output (gh, codex, claude, cursor, opencode, ...).
 */

export interface SignInDetection {
  url: string | null
  code: string | null
}

// OSC 8 hyperlink: ESC ] 8 ; params ; URL (BEL | ESC \)
// eslint-disable-next-line no-control-regex
const OSC8_LINK = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const ESC_SINGLE = /\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text
    .replace(OSC8_LINK, (_match, url: string) => (url ? ` ${url} ` : ''))
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC_SINGLE, '')
}

const URL_PATTERN = /https:\/\/[^\s"'<>`]+/g
const TRAILING_PUNCTUATION = /[).,'"`>\]};:!?]+$/
const AUTH_URL_HINTS = [
  'github.com/login/device',
  'login',
  'device',
  'oauth',
  'authorize',
  'auth',
  'activate',
  'signin',
  'sign-in',
]

// Keyword ("code") followed, within a short window, by a device code like
// ABCD-1234, 1A2B-3C4D, ABCD-EFGH or XXXX-XXXX-XX. Code is case-sensitive
// (uppercase/digits) so ordinary hyphenated words never match.
const CODE_PATTERN =
  /(?:[Cc]ode|CODE)\b[\s\S]{0,80}?(?<![A-Za-z0-9-])([A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){1,3})(?![A-Za-z0-9-])/g
const DATE_LIKE = /^\d{4}-\d{2}(?:-\d{2})?$/

function findUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_PATTERN), match =>
    match[0].replace(TRAILING_PUNCTUATION, '')
  ).filter(url => url.length > 'https://'.length)
}

function pickUrl(urls: string[]): string | null {
  for (let i = urls.length - 1; i >= 0; i--) {
    const url = urls[i] as string
    const lower = url.toLowerCase()
    if (AUTH_URL_HINTS.some(hint => lower.includes(hint))) return url
  }
  return urls.at(-1) ?? null
}

function pickCode(textWithoutUrls: string): string | null {
  let code: string | null = null
  for (const match of textWithoutUrls.matchAll(CODE_PATTERN)) {
    const candidate = match[1]
    if (!candidate || DATE_LIKE.test(candidate)) continue
    code = candidate
  }
  return code
}

/** Find the most recent sign-in URL and device code in raw terminal output. */
export function detectSignIn(output: string): SignInDetection {
  const text = stripAnsi(output).replace(/\r/g, '\n')
  const url = pickUrl(findUrls(text))
  const code = pickCode(text.replace(URL_PATTERN, ' '))
  return { url, code }
}
