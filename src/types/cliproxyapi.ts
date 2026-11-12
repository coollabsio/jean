import type { ClaudeUsageSnapshot } from './claude-cli'
import type { CodexUsageSnapshot } from './codex-cli'

/** Usage of one account connected to the Jean-managed CLIProxyAPI. */
export interface CliproxyAccountUsage {
  authIndex: string
  provider: string
  /** Card title: the CLIProxyAPI auth file note, or "<Provider> account <n>". Never the email. */
  label: string
  /** Account email. Use only where the account must be named (Claude terms error). */
  email: string | null
  status: string | null
  disabled: boolean
  claude: ClaudeUsageSnapshot | null
  codex: CodexUsageSnapshot | null
  error: string | null
}
