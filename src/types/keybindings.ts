// Keybinding action identifiers - extensible for future shortcuts
export type KeybindingAction =
  | 'focus_chat_input'
  | 'toggle_left_sidebar'
  | 'open_preferences'
  | 'open_commit_modal'
  | 'open_git_diff'
  | 'execute_run'
  | 'open_in_modal'
  | 'open_magic_modal'
  | 'new_session'
  | 'next_session'
  | 'previous_session'
  | 'close_session_or_worktree'
  | 'new_worktree'
  | 'cycle_execution_mode'
  | 'approve_plan'
  | 'approve_plan_yolo'
  | 'approve_plan_clear_context'
  | 'approve_plan_clear_context_build'
  | 'approve_plan_worktree_build'
  | 'approve_plan_worktree_yolo'
  | 'open_plan'
  | 'open_recap'
  | 'restore_last_archived'
  | 'focus_canvas_search'
  | 'toggle_terminal'
  | 'toggle_session_label'
  | 'open_provider_dropdown'
  | 'open_model_dropdown'
  | 'open_thinking_dropdown'
  | 'open_unread_sessions'
  | 'cancel_prompt'
  | 'scroll_chat_up'
  | 'scroll_chat_down'
  | 'open_github_dashboard'
  | 'open_quick_menu'
  | 'open_usage_dropdown'

// Shortcut string format: "mod+key" where mod is cmd/ctrl
// Examples: "mod+l", "mod+shift+p", "mod+1"
export type ShortcutString = string

// Main keybindings record stored in preferences
export type KeybindingsMap = Record<string, ShortcutString>

// Display metadata for the settings UI
export interface KeybindingDefinition {
  action: KeybindingAction
  label: string
  description: string
  default_shortcut: ShortcutString
  category: 'navigation' | 'git' | 'chat'
}

// Default keybindings configuration
export const DEFAULT_KEYBINDINGS: KeybindingsMap = {
  focus_chat_input: 'mod+l',
  toggle_left_sidebar: 'mod+b',
  open_preferences: 'mod+comma',
  open_commit_modal: 'mod+shift+c',
  open_git_diff: 'mod+g',
  execute_run: 'mod+r',
  open_in_modal: 'mod+o',
  open_magic_modal: 'mod+m',
  new_session: 'mod+t',
  next_session: 'mod+alt+arrowright',
  previous_session: 'mod+alt+arrowleft',
  close_session_or_worktree: 'mod+w',
  new_worktree: 'mod+n',
  cycle_execution_mode: 'shift+tab',
  approve_plan: 'mod+enter',
  approve_plan_yolo: 'mod+y',
  approve_plan_clear_context: 'mod+shift+y',
  approve_plan_clear_context_build: 'mod+shift+enter',
  approve_plan_worktree_build: 'mod+alt+enter',
  approve_plan_worktree_yolo: 'mod+alt+y',
  open_plan: 'p',
  open_recap: 'r',
  restore_last_archived: 'mod+shift+t',
  focus_canvas_search: 'slash',
  toggle_terminal: 'mod+backquote',
  toggle_session_label: 'mod+s',
  open_provider_dropdown: 'mod+shift+p',
  open_model_dropdown: 'mod+shift+m',
  open_thinking_dropdown: 'mod+shift+e',
  open_unread_sessions: 'mod+shift+f',
  cancel_prompt: 'mod+alt+backspace',
  scroll_chat_up: 'mod+arrowup',
  scroll_chat_down: 'mod+arrowdown',
  open_github_dashboard: 'mod+shift+d',
  open_quick_menu: 'mod+period',
  open_usage_dropdown: 'mod+u',
}

// UI definitions for the settings pane
export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  {
    action: 'focus_chat_input',
    label: 'Focus chat input',
    description: 'Move focus to the chat textarea',
    default_shortcut: 'mod+l',
    category: 'chat',
  },
  {
    action: 'toggle_left_sidebar',
    label: 'Toggle left sidebar',
    description: 'Show or hide the projects sidebar',
    default_shortcut: 'mod+b',
    category: 'navigation',
  },
  {
    action: 'open_preferences',
    label: 'Open preferences',
    description: 'Open the preferences dialog',
    default_shortcut: 'mod+comma',
    category: 'navigation',
  },
  {
    action: 'open_commit_modal',
    label: 'Open commit modal',
    description: 'Open the git commit dialog',
    default_shortcut: 'mod+shift+c',
    category: 'git',
  },
  {
    action: 'open_git_diff',
    label: 'Open git diff',
    description: 'Open the git diff view for uncommitted changes',
    default_shortcut: 'mod+g',
    category: 'git',
  },
  {
    action: 'execute_run',
    label: 'Execute run',
    description: 'Start or stop the run script in current workspace',
    default_shortcut: 'mod+r',
    category: 'navigation',
  },
  {
    action: 'open_in_modal',
    label: 'Open in...',
    description: 'Open current worktree in editor, terminal, or finder',
    default_shortcut: 'mod+o',
    category: 'navigation',
  },
  {
    action: 'open_magic_modal',
    label: 'Magic commands',
    description: 'Open magic git commands menu',
    default_shortcut: 'mod+m',
    category: 'git',
  },
  {
    action: 'new_session',
    label: 'New session',
    description: 'Create a new chat session',
    default_shortcut: 'mod+t',
    category: 'chat',
  },
  {
    action: 'next_session',
    label: 'Next session',
    description: 'Switch to the next chat session',
    default_shortcut: 'mod+alt+arrowright',
    category: 'chat',
  },
  {
    action: 'previous_session',
    label: 'Previous session',
    description: 'Switch to the previous chat session',
    default_shortcut: 'mod+alt+arrowleft',
    category: 'chat',
  },
  {
    action: 'close_session_or_worktree',
    label: 'Close session',
    description:
      'Close the current session, or remove worktree if last session',
    default_shortcut: 'mod+w',
    category: 'chat',
  },
  {
    action: 'cycle_execution_mode',
    label: 'Cycle execution mode',
    description: 'Cycle through Plan, Build, and Yolo modes',
    default_shortcut: 'shift+tab',
    category: 'chat',
  },
  {
    action: 'approve_plan',
    label: 'Approve plan',
    description: 'Approve the current plan in planning mode',
    default_shortcut: 'mod+enter',
    category: 'chat',
  },
  {
    action: 'approve_plan_yolo',
    label: 'Approve plan (YOLO)',
    description: 'Approve the current plan with YOLO mode',
    default_shortcut: 'mod+y',
    category: 'chat',
  },
  {
    action: 'approve_plan_clear_context',
    label: 'Clear context and yolo',
    description: 'Approve plan, clear context, and start a new yolo session',
    default_shortcut: 'mod+shift+y',
    category: 'chat',
  },
  {
    action: 'approve_plan_clear_context_build',
    label: 'Clear context and build',
    description: 'Approve plan, clear context, and start a new build session',
    default_shortcut: 'mod+shift+enter',
    category: 'chat',
  },
  {
    action: 'approve_plan_worktree_build',
    label: 'Worktree build',
    description: 'Approve plan and execute in a new worktree (build mode)',
    default_shortcut: 'mod+alt+enter',
    category: 'chat',
  },
  {
    action: 'approve_plan_worktree_yolo',
    label: 'Worktree yolo',
    description: 'Approve plan and execute in a new worktree (yolo mode)',
    default_shortcut: 'mod+alt+y',
    category: 'chat',
  },
  {
    action: 'open_plan',
    label: 'Open plan',
    description: 'Open the plan dialog for the selected session',
    default_shortcut: 'p',
    category: 'chat',
  },
  {
    action: 'open_recap',
    label: 'Open recap',
    description: 'Open the session recap dialog for the selected session',
    default_shortcut: 'r',
    category: 'chat',
  },
  {
    action: 'new_worktree',
    label: 'New worktree',
    description: 'Create a new worktree in the current project',
    default_shortcut: 'mod+n',
    category: 'navigation',
  },
  {
    action: 'restore_last_archived',
    label: 'Restore archived',
    description: 'Restore the most recently archived worktree or session',
    default_shortcut: 'mod+shift+t',
    category: 'navigation',
  },
  {
    action: 'focus_canvas_search',
    label: 'Focus canvas search',
    description: 'Focus the search input on canvas views',
    default_shortcut: 'slash',
    category: 'navigation',
  },
  {
    action: 'toggle_terminal',
    label: 'Toggle terminal',
    description: 'Show or hide the terminal panel',
    default_shortcut: 'mod+backquote',
    category: 'chat',
  },
  {
    action: 'toggle_session_label',
    label: 'Toggle label',
    description: 'Mark/unmark session with "Needs testing" label',
    default_shortcut: 'mod+s',
    category: 'chat',
  },
  {
    action: 'open_provider_dropdown',
    label: 'Open provider dropdown',
    description: 'Open the provider selector dropdown',
    default_shortcut: 'mod+shift+p',
    category: 'chat',
  },
  {
    action: 'open_model_dropdown',
    label: 'Open model dropdown',
    description: 'Open the model selector dropdown',
    default_shortcut: 'mod+shift+m',
    category: 'chat',
  },
  {
    action: 'open_thinking_dropdown',
    label: 'Open thinking dropdown',
    description: 'Open the thinking/effort level dropdown',
    default_shortcut: 'mod+shift+e',
    category: 'chat',
  },
  {
    action: 'open_unread_sessions',
    label: 'Finished sessions',
    description: 'Open the finished/unread sessions popover',
    default_shortcut: 'mod+shift+f',
    category: 'navigation',
  },
  {
    action: 'cancel_prompt',
    label: 'Cancel prompt',
    description: 'Cancel the running Claude process for the current session',
    default_shortcut: 'mod+alt+backspace',
    category: 'chat',
  },
  {
    action: 'scroll_chat_up',
    label: 'Scroll chat up',
    description: 'Scroll the chat message list up by one page',
    default_shortcut: 'mod+arrowup',
    category: 'chat',
  },
  {
    action: 'scroll_chat_down',
    label: 'Scroll chat down',
    description: 'Scroll the chat message list down by one page',
    default_shortcut: 'mod+arrowdown',
    category: 'chat',
  },
  {
    action: 'open_github_dashboard',
    label: 'GitHub Dashboard',
    description: 'Open the GitHub Dashboard (issues, PRs, security across all projects)',
    default_shortcut: 'mod+shift+d',
    category: 'navigation',
  },
  {
    action: 'open_quick_menu',
    label: 'Quick menu',
    description: 'Open the floating quick menu',
    default_shortcut: 'mod+period',
    category: 'navigation',
  },
  {
    action: 'open_usage_dropdown',
    label: 'Usage dropdown',
    description: 'Open the floating usage dropdown',
    default_shortcut: 'mod+u',
    category: 'navigation',
  },
]

// Helper to convert shortcut string to display format
export function formatShortcutDisplay(
  shortcut: ShortcutString | undefined | null
): string {
  if (!shortcut) return ''

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
  // On macOS web, Cmd shortcuts are intercepted by the browser.
  // Ctrl+key already works (both map to "mod"), so show ⌃ instead of ⌘.
  const isWeb =
    typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
  const useMacCtrl = isMac && isWeb

  return shortcut
    .split('+')
    .map(part => {
      switch (part) {
        case 'mod':
          return useMacCtrl ? '⌃' : isMac ? '⌘' : 'Ctrl'
        case 'shift':
          return isMac ? '⇧' : 'Shift'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'comma':
          return ','
        case 'period':
          return '.'
        case 'arrowup':
          return '↑'
        case 'arrowdown':
          return '↓'
        case 'arrowleft':
          return '←'
        case 'arrowright':
          return '→'
        case 'slash':
          return '/'
        case 'backspace':
          return isMac ? '⌫' : 'Backspace'
        case 'enter':
          return isMac ? '↩' : 'Enter'
        case 'tab':
          return 'Tab'
        case 'escape':
          return 'Esc'
        default:
          return part.toUpperCase()
      }
    })
    .join(' + ')
}

// Helper to parse keyboard event into shortcut string
export function eventToShortcutString(e: KeyboardEvent): ShortcutString | null {
  // Ignore modifier-only presses
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    return null
  }

  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')

  // Prefer physical key codes when possible so Option/Alt modified letters
  // on macOS (e.g. Alt+M -> µ, Alt+E -> Dead) still map to alt+m / alt+e.
  const keyFromCode = keyboardCodeToShortcutKey(e.code)
  if (keyFromCode) {
    parts.push(keyFromCode)
    return parts.join('+')
  }

  // Normalize key names
  let key = e.key.toLowerCase()
  if (key === ',') key = 'comma'
  if (key === '.') key = 'period'
  if (key === '/') key = 'slash'
  if (key === '\\') key = 'backslash'
  if (key === '[') key = 'bracketleft'
  if (key === ']') key = 'bracketright'
  if (key === ';') key = 'semicolon'
  if (key === "'") key = 'quote'
  if (key === '`') key = 'backquote'
  if (key === '-') key = 'minus'
  if (key === '=') key = 'equal'
  if (key === 'delete') key = 'backspace'

  parts.push(key)

  return parts.join('+')
}

function keyboardCodeToShortcutKey(code: string): string | null {
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toLowerCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5)
  }

  switch (code) {
    case 'Comma':
      return 'comma'
    case 'Period':
      return 'period'
    case 'Slash':
      return 'slash'
    case 'Backslash':
      return 'backslash'
    case 'BracketLeft':
      return 'bracketleft'
    case 'BracketRight':
      return 'bracketright'
    case 'Semicolon':
      return 'semicolon'
    case 'Quote':
      return 'quote'
    case 'Backquote':
      return 'backquote'
    case 'Minus':
      return 'minus'
    case 'Equal':
      return 'equal'
    case 'ArrowUp':
      return 'arrowup'
    case 'ArrowDown':
      return 'arrowdown'
    case 'ArrowLeft':
      return 'arrowleft'
    case 'ArrowRight':
      return 'arrowright'
    case 'Enter':
      return 'enter'
    case 'Tab':
      return 'tab'
    case 'Escape':
      return 'escape'
    case 'Backspace':
      return 'backspace'
    case 'Delete':
      // Treat forward delete as backspace so mod+alt+delete also matches
      // cancel shortcuts across keyboard layouts/devices.
      return 'backspace'
    case 'Space':
      return 'space'
    default:
      return null
  }
}

// Helper to check if an event matches a shortcut string
export function eventMatchesShortcut(
  e: KeyboardEvent,
  shortcut: ShortcutString
): boolean {
  const eventShortcut = eventToShortcutString(e)
  return eventShortcut === shortcut
}
