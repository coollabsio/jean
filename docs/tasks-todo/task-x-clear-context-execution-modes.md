# Task: Add "Clear Context" Execution Modes (Build + Yolo)

## Overview

Extend execution mode system with two new modes:

- `build-clear`: Clears context, loads plan, executes in build mode
- `yolo-clear`: Clears context, loads plan, executes in yolo mode

**Key behavior:** These modes are only visible when a plan file exists in current session.

## Flow

1. User creates plan in session (Claude writes to `~/.claude/plans/*.md`)
2. Plan file path detected from `Write` tool call in messages
3. User selects "Build (Clear)" or "Yolo (Clear)" mode
4. On send: Create new session → Prepend plan + transcript ref → Execute

## Implementation

### 1. Extend ExecutionMode Type

**File: `src/types/chat.ts`**

```typescript
export type ExecutionMode =
  | 'plan'
  | 'build'
  | 'yolo'
  | 'build-clear'
  | 'yolo-clear'

// Shift+Tab cycle unchanged - clear modes not in cycle
export const EXECUTION_MODE_CYCLE: ExecutionMode[] = ['plan', 'build', 'yolo']
```

### 2. Backend: Permission Mode Mapping

**File: `src-tauri/src/chat/claude.rs:185`**

```rust
let perm_mode = match execution_mode.unwrap_or("plan") {
    "build" | "build-clear" => "acceptEdits",
    "yolo" | "yolo-clear" => "bypassPermissions",
    _ => "plan",
};
```

### 3. Backend: Get Session Transcript Path Command

**File: `src-tauri/src/chat/commands.rs`**

Add new Tauri command:

```rust
#[tauri::command]
pub fn get_session_transcript_path(
    app: AppHandle,
    session_id: String,
) -> Result<Option<String>, String> {
    use super::manifest::{get_session_directory, load_manifest};

    let manifest = load_manifest(&app, &session_id)?;
    if let Some(m) = manifest {
        if let Some(last_run) = m.runs.last() {
            let session_dir = get_session_directory(&app, &session_id)?;
            let ndjson_path = session_dir.join(format!("{}.ndjson", last_run.run_id));
            return Ok(Some(ndjson_path.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}
```

Register in `lib.rs` `invoke_handler`.

### 4. Frontend: Service Function

**File: `src/services/chat.ts`**

```typescript
export async function getSessionTranscriptPath(
  sessionId: string
): Promise<string | null> {
  if (!isTauri()) throw new Error('Not in Tauri context')
  return invoke<string | null>('get_session_transcript_path', { sessionId })
}
```

### 5. Frontend: Plan Detection Utility

**File: `src/components/chat/tool-call-utils.ts`**

Add function to find plan from session messages:

```typescript
export function findPlanFileFromMessages(
  messages: ChatMessage[]
): string | null {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const planPath = findPlanFilePath(msg.tool_calls)
    if (planPath) return planPath
  }
  return null
}
```

### 6. Frontend: Handle Clear Modes in ChatWindow

**File: `src/components/chat/ChatWindow.tsx`**

In submit handler, detect clear modes and:

1. Get plan file path from current session messages
2. Read plan content via `readPlanFile()`
3. Get transcript path via `getSessionTranscriptPath()`
4. Create new session via `createSession()`
5. Build implementation message
6. Switch to new session and send with effective mode

```typescript
// In handleSubmit or useSendMessage usage
if (executionMode === 'build-clear' || executionMode === 'yolo-clear') {
  const planPath = findPlanFileFromMessages(messages)
  if (!planPath) return // Shouldn't happen - UI hides modes when no plan

  const [planContent, transcriptPath] = await Promise.all([
    readPlanFile(planPath),
    getSessionTranscriptPath(sessionId),
  ])

  const newSession = await createSession(worktreeId)
  const effectiveMode = executionMode === 'build-clear' ? 'build' : 'yolo'

  const message = buildImplementationMessage(userInput, planContent, transcriptPath)

  // Send to new session
  sendMessage.mutate({
    sessionId: newSession.id,
    worktreeId,
    worktreePath,
    message,
    executionMode: effectiveMode,
    ...
  })

  // Switch UI to new session
  setActiveSession(newSession.id)
  return
}
```

Implementation message builder:

```typescript
function buildImplementationMessage(
  userInput: string,
  planContent: string,
  transcriptPath: string | null
): string {
  let msg = `Implement the following plan:\n\n${planContent}\n\n`

  if (transcriptPath) {
    msg += `If you need specific details from before clearing context (like exact code snippets, error messages, or content), read the full transcript at:\n${transcriptPath}\n\n`
  }

  if (userInput.trim()) {
    msg += `Additional instructions:\n${userInput}`
  }

  return msg
}
```

### 7. Frontend: Conditional Mode Visibility in Toolbar

**File: `src/components/chat/ChatToolbar.tsx`**

Add `hasPlan` prop and conditionally render clear modes:

```tsx
interface ChatToolbarProps {
  // ... existing props
  hasPlan: boolean // New prop
}

// In dropdown:
{
  hasPlan && (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuRadioItem value="build-clear">
        Build (Clear)
        <span className="ml-auto text-xs text-muted-foreground">
          New session
        </span>
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        value="yolo-clear"
        className="text-red-600 dark:text-red-400"
      >
        Yolo (Clear)
        <span className="ml-auto text-xs">New session</span>
      </DropdownMenuRadioItem>
    </>
  )
}
```

Pass `hasPlan` from ChatWindow:

```typescript
const hasPlan = useMemo(() => {
  return !!findPlanFileFromMessages(messages ?? [])
}, [messages])

<ChatToolbar hasPlan={hasPlan} ... />
```

### 8. Frontend: Execution Commands (Command Palette)

**File: `src/lib/commands/execution-commands.ts`**

Add commands with conditional availability:

```typescript
{
  id: 'execution-build-clear',
  label: 'Build (Clear Context)',
  description: 'Clear context and execute plan in build mode',
  icon: Hammer,
  group: 'execution',
  execute: ctx => ctx.setExecutionMode('build-clear'),
  isAvailable: ctx => ctx.hasActiveSession() && ctx.hasPlan?.(),
},
{
  id: 'execution-yolo-clear',
  label: 'Yolo (Clear Context)',
  description: 'Clear context and execute plan in yolo mode',
  icon: Zap,
  group: 'execution',
  execute: ctx => ctx.setExecutionMode('yolo-clear'),
  isAvailable: ctx => ctx.hasActiveSession() && ctx.hasPlan?.(),
}
```

Update command context type in `src/lib/commands/types.ts` to add `hasPlan`.

## Files to Modify

| File                                     | Change                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| `src/types/chat.ts`                      | Add `'build-clear' \| 'yolo-clear'` to ExecutionMode |
| `src-tauri/src/chat/claude.rs`           | Map clear modes to permission modes                  |
| `src-tauri/src/chat/commands.rs`         | Add `get_session_transcript_path` command            |
| `src-tauri/src/lib.rs`                   | Register new command                                 |
| `src/services/chat.ts`                   | Add `getSessionTranscriptPath()`                     |
| `src/components/chat/tool-call-utils.ts` | Add `findPlanFileFromMessages()`                     |
| `src/components/chat/ChatWindow.tsx`     | Handle clear modes in submit, pass `hasPlan`         |
| `src/components/chat/ChatToolbar.tsx`    | Add `hasPlan` prop, conditionally show modes         |
| `src/lib/commands/execution-commands.ts` | Add clear mode commands                              |
| `src/lib/commands/types.ts`              | Add `hasPlan` to context                             |
| `src/hooks/use-command-context.ts`       | Provide `hasPlan`                                    |

## Verification

1. `cargo build` - Rust compiles
2. `bun run check:all` - TS/lint passes
3. Manual test:
   - Open Jean, no plan → Clear modes hidden
   - Create plan (via plan mode) → Clear modes appear
   - Select "Build (Clear)", type message, send
   - Verify: New session created, plan + transcript prepended, build mode active
   - Repeat for "Yolo (Clear)"
