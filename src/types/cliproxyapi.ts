import type { ClaudeUsageSnapshot } from './claude-cli'
import type { CodexUsageSnapshot } from './codex-cli'

/** Usage of one account connected to the Jean-managed CLIProxyAPI. */
export interface CliproxyAccountUsage {
  authIndex: string
  provider: string
  /** Email or account name. */
  label: string
  status: string | null
  disabled: boolean
  claude: ClaudeUsageSnapshot | null
  codex: CodexUsageSnapshot | null
  error: string | null
}
