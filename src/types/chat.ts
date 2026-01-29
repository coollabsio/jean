/**
 * Role of a chat message sender
 */
export type MessageRole = 'user' | 'assistant'

/**
 * Thinking level for Claude responses
 * Controls --settings alwaysThinkingEnabled and MAX_THINKING_TOKENS env var
 * - off: Thinking disabled
 * - think: 4K tokens budget
 * - megathink: 10K tokens budget
 * - ultrathink: 32K tokens budget (default)
 */
export type ThinkingLevel = 'off' | 'think' | 'megathink' | 'ultrathink'

/**
 * Execution mode for Claude CLI permission handling
 * - plan: Read-only mode, Claude can't make changes (--permission-mode plan)
 * - build: Auto-approve file edits only (--permission-mode acceptEdits)
 * - yolo: Auto-approve ALL tools without prompting (--permission-mode bypassPermissions)
 */
export type ExecutionMode = 'plan' | 'build' | 'yolo'

/** Cycle order for execution modes (used by Shift+Tab cycling) */
export const EXECUTION_MODE_CYCLE: ExecutionMode[] = ['plan', 'build', 'yolo']

/**
 * A tool call made by Claude during a response
 */
export interface ToolCall {
  /** Tool call ID from Claude */
  id: string
  /** Name of the tool (e.g., "Read", "Edit", "Bash") */
  name: string
  /** Input parameters as JSON value */
  input: unknown
  /** Output/result from tool execution (from tool_result messages) */
  output?: string
  /** Parent tool use ID for sub-agent tool calls (for parallel task attribution) */
  parent_tool_use_id?: string
}

/**
 * A content block in a message - text, tool use, or thinking
 * Used to preserve the order of content in Claude's response
 * Note: Uses snake_case to match Rust serde serialization (rename_all = "snake_case")
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string }
  | { type: 'thinking'; thinking: string }

/**
 * A single chat message
 */
export interface ChatMessage {
  id: string
  /** Session ID this message belongs to (was worktree_id in v1) */
  session_id: string
  role: MessageRole
  content: string
  timestamp: number
  /** Tool calls made during this message (only for assistant messages) */
  tool_calls: ToolCall[]
  /** Ordered content blocks preserving tool position in response (optional for backward compat) */
  content_blocks?: ContentBlock[]
  /** True if the message was cancelled mid-stream */
  cancelled?: boolean
  /** True if the plan in this message was approved by the user */
  plan_approved?: boolean
  /** Model used when this message was sent (user messages only) */
  model?: string
  /** Execution mode when this message was sent (user messages only) */
  execution_mode?: ExecutionMode
  /** Thinking level when this message was sent (user messages only) */
  thinking_level?: ThinkingLevel
  /** True if this message was recovered from a crash */
  recovered?: boolean
  /** Token usage for this message (assistant messages only) */
  usage?: UsageData
}

// ============================================================================
// Session Types (for multiple tabs per worktree)
// ============================================================================

/**
 * Context for a denied message that can be re-sent after permission approval
 */
export interface DeniedMessageContext {
  /** Original message content */
  message: string
  /** Model that was selected */
  model: string
  /** Thinking level that was selected */
  thinking_level: string
}

/**
 * A chat session within a worktree (supports multiple sessions per worktree)
 */
export interface Session {
  /** Unique session identifier (UUID v4) */
  id: string
  /** Display name ("Session 1", or user-customized name) */
  name: string
  /** Order index for tab ordering (0-indexed) */
  order: number
  /** Unix timestamp when session was created */
  created_at: number
  /** Chat messages for this session */
  messages: ChatMessage[]
  /** Message count (populated separately for efficiency when full messages not needed) */
  message_count?: number
  /** Claude CLI session ID for resuming conversations */
  claude_session_id?: string
  /** Selected AI provider for this session */
  selected_provider?: string
  /** Selected model for this session */
  selected_model?: string
  /** Selected thinking level for this session */
  selected_thinking_level?: ThinkingLevel
  /** Whether session naming has been attempted for this session */
  session_naming_completed?: boolean
  /** Unix timestamp when session was archived (undefined = not archived) */
  archived_at?: number

  // ========================================================================
  // Session-specific UI state (moved from ui-state.json)
  // ========================================================================

  /** Tool call IDs that have been answered (for AskUserQuestion) */
  answered_questions?: string[]
  /** Submitted answers per tool call: toolCallId -> answers (as JSON) */
  submitted_answers?: Record<string, QuestionAnswer[]>
  /** Finding keys that have been marked as fixed */
  fixed_findings?: string[]
  /** Pending permission denials awaiting user approval */
  pending_permission_denials?: PermissionDenial[]
  /** Original message context for re-send after permission approval */
  denied_message_context?: DeniedMessageContext
  /** Whether this session is marked for review in session board */
  is_reviewing?: boolean
  /** Whether this session is waiting for user input (AskUserQuestion, ExitPlanMode) */
  waiting_for_input?: boolean
  /** Message IDs whose plans have been approved (for NDJSON-only storage) */
  approved_plan_message_ids?: string[]
}

/**
 * An archived session with its worktree context
 * Used for displaying archived sessions in the ArchivedModal
 */
export interface ArchivedSessionEntry {
  session: Session
  worktree_id: string
  worktree_name: string
  worktree_path: string
  project_id: string
  project_name: string
}

/**
 * All sessions for a worktree (stored in app data directory, NOT in the worktree)
 * Location: ~/Library/Application Support/<app>/sessions/<worktree_id>.json
 */
export interface WorktreeSessions {
  /** Worktree ID for reference */
  worktree_id: string
  /** All sessions in this worktree */
  sessions: Session[]
  /** ID of the active/displayed session tab */
  active_session_id: string | null
  /** Default model for new sessions in this worktree */
  default_model?: string
  /** Storage format version for migrations */
  version: number
  /** Whether branch naming has been attempted for this worktree */
  branch_naming_completed?: boolean
}

/**
 * Chat history for a worktree (legacy format - kept for backward compatibility)
 * @deprecated Use Session and WorktreeSessions instead
 */
export interface ChatHistory {
  worktree_id: string
  messages: ChatMessage[]
  /** Selected model for this worktree (sonnet, opus, haiku) */
  selected_model?: string
  /** Selected thinking level for this worktree */
  selected_thinking_level?: ThinkingLevel
}

// ============================================================================
// Usage Types
// ============================================================================

/**
 * Token usage data from Claude CLI response
 */
export interface UsageData {
  /** Input tokens (context sent to Claude) */
  input_tokens: number
  /** Output tokens (generated by Claude) */
  output_tokens: number
  /** Cache read tokens (reused from previous requests, cost reduction) */
  cache_read_input_tokens?: number
  /** Cache creation tokens (cached for future requests) */
  cache_creation_input_tokens?: number
}

// ============================================================================
// Compaction Types
// ============================================================================

/**
 * Metadata from a compaction event
 */
export interface CompactMetadata {
  /** How compaction was triggered: "manual" or "auto" */
  trigger: string
  /** Token count before compaction */
  pre_tokens: number
}

// ============================================================================
// Event Types (updated for sessions)
// ============================================================================

/**
 * Event payload for streaming text chunks from Rust
 */
export interface ChunkEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  content: string
}

/**
 * Event payload for tool use from Rust
 */
export interface ToolUseEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  id: string
  name: string
  input: unknown
  /** Parent tool use ID for sub-agent tool calls (for parallel task attribution) */
  parent_tool_use_id?: string
}

/**
 * Event payload for completion from Rust
 */
export interface DoneEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  // Optional content for non-streaming providers (Gemini, Codex)
  content?: string
}

/**
 * Event payload for context compaction from Rust
 */
export interface CompactedEvent {
  session_id: string
  worktree_id: string
  metadata: CompactMetadata
}

/**
 * Event payload for errors from Rust
 */
export interface ErrorEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  error: string
}

/**
 * Event payload for cancellation from Rust (user pressed Escape)
 */
export interface CancelledEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  undo_send: boolean // True if user message should be restored to input (instant cancellation)
}

/**
 * Event payload for tool block position from Rust
 * Signals where a tool_use block appears in the content stream
 */
export interface ToolBlockEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  tool_call_id: string
}

/**
 * Event payload for thinking content from Rust (extended thinking)
 */
export interface ThinkingEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  content: string
}

/**
 * Event payload for tool result from Rust
 * Contains the output from a tool execution
 */
export interface ToolResultEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  tool_use_id: string
  output: string
}

// ============================================================================
// Permission Denial Types
// ============================================================================

/**
 * A permission denial from Claude CLI when a tool requires approval
 */
export interface PermissionDenial {
  /** Name of the denied tool (e.g., "Bash") */
  tool_name: string
  /** Tool use ID from Claude */
  tool_use_id: string
  /** Input parameters that were denied */
  tool_input: unknown
}

/**
 * Event payload for permission denied from Rust
 * Sent when Claude CLI returns permission_denials (tools that require approval)
 */
export interface PermissionDeniedEvent {
  session_id: string
  worktree_id: string // Kept for backward compatibility
  denials: PermissionDenial[]
}

// ============================================================================
// AskUserQuestion Types
// ============================================================================

/**
 * Question option in AskUserQuestion tool
 */
export interface QuestionOption {
  label: string
  description?: string
}

/**
 * Single question in AskUserQuestion tool
 */
export interface Question {
  question: string
  header?: string
  multiSelect: boolean
  options: QuestionOption[]
}

/**
 * Input structure for AskUserQuestion tool
 */
export interface AskUserQuestionInput {
  questions: Question[]
}

/**
 * Type guard to check if a tool call is AskUserQuestion
 */
export function isAskUserQuestion(
  toolCall: ToolCall
): toolCall is ToolCall & { input: AskUserQuestionInput } {
  return (
    toolCall.name === 'AskUserQuestion' &&
    typeof toolCall.input === 'object' &&
    toolCall.input !== null &&
    'questions' in toolCall.input &&
    Array.isArray((toolCall.input as AskUserQuestionInput).questions)
  )
}

/**
 * Type guard to check if a tool call is ExitPlanMode
 */
export function isExitPlanMode(toolCall: ToolCall): boolean {
  return toolCall.name === 'ExitPlanMode'
}

// ============================================================================
// TodoWrite Types
// ============================================================================

/**
 * A single todo item from TodoWrite tool
 */
export interface Todo {
  /** The todo content (what needs to be done) */
  content: string
  /** Present continuous form shown during execution */
  activeForm: string
  /** Current status of the todo */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/**
 * Input structure for TodoWrite tool
 */
export interface TodoWriteInput {
  todos: Todo[]
}

/**
 * Type guard to check if a tool call is TodoWrite
 */
export function isTodoWrite(
  toolCall: ToolCall
): toolCall is ToolCall & { input: TodoWriteInput } {
  return (
    toolCall.name === 'TodoWrite' &&
    typeof toolCall.input === 'object' &&
    toolCall.input !== null &&
    'todos' in toolCall.input &&
    Array.isArray((toolCall.input as TodoWriteInput).todos)
  )
}

/**
 * Answer to a single question
 */
export interface QuestionAnswer {
  questionIndex: number
  selectedOptions: number[]
  customText?: string
}

// ============================================================================
// Image Types (for pasted images in chat)
// ============================================================================

/**
 * Represents a pending image attachment before sending
 * The image has already been saved to disk, we just store the path reference
 */
export interface PendingImage {
  /** Unique ID for this pending image */
  id: string
  /** Full file path to the saved image */
  path: string
  /** Filename (e.g., "image-1704067200-abc123.png") */
  filename: string
}

/**
 * Response from the save_pasted_image Tauri command
 */
export interface SaveImageResponse {
  /** Unique ID for this image */
  id: string
  /** Filename (e.g., "image-1704067200-abc123.png") */
  filename: string
  /** Full path to the saved image */
  path: string
}

// ============================================================================
// Text Paste Types (for large text pastes in chat)
// ============================================================================

/**
 * Represents a pending text file attachment before sending
 * Large text pastes (500+ chars) are saved as files instead of being inlined
 */
export interface PendingTextFile {
  /** Unique ID for this pending text file */
  id: string
  /** Full file path to the saved text file */
  path: string
  /** Filename (e.g., "paste-1704067200-abc123.txt") */
  filename: string
  /** Size in bytes */
  size: number
  /** Full content for preview */
  content: string
}

/**
 * Response from the save_pasted_text Tauri command
 */
export interface SaveTextResponse {
  /** Unique ID for this text file */
  id: string
  /** Filename (e.g., "paste-1704067200-abc123.txt") */
  filename: string
  /** Full path to the saved text file */
  path: string
  /** Size in bytes */
  size: number
}

/**
 * Response from the read_pasted_text Tauri command
 */
export interface ReadTextResponse {
  /** Content of the text file */
  content: string
  /** Size in bytes */
  size: number
}

// ============================================================================
// File Mention Types (for @ mentions in chat)
// ============================================================================

/**
 * Represents a file from the worktree file list
 * Matches the Rust WorktreeFile struct
 */
export interface WorktreeFile {
  /** Relative path from worktree root (e.g., "src/components/Button.tsx") */
  relative_path: string
  /** File extension (e.g., "tsx", "rs") or empty for no extension */
  extension: string
}

/**
 * Represents a pending file attachment before sending
 */
export interface PendingFile {
  /** Unique ID for this pending file */
  id: string
  /** Relative path from worktree root */
  relativePath: string
  /** File extension */
  extension: string
}

// ============================================================================
// Slash Commands & Skills Types (for / mentions in chat)
// ============================================================================

/**
 * A Claude CLI skill from ~/.claude/skills/
 * Skills can be attached anywhere in a prompt as context
 */
export interface ClaudeSkill {
  /** Skill name (filename without .md extension) */
  name: string
  /** Full path to the skill file */
  path: string
  /** Optional description from file header */
  description?: string
}

/**
 * A Claude CLI custom command from ~/.claude/commands/
 * Commands can only be executed at the start of an empty prompt
 */
export interface ClaudeCommand {
  /** Command name (filename without .md extension) */
  name: string
  /** Full path to the command file */
  path: string
  /** Optional description from file header */
  description?: string
}

/**
 * Represents a pending skill attachment before sending
 */
export interface PendingSkill {
  /** Unique ID for this pending skill */
  id: string
  /** Skill name */
  name: string
  /** Full path to skill file */
  path: string
}

// ============================================================================
// Setup Script Types
// ============================================================================

/**
 * Result of running a setup script from jean.json
 */
export interface SetupScriptResult {
  /** Name of the worktree that was created */
  worktreeName: string
  /** Path to the worktree where the script was executed */
  worktreePath: string
  /** The script that was executed */
  script: string
  /** Output from the setup script */
  output: string
  /** Whether the script succeeded */
  success: boolean
}

// ============================================================================
// Review Finding Types
// ============================================================================

/**
 * Severity level for a code review finding
 */
export type FindingSeverity = 'error' | 'warning' | 'info'

/**
 * A suggested fix option for a review finding
 */
export interface SuggestionOption {
  /** Label describing this option */
  label: string
  /** The actual fix/code suggestion */
  code: string
}

/**
 * A parsed code review finding from Claude's response
 */
export interface ReviewFinding {
  /** Severity level of the finding */
  severity: FindingSeverity
  /** File path relative to worktree */
  file: string
  /** Line number or range (e.g., "42" or "42-45") */
  line: string
  /** Short title of the issue */
  title: string
  /** Detailed description of the issue */
  description: string
  /** The problematic code snippet */
  code: string
  /** Suggested fix options (multiple alternatives) */
  suggestions: SuggestionOption[]
}

// ============================================================================
// Message Queue Types
// ============================================================================

/**
 * A message waiting in the queue to be sent
 * Captures all settings at the time of queueing so they're preserved
 */
export interface QueuedMessage {
  /** Unique ID for this queued message (for reordering/removal) */
  id: string
  /** The message text (already formatted with file/image references) */
  message: string
  /** Snapshot of pending images at time of queue */
  pendingImages: PendingImage[]
  /** Snapshot of pending files at time of queue */
  pendingFiles: PendingFile[]
  /** Snapshot of pending skills at time of queue */
  pendingSkills: PendingSkill[]
  /** Snapshot of pending text files at time of queue */
  pendingTextFiles: PendingTextFile[]
  /** AI provider to use for this message (snapshot at queue time) */
  provider: string
  /** Model to use for this message (snapshot at queue time) */
  model: string
  /** Execution mode setting (snapshot at queue time) */
  executionMode: ExecutionMode
  /** Thinking level setting (snapshot at queue time) */
  thinkingLevel: ThinkingLevel
  /** Whether thinking should be disabled for this mode (snapshot at queue time) */
  disableThinkingForMode: boolean
  /** Timestamp when queued (for display ordering) */
  queuedAt: number
}

// ============================================================================
// Saved Context Types (for Save/Load Context magic commands)
// ============================================================================

/**
 * Metadata for a saved context file
 * Stored in ~/Library/Application Support/<app>/session-context/
 */
export interface SavedContext {
  /** Unique ID (UUID) */
  id: string
  /** Filename (e.g., "jean-v1-1704067200-implement-magic-commands.md") */
  filename: string
  /** Full path to the saved context file */
  path: string
  /** Project name this context was saved from */
  project_name: string
  /** AI-generated slug from the summary */
  slug: string
  /** File size in bytes */
  size: number
  /** Unix timestamp when context was created */
  created_at: number
  /** Optional custom display name (from metadata file) */
  name?: string
}

/**
 * Response from list_saved_contexts Tauri command
 */
export interface SavedContextsResponse {
  contexts: SavedContext[]
}

/**
 * Response from save_context_file Tauri command
 */
export interface SaveContextResponse {
  /** Unique ID for this context */
  id: string
  /** Filename (e.g., "jean-v1-1704067200-implement-magic-commands.md") */
  filename: string
  /** Full path to the saved context file */
  path: string
  /** File size in bytes */
  size: number
}

// ============================================================================
// All Sessions Types (for loading sessions across all worktrees)
// ============================================================================

/**
 * Entry containing sessions for a single worktree with project/worktree context
 * Used by Load Context modal to show sessions from all projects
 */
export interface AllSessionsEntry {
  project_id: string
  project_name: string
  worktree_id: string
  worktree_name: string
  worktree_path: string
  sessions: Session[]
}

/**
 * Response from list_all_sessions Tauri command
 */
export interface AllSessionsResponse {
  entries: AllSessionsEntry[]
}

// ============================================================================
// Debug Info Types (for SessionDebugPanel)
// ============================================================================

/**
 * Status of a Claude CLI run
 */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'crashed'
  | 'resumable'

/**
 * Information about a single JSONL run log file
 */
export interface RunLogFileInfo {
  /** Run ID (filename without extension) */
  run_id: string
  /** Full path to the JSONL file */
  path: string
  /** Status of the run */
  status: RunStatus
  /** Preview of the user message that triggered this run */
  user_message_preview: string
  /** Token usage for this run (if completed) */
  usage?: UsageData
}

/**
 * Debug information about a session's storage
 */
export interface SessionDebugInfo {
  /** App data directory path */
  app_data_dir: string
  /** Path to the sessions JSON file for this worktree */
  sessions_file: string
  /** Path to the runs directory (contains all session run directories) */
  runs_dir: string
  /** Path to this session's manifest file (if exists) */
  manifest_file?: string
  /** Claude CLI session ID (if any) */
  claude_session_id?: string
  /** Path to Claude CLI's JSONL file (in ~/.claude/projects/) */
  claude_jsonl_file?: string
  /** List of JSONL run log files for this session */
  run_log_files: RunLogFileInfo[]
  /** Total token usage across all runs in this session */
  total_usage: UsageData
}

// ============================================================================
// Session Digest Types (for context recall after switching)
// ============================================================================

/**
 * A brief digest of a session for context recall
 * Generated when user opens a session that had activity while out of focus
 */
export interface SessionDigest {
  /** One sentence summarizing the overall chat goal and progress */
  chat_summary: string
  /** One sentence describing what was just completed */
  last_action: string
}
