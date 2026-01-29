import type { ThinkingLevel } from './chat'
import { DEFAULT_KEYBINDINGS, type KeybindingsMap } from './keybindings'

// =============================================================================
// Notification Sounds
// =============================================================================

export type NotificationSound = 'none' | 'ding' | 'chime' | 'pop' | 'choochoo'

export const notificationSoundOptions: {
  value: NotificationSound
  label: string
}[] = [
  { value: 'none', label: 'None' },
  // More sounds will be added later:
  // { value: 'ding', label: 'Ding' },
  // { value: 'chime', label: 'Chime' },
  // { value: 'pop', label: 'Pop' },
  // { value: 'choochoo', label: 'Choo-choo' },
]

// =============================================================================
// Magic Prompts - Customizable prompts for AI-powered features
// =============================================================================

/**
 * Default prompts for magic commands. These can be customized in Settings.
 * Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPrompts {
  /** Prompt for investigating GitHub issues */
  investigate_issue: string
  /** Prompt for investigating GitHub pull requests */
  investigate_pr: string
  /** Prompt for generating PR title/body */
  pr_content: string
  /** Prompt for generating commit messages */
  commit_message: string
  /** Prompt for AI code review */
  code_review: string
  /** Prompt for context summarization */
  context_summary: string
  /** Prompt for resolving git conflicts (appended to conflict resolution messages) */
  resolve_conflicts: string
}

/** Default prompt for investigating GitHub issues */
export const DEFAULT_INVESTIGATE_ISSUE_PROMPT = `<task>

Investigate the loaded GitHub {issueWord} ({issueRefs})

</task>


<instructions>

1. Read the issue context file(s) to understand the full problem description and comments
2. Analyze the problem: expected vs actual behavior, error messages, reproduction steps
3. Explore the codebase to find relevant code
4. Identify root cause and constraints
5. Check for regression if this is a bug fix
6. Propose solution with specific files, risks, and test cases

</instructions>


<guidelines>

- Be thorough but focused
- Ask clarifying questions if requirements are unclear
- If multiple solutions exist, explain trade-offs
- Reference specific file paths and line numbers

</guidelines>`

/** Default prompt for investigating GitHub pull requests */
export const DEFAULT_INVESTIGATE_PR_PROMPT = `<task>

Investigate the loaded GitHub {prWord} ({prRefs})

</task>


<instructions>

1. Read the PR context file(s) to understand the full description, reviews, and comments
2. Understand what the PR is trying to accomplish and branch info (head → base)
3. Explore the codebase to understand the context
4. Analyze if the implementation matches the PR description
5. Identify action items from reviewer feedback
6. Propose next steps to get the PR merged

</instructions>


<guidelines>

- Be thorough but focused
- Pay attention to reviewer feedback and requested changes
- If multiple approaches exist, explain trade-offs
- Reference specific file paths and line numbers

</guidelines>`

/** Default prompt for PR content generation */
export const DEFAULT_PR_CONTENT_PROMPT = `<task>Generate a pull request title and description</task>

<context>
<source_branch>{current_branch}</source_branch>
<target_branch>{target_branch}</target_branch>
<commit_count>{commit_count}</commit_count>
</context>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>`

/** Default prompt for commit message generation */
export const DEFAULT_COMMIT_MESSAGE_PROMPT = `<task>Generate a commit message for the following changes</task>

<git_status>
{status}
</git_status>

<staged_diff>
{diff}
</staged_diff>

<recent_commits>
{recent_commits}
</recent_commits>

<remote_info>
{remote_info}
</remote_info>`

/** Default prompt for code review */
export const DEFAULT_CODE_REVIEW_PROMPT = `<task>Review the following code changes and provide structured feedback</task>

<branch_info>{branch_info}</branch_info>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>

{uncommitted_section}

<instructions>
Focus on:
- Security vulnerabilities
- Performance issues
- Code quality and maintainability (use /check skill if available to run linters/tests)
- Potential bugs
- Best practices violations

If there are uncommitted changes, review those as well.

Be constructive and specific. Include praise for good patterns.
Provide actionable suggestions when possible.
</instructions>`

/** Default prompt for context summarization */
export const DEFAULT_CONTEXT_SUMMARY_PROMPT = `<task>Summarize the following conversation for future context loading</task>

<output_format>
Your summary should include:
1. Main Goal - What was the primary objective?
2. Key Decisions & Rationale - Important decisions and WHY they were chosen
3. Trade-offs Considered - What approaches were weighed and rejected?
4. Problems Solved - Errors, blockers, or gotchas and how resolved
5. Current State - What has been implemented so far?
6. Unresolved Questions - Open questions or blockers
7. Key Files & Patterns - Critical file paths and code patterns
8. Next Steps - What remains to be done?

Format as clean markdown. Be concise but capture reasoning.
</output_format>

<context>
<project>{project_name}</project>
<date>{date}</date>
</context>

<conversation>
{conversation}
</conversation>`

/** Default prompt for resolving git conflicts */
export const DEFAULT_RESOLVE_CONFLICTS_PROMPT = `Please help me resolve these conflicts. Analyze the diff above, explain what's conflicting in each file, and guide me through resolving each conflict.

After resolving each file's conflicts, stage it with \`git add\`. Then run the appropriate continue command (\`git rebase --continue\`, \`git merge --continue\`, or \`git cherry-pick --continue\`). If more conflicts appear, resolve those too. Keep going until the operation is fully complete and the branch is ready to push.`

/** Default values for all magic prompts */
export const DEFAULT_MAGIC_PROMPTS: MagicPrompts = {
  investigate_issue: DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  investigate_pr: DEFAULT_INVESTIGATE_PR_PROMPT,
  pr_content: DEFAULT_PR_CONTENT_PROMPT,
  commit_message: DEFAULT_COMMIT_MESSAGE_PROMPT,
  code_review: DEFAULT_CODE_REVIEW_PROMPT,
  context_summary: DEFAULT_CONTEXT_SUMMARY_PROMPT,
  resolve_conflicts: DEFAULT_RESOLVE_CONFLICTS_PROMPT,
}

/**
 * Per-prompt model overrides. Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPromptModels {
  investigate_model: ClaudeModel
  pr_content_model: ClaudeModel
  commit_message_model: ClaudeModel
  code_review_model: ClaudeModel
  context_summary_model: ClaudeModel
  resolve_conflicts_model: ClaudeModel
}

/** Default models for each magic prompt */
export const DEFAULT_MAGIC_PROMPT_MODELS: MagicPromptModels = {
  investigate_model: 'opus',
  pr_content_model: 'haiku',
  commit_message_model: 'haiku',
  code_review_model: 'haiku',
  context_summary_model: 'opus',
  resolve_conflicts_model: 'opus',
}

// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
// Note: Field names use snake_case to match Rust struct exactly
export interface AppPreferences {
  theme: string
  selected_model: ClaudeModel // Claude model: 'opus' | 'sonnet' | 'haiku'
  thinking_level: ThinkingLevel // Thinking level: 'off' | 'think' | 'megathink' | 'ultrathink'
  terminal: TerminalApp // Terminal app: 'terminal' | 'warp' | 'ghostty'
  editor: EditorApp // Editor app: 'vscode' | 'cursor' | 'xcode'
  auto_branch_naming: boolean // Automatically generate branch names from first message
  branch_naming_model: ClaudeModel // Model for generating branch names
  auto_session_naming: boolean // Automatically generate session names from first message
  session_naming_model: ClaudeModel // Model for generating session names
  ui_font_size: FontSize // Font size for UI text
  chat_font_size: FontSize // Font size for chat text
  ui_font: UIFont // Font family for UI text
  chat_font: ChatFont // Font family for chat text
  git_poll_interval: number // Git status polling interval in seconds (10-600)
  remote_poll_interval: number // Remote API polling interval in seconds (30-600)
  keybindings: KeybindingsMap // User-configurable keyboard shortcuts
  archive_retention_days: number // Days to keep archived items (0 = never delete)
  session_grouping_enabled: boolean // Group session tabs by status when >3 sessions
  syntax_theme_dark: SyntaxTheme // Syntax highlighting theme for dark mode
  syntax_theme_light: SyntaxTheme // Syntax highlighting theme for light mode
  disable_thinking_in_non_plan_modes: boolean // Disable thinking in build/yolo modes (only plan uses thinking)
  session_recap_enabled: boolean // Show session recap when returning to unfocused sessions
  session_recap_model: ClaudeModel // Model for generating session recaps
  parallel_execution_prompt_enabled: boolean // Add system prompt to encourage parallel sub-agent execution
  magic_prompts: MagicPrompts // Customizable prompts for AI-powered features
  magic_prompt_models: MagicPromptModels // Per-prompt model overrides
  file_edit_mode: FileEditMode // How to edit files: inline (CodeMirror) or external (VS Code, etc.)
  ai_language: string // Preferred language for AI responses (empty = default)
  allow_web_tools_in_plan_mode: boolean // Allow WebFetch/WebSearch in plan mode without prompts
  waiting_sound: NotificationSound // Sound when session is waiting for input
  review_sound: NotificationSound // Sound when session finishes reviewing
  workspace_folder: string // Base folder for worktrees (empty = default ~/jean/)
  default_ai_provider: AiCliProvider // Default AI CLI provider
}

export type FileEditMode = 'inline' | 'external'

export const fileEditModeOptions: { value: FileEditMode; label: string }[] = [
  { value: 'inline', label: 'Jean (inline editor)' },
  { value: 'external', label: 'External editor' },
]

// =============================================================================
// AI Model Types - Per Provider
// =============================================================================

export type ClaudeModel = 'opus' | 'sonnet' | 'haiku'

export const claudeModelOptions: { value: ClaudeModel; label: string }[] = [
  { value: 'opus', label: 'Claude Opus' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'haiku', label: 'Claude Haiku' },
]

// Legacy alias for backwards compatibility
export const modelOptions = claudeModelOptions

export type GeminiModel =
  | 'gemini-3-flash-preview'
  | 'gemini-3-pro-preview'

export const geminiModelOptions: { value: GeminiModel; label: string }[] = [
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
]

export type CodexModel = 'gpt-5.2-codex'

export const codexModelOptions: { value: CodexModel; label: string }[] = [
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
]

// Union type for all models across providers
export type AiModel = ClaudeModel | GeminiModel | CodexModel

// Helper to get model options for a provider
export function getModelOptionsForProvider(provider: AiCliProvider): { value: string; label: string }[] {
  switch (provider) {
    case 'claude':
      return claudeModelOptions
    case 'gemini':
      return geminiModelOptions
    case 'codex':
      return codexModelOptions
    default:
      return claudeModelOptions
  }
}

// Helper to get default model for a provider
export function getDefaultModelForProvider(provider: AiCliProvider): string {
  switch (provider) {
    case 'claude':
      return 'opus'
    case 'gemini':
      return 'gemini-3-flash-preview'
    case 'codex':
      return 'gpt-5.2-codex'
    default:
      return 'opus'
  }
}

// AI CLI Provider types
export type AiCliProvider = 'claude' | 'gemini' | 'codex'

export const aiProviderOptions: { value: AiCliProvider; label: string; description: string }[] = [
  { value: 'claude', label: 'Anthropic', description: 'Claude Code CLI' },
  { value: 'gemini', label: 'Google', description: 'Gemini CLI' },
  { value: 'codex', label: 'OpenAI', description: 'OpenAI Codex CLI' },
]

export const thinkingLevelOptions: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'think', label: 'Think (4K)' },
  { value: 'megathink', label: 'Megathink (10K)' },
  { value: 'ultrathink', label: 'Ultrathink (32K)' },
]

export type TerminalApp = 'terminal' | 'warp' | 'ghostty'

export const terminalOptions: { value: TerminalApp; label: string }[] = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'warp', label: 'Warp' },
  { value: 'ghostty', label: 'Ghostty' },
]

export type EditorApp = 'vscode' | 'cursor' | 'xcode'

export const editorOptions: { value: EditorApp; label: string }[] = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'xcode', label: 'Xcode' },
]

// Font size is now a pixel value
export type FontSize = number

export const FONT_SIZE_DEFAULT = 16

export type UIFont = 'inter' | 'geist' | 'roboto' | 'lato' | 'system'
export type ChatFont =
  | 'jetbrains-mono'
  | 'fira-code'
  | 'source-code-pro'
  | 'inter'
  | 'geist'
  | 'roboto'
  | 'lato'

export const uiFontOptions: { value: UIFont; label: string }[] = [
  { value: 'inter', label: 'Inter' },
  { value: 'geist', label: 'Geist' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'lato', label: 'Lato' },
  { value: 'system', label: 'System Default' },
]

export const chatFontOptions: { value: ChatFont; label: string }[] = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'inter', label: 'Inter' },
  { value: 'geist', label: 'Geist' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'lato', label: 'Lato' },
]

// Git poll interval options (seconds) - for local git commands
export const gitPollIntervalOptions: { value: number; label: string }[] = [
  { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
]

// Remote poll interval options (seconds) - for API calls like PR status
export const remotePollIntervalOptions: { value: number; label: string }[] = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
]

// Archive retention options (days) - how long to keep archived items
export const archiveRetentionOptions: { value: number; label: string }[] = [
  { value: 0, label: 'Never (keep forever)' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
]

// Syntax highlighting themes (from shiki bundled themes)
export type SyntaxTheme =
  | 'vitesse-black'
  | 'vitesse-dark'
  | 'vitesse-light'
  | 'github-dark'
  | 'github-light'
  | 'github-dark-dimmed'
  | 'dracula'
  | 'dracula-soft'
  | 'nord'
  | 'catppuccin-mocha'
  | 'catppuccin-macchiato'
  | 'catppuccin-frappe'
  | 'catppuccin-latte'
  | 'one-dark-pro'
  | 'one-light'
  | 'tokyo-night'
  | 'rose-pine'
  | 'rose-pine-moon'
  | 'rose-pine-dawn'

// Dark syntax themes
export const syntaxThemeDarkOptions: { value: SyntaxTheme; label: string }[] = [
  { value: 'vitesse-black', label: 'Vitesse Black' },
  { value: 'vitesse-dark', label: 'Vitesse Dark' },
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'github-dark-dimmed', label: 'GitHub Dark Dimmed' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'dracula-soft', label: 'Dracula Soft' },
  { value: 'nord', label: 'Nord' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { value: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { value: 'one-dark-pro', label: 'One Dark Pro' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'rose-pine-moon', label: 'Rosé Pine Moon' },
]

// Light syntax themes
export const syntaxThemeLightOptions: { value: SyntaxTheme; label: string }[] =
  [
    { value: 'github-light', label: 'GitHub Light' },
    { value: 'vitesse-light', label: 'Vitesse Light' },
    { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
    { value: 'one-light', label: 'One Light' },
    { value: 'rose-pine-dawn', label: 'Rosé Pine Dawn' },
  ]

// Helper functions to get display labels
export function getTerminalLabel(terminal: TerminalApp | undefined): string {
  const option = terminalOptions.find(opt => opt.value === terminal)
  return option?.label ?? 'Terminal'
}

export function getEditorLabel(editor: EditorApp | undefined): string {
  const option = editorOptions.find(opt => opt.value === editor)
  return option?.label ?? 'Editor'
}

export const defaultPreferences: AppPreferences = {
  theme: 'system',
  selected_model: 'opus',
  thinking_level: 'ultrathink',
  terminal: 'terminal',
  editor: 'vscode',
  auto_branch_naming: true,
  branch_naming_model: 'haiku',
  auto_session_naming: true,
  session_naming_model: 'haiku',
  ui_font_size: FONT_SIZE_DEFAULT,
  chat_font_size: FONT_SIZE_DEFAULT,
  ui_font: 'geist',
  chat_font: 'geist',
  git_poll_interval: 60,
  remote_poll_interval: 60,
  keybindings: DEFAULT_KEYBINDINGS,
  archive_retention_days: 30,
  session_grouping_enabled: true,
  syntax_theme_dark: 'vitesse-black',
  syntax_theme_light: 'github-light',
  disable_thinking_in_non_plan_modes: true, // Default: only plan mode uses thinking
  session_recap_enabled: false, // Default: disabled (experimental)
  session_recap_model: 'haiku', // Default: haiku for fast recaps
  parallel_execution_prompt_enabled: false, // Default: disabled (experimental)
  magic_prompts: DEFAULT_MAGIC_PROMPTS,
  magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
  file_edit_mode: 'external',
  ai_language: '', // Default: empty (Claude's default behavior)
  allow_web_tools_in_plan_mode: true, // Default: enabled
  waiting_sound: 'none',
  review_sound: 'none',
  workspace_folder: '', // Default: empty means ~/jean/
  default_ai_provider: 'claude', // Default: Claude
}
