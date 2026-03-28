# Task: Add Voice Actions via Text Command Box

## Goal

Add an action-oriented command input to Jean so a user can type natural language like:

- `switch to project Jean`
- `open project settings`
- `create a worktree for Jean`

The system should interpret the text into a structured UI action, validate it, then execute the same internal app behavior the UI already uses.

This task is intentionally scoped to **text input first**. Voice can be added later by feeding speech-to-text output into the same action pipeline.

---

## Core Principle

Do **not** let AI directly manipulate the UI.

Use this flow instead:

```text
Text input -> interpret into structured action -> validate -> execute existing app action
```

This keeps the system deterministic, testable, and safe.

---

## Existing Building Blocks

Jean already has the key pieces needed for this architecture:

- Global project/worktree selection state in `src/store/projects-store.ts`
- Active worktree/session state in `src/store/chat-store.ts`
- Centralized command execution in `src/lib/commands/registry.ts`
- App-wide command actions in `src/hooks/use-command-context.ts`
- Existing "switch project" behavior in:
  - `src/components/command-palette/CommandPalette.tsx`
  - `src/components/projects/ProjectTreeItem.tsx`
- Existing backend structured AI patterns in:
  - `src-tauri/src/chat/commands.rs`
  - `src-tauri/src/projects/commands.rs`

Important current limitation:

- `switch to project X` is not yet a reusable first-class command/action
- It currently exists as dynamic UI logic in the command palette

That should be extracted before adding AI interpretation.

---

## MVP Scope

Start with a text command box and a small set of supported actions:

1. `switch_project`
2. `open_project_settings`
3. `create_worktree`
4. `open_archive`
5. `focus_chat_input`

For the first version:

- Prefer deterministic parsing and fuzzy matching for simple commands
- Use AI only as a fallback when deterministic matching is insufficient
- Require confirmation for destructive actions in later phases

This is enough to prove the architecture without making the system vague or brittle.

---

## Architecture

### 1. Add a Typed UI Action Layer

Create a shared structured action type:

**File:** `src/types/ui-actions.ts`

```typescript
export type UiAction =
  | { type: 'switch_project'; projectId: string }
  | { type: 'open_project_settings'; projectId?: string }
  | { type: 'create_worktree'; projectId?: string }
  | { type: 'open_archive' }
  | { type: 'focus_chat_input' }

export type UiActionIntent =
  | { kind: 'execute'; action: UiAction; confidence: number }
  | {
      kind: 'clarify'
      message: string
      candidates?: { id: string; label: string }[]
    }
  | { kind: 'reject'; message: string }
```

This becomes the contract between interpreter and executor.

### 2. Extract a Reusable UI Action Executor

Create one central executor that performs app actions by calling the same paths the UI already uses.

**New file:** `src/lib/ui-action-executor.ts`

Examples:

```typescript
switch_project -> useChatStore.getState().clearActiveWorktree()
               -> useProjectsStore.getState().selectProject(projectId)

open_project_settings -> useProjectsStore.getState().openProjectSettings(projectId)

open_archive -> useUIStore.getState().setArchivedModalOpen(true)
```

Do not duplicate logic inside the command box component.

### 3. Add a Global Text Command UI

Add a modal or dialog similar to the command palette.

Recommended:

- New component: `src/components/actions/ActionInputDialog.tsx`
- Mount from `src/components/layout/MainWindow.tsx`
- Add a small title bar button and/or keyboard shortcut to open it

The component should:

- accept free text
- submit text for interpretation
- show loading state
- show clarification options if needed
- execute action on success
- show toast/error on failure

### 4. Add an Interpreter Service

Create a frontend service wrapper:

**New file:** `src/services/ui-actions.ts`

```typescript
export async function interpretUiAction(
  input: string,
  context: UiActionContext
) {
  return invoke<UiActionIntent>('interpret_ui_action', { input, context })
}
```

The context should include enough state for resolution:

- project ids and names
- selected project id
- selected worktree id

### 5. Add a Backend Tauri Command for Interpretation

Add a Rust command:

**File:** `src-tauri/src/chat/commands.rs` or a dedicated new module

```rust
#[tauri::command]
pub async fn interpret_ui_action(
    app: AppHandle,
    input: String,
    context: UiActionContext,
) -> Result<UiActionIntent, String>
```

This command should:

1. Try deterministic parsing first
2. If that fails, call the configured model with structured output
3. Return JSON matching the `UiActionIntent` schema

Backend is the right place because Jean already handles structured AI calls there.

### 6. Use Structured Output, Not Free-Form Text

The model should return structured JSON only.

Example:

```json
{
  "kind": "execute",
  "action": {
    "type": "switch_project",
    "projectId": "project-123"
  },
  "confidence": 0.96
}
```

If resolution is ambiguous:

```json
{
  "kind": "clarify",
  "message": "Multiple projects match 'Jean'.",
  "candidates": [
    { "id": "p1", "label": "Jean" },
    { "id": "p2", "label": "Jean Docs" }
  ]
}
```

### 7. Keep Voice Out of Scope for Now

Do not implement TTS.

For later voice support, the pipeline should become:

```text
speech-to-text -> interpret_ui_action -> execute UiAction
```

This allows voice to reuse the same architecture with minimal changes.

---

## Recommended Implementation Phases

### Phase 1: Reusable Action Execution

1. Add `UiAction` types
2. Create `ui-action-executor.ts`
3. Extract current project-switch behavior into executor
4. Refactor command palette dynamic project actions to use the executor

Outcome:

- project switching becomes a reusable app capability

### Phase 2: Text Command Box UI

1. Add `ActionInputDialog.tsx`
2. Mount it in `MainWindow.tsx`
3. Add open/close state to `src/store/ui-store.ts`
4. Add button or shortcut to trigger it

Outcome:

- Jean has a dedicated free-text action input

### Phase 3: Deterministic Interpreter

1. Add a frontend parser for obvious commands:
   - `switch to project <name>`
   - `open project settings`
   - `open archive`
2. Add fuzzy matching over available project names
3. Return `clarify` when multiple matches exist

Outcome:

- basic commands work without AI cost or latency

### Phase 4: AI Fallback Interpreter

1. Add `interpret_ui_action` Tauri command
2. Reuse existing structured-output backend patterns
3. Only invoke AI when deterministic parsing fails
4. Keep the model constrained to supported actions

Outcome:

- broader natural language support without giving up control

### Phase 5: Safety and Expansion

1. Add confirmation flow for destructive actions
2. Add more actions:
   - remove project
   - close worktree
   - open in editor
   - switch worktree
3. Add telemetry/logging for resolved and rejected intents

Outcome:

- system becomes safe and extensible

---

## Files to Add

- `src/types/ui-actions.ts`
- `src/lib/ui-action-executor.ts`
- `src/services/ui-actions.ts`
- `src/components/actions/ActionInputDialog.tsx`

Possible Rust additions:

- `src-tauri/src/ui_actions.rs`

---

## Files to Modify

- `src/components/layout/MainWindow.tsx`
- `src/components/titlebar/TitleBar.tsx`
- `src/components/command-palette/CommandPalette.tsx`
- `src/store/ui-store.ts`
- `src/hooks/use-command-context.ts`
- `src-tauri/src/lib.rs`

Potential backend files depending on placement:

- `src-tauri/src/chat/commands.rs`

---

## Validation Rules

Before executing any interpreted action:

1. Ensure the action type is supported
2. Ensure referenced entities exist
3. If multiple candidates match, return `clarify`
4. If confidence is too low, reject instead of guessing
5. Require explicit confirmation for destructive actions

This prevents the system from behaving unpredictably.

---

## Testing

### Unit Tests

- parser tests for supported phrases
- fuzzy project matching tests
- executor tests for each `UiAction`
- ambiguity tests returning `clarify`
- invalid input tests returning `reject`

### Integration Tests

- entering `switch to project Jean` switches selection to Jean canvas
- entering `open project settings` opens project settings for selected project
- ambiguous project names produce candidate selection UI

---

## Success Criteria

The task is complete when:

1. Jean has a text command box accessible from the UI
2. A typed command like `switch to project Jean` selects the Jean project in the UI
3. The command box executes through a typed `UiAction` layer
4. Existing UI actions are reused instead of duplicated
5. Ambiguous commands are clarified instead of guessed
6. The architecture can later accept speech-to-text input without redesign

---

## Notes

- The later voice feature should use **speech-to-text**, not text-to-speech
- AI should interpret intent, not directly operate the DOM or component tree
- Deterministic matching should handle the simple cases first
