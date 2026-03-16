import type { ThinkingLevel, EffortLevel, ExecutionMode } from './chat'
import { DEFAULT_KEYBINDINGS, type KeybindingsMap } from './keybindings'
import { isMacOS, isWindows } from '../lib/platform'

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
/**
 * Customizable prompts for AI-powered features.
 * null = use current app default (auto-updates on new versions).
 * string = user customization (preserved across updates).
 */
export interface MagicPrompts {
  /** Prompt for investigating GitHub issues */
  investigate_issue: string | null
  /** Prompt for investigating GitHub pull requests */
  investigate_pr: string | null
  /** Prompt for generating PR title/body */
  pr_content: string | null
  /** Prompt for generating commit messages */
  commit_message: string | null
  /** Prompt for AI code review */
  code_review: string | null
  /** Prompt for context summarization */
  context_summary: string | null
  /** Prompt for resolving git conflicts (appended to conflict resolution messages) */
  resolve_conflicts: string | null
  /** Prompt for investigating failed GitHub Actions workflow runs */
  investigate_workflow_run: string | null
  /** Prompt for generating release notes */
  release_notes: string | null
  /** Prompt for generating session names from the first message */
  session_naming: string | null
  /** System prompt for parallel execution (appended to every chat session when enabled) */
  parallel_execution: string | null
  /** Global system prompt appended to every chat session (like ~/.claude/CLAUDE.md) */
  global_system_prompt: string | null
  /** Prompt for generating session recaps (digests) when returning to unfocused sessions */
  session_recap: string | null
  /** Prompt for investigating Dependabot vulnerability alerts */
  investigate_security_alert: string | null
  /** Prompt for investigating repository security advisories */
  investigate_advisory: string | null
  /** Prompt for investigating Linear issues (context embedded in prompt since Claude CLI cannot access Linear API) */
  investigate_linear_issue: string | null
  /** Prompt for addressing inline PR review comments */
  review_comments: string | null
}

/** Default prompt for investigating GitHub issues */
export const DEFAULT_INVESTIGATE_ISSUE_PROMPT = `<task>

Investigate the loaded GitHub {issueWord} ({issueRefs})

</task>


<instructions>

1. Read the issue context file(s) to understand the full problem description and comments
2. Analyze the problem:
   - What is the expected vs actual behavior?
   - Are there error messages, stack traces, or reproduction steps?
3. Explore the codebase to find relevant code:
   - Search for files/functions mentioned in the {issueWord}
   - Read source files to understand current implementation
   - Trace the affected code path
4. Identify root cause:
   - Where does the bug originate OR where should the feature be implemented?
   - What constraints/edge cases need handling?
   - Any related issues or tech debt?
5. Check for regression:
   - If this is a bug fix, determine if this is a regression
   - Look at git history or related code to understand if the feature previously worked
   - Identify what change may have caused the regression
6. Propose solution:
   - Clear explanation of needed changes
   - Specific files to modify
   - Potential risks/trade-offs
   - Test cases to verify

</instructions>


<guidelines>

- Be thorough but focused - investigate deeply without getting sidetracked
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
2. Understand the changes:
   - What is the PR trying to accomplish?
   - What branches are involved (head → base)?
   - Are there any review comments or requested changes?
3. Explore the codebase to understand the context:
   - Check out the PR branch if needed
   - Read the files being modified
   - Understand the current implementation
4. Analyze the approach:
   - Does the implementation match the PR description?
   - Are there any concerns raised in reviews?
   - What feedback has been given?
5. Security review - check the changes for:
   - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
   - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
   - Hardcoded secrets, tokens, API keys, or credentials
   - Backdoors, reverse shells, or unauthorized remote access
   - Unsafe deserialization, command injection, SQL injection, XSS
   - Weakened auth/permissions (removed checks, broadened access, disabled validation)
   - Suspicious file system or environment variable access
6. Identify action items:
   - What changes are requested by reviewers?
   - Are there any failing checks or tests?
   - What needs to be done to get this PR merged?
7. Propose next steps:
   - Address reviewer feedback
   - Specific files to modify
   - Test cases to add or update

</instructions>


<guidelines>

- Be thorough but focused - investigate deeply without getting sidetracked
- Pay attention to reviewer feedback and requested changes
- Flag any security concerns prominently, even minor ones
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

<related_context>
{context}
</related_context>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>`

/** Default prompt for commit message generation */
export const DEFAULT_COMMIT_MESSAGE_PROMPT = `Generate a conventional commit message for these staged changes.

Files changed:
{diff_stat}

Git status:
{status}

Diff:
{diff}

Recent commits (style reference):
{recent_commits}`

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
- Security & supply-chain risks:
  - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
  - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
  - Hardcoded secrets, tokens, API keys, or credentials
  - Backdoors, reverse shells, or unauthorized remote access
  - Unsafe deserialization, command injection, SQL injection, XSS
  - Weakened auth/permissions (removed checks, broadened access, disabled validation)
  - Suspicious file system or environment variable access
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

/** Default prompt for investigating failed workflow runs */
export const DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT = `<task>

Investigate the failed GitHub Actions workflow run for "{workflowName}" on branch \`{branch}\`

</task>


<context>

- Workflow: {workflowName}
- Commit/PR: {displayTitle}
- Branch: {branch}
- Run URL: {runUrl}

</context>


<instructions>

1. Use the GitHub CLI to fetch the workflow run logs: \`gh run view {runId} --log-failed\`
2. Read the error output carefully to identify the failure cause
3. Explore the relevant code in the codebase to understand the context
4. Determine if this is a code issue, configuration issue, or flaky test
5. Propose a fix with specific files and changes needed

</instructions>


<guidelines>

- Be thorough but focused on the failure
- If the error is in CI config (.github/workflows), explain the fix
- If the error is in code, reference specific file paths and line numbers
- If it's a flaky test, suggest how to make it more reliable

</guidelines>`

/** Default prompt for investigating Dependabot vulnerability alerts */
export const DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT = `<task>

Investigate the loaded Dependabot {alertWord} ({alertRefs})

</task>


<instructions>

1. Read the security alert context file(s) for vulnerability details (CVE, GHSA, severity, affected versions)
2. Identify the affected dependency and vulnerable version range
3. Search the codebase for usage of the affected package:
   - Find import/require statements and lock file entries
   - Identify which features/APIs of the package are used
   - Check if the vulnerable code path is actually exercised
4. Assess actual impact:
   - Is the vulnerable function/API used in this project?
   - Is it reachable from user input or external data?
   - What is the blast radius if exploited?
5. Evaluate remediation options:
   - Is a patched version available? What breaking changes does it introduce?
   - Can the vulnerable code path be mitigated without upgrading?
   - Are there workarounds or configuration changes?
6. Propose fix:
   - Specific version bump or dependency change
   - Any code changes needed for compatibility
   - Test cases to verify the fix doesn't break functionality

</instructions>


<guidelines>

- Focus on whether the vulnerability is actually exploitable in this codebase
- Don't just recommend "upgrade" — assess compatibility impact
- Reference specific file paths where the affected package is used
- If multiple alerts are loaded, address each one separately

</guidelines>`

/** Default prompt for investigating repository security advisories */
export const DEFAULT_INVESTIGATE_ADVISORY_PROMPT = `<task>

Investigate the loaded security {advisoryWord} ({advisoryRefs})

</task>


<instructions>

1. Read the advisory context file(s) for full vulnerability details (GHSA ID, CVE, severity, affected versions, CWE)
2. Understand the vulnerability:
   - What type of vulnerability is it (injection, auth bypass, XSS, etc.)?
   - What are the preconditions for exploitation?
   - What is the severity and potential impact?
3. Locate the vulnerable code:
   - Search for the affected components, endpoints, or functions
   - Trace the vulnerable code path from entry point to impact
   - Identify all locations where the same pattern exists
4. Develop a fix:
   - Address the root cause, not just the symptom
   - Ensure the fix covers all affected code paths
   - Consider edge cases and bypass attempts
5. Verify completeness:
   - Are there similar patterns elsewhere that need the same fix?
   - Does the fix introduce any regressions?
   - What test cases would prove the vulnerability is resolved?
6. Document:
   - Summarize the vulnerability and fix for the advisory
   - Note any affected versions and migration steps

</instructions>


<guidelines>

- Think like an attacker — consider bypass attempts for any proposed fix
- Check for the same vulnerability pattern across the entire codebase, not just the reported location
- Reference specific file paths and line numbers
- If multiple advisories are loaded, address each one separately

</guidelines>`

/** Default prompt for investigating Linear issues */
export const DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT = `<task>

Investigate the loaded Linear {linearWord} ({linearRefs})

</task>


<linear_issue_context>

{linearContext}

</linear_issue_context>


<instructions>

1. Read the Linear issue context above carefully to understand the full problem description and comments
2. Analyze the problem:
   - What is the expected vs actual behavior?
   - Are there error messages, stack traces, or reproduction steps?
3. Explore the codebase to find relevant code:
   - Search for files/functions mentioned in the {linearWord}
   - Read source files to understand current implementation
   - Trace the affected code path
4. Identify root cause:
   - Where does the bug originate OR where should the feature be implemented?
   - What constraints/edge cases need handling?
   - Any related issues or tech debt?
5. Check for regression:
   - If this is a bug fix, determine if this is a regression
   - Look at git history or related code to understand if the feature previously worked
   - Identify what change may have caused the regression
6. Propose solution:
   - Clear explanation of needed changes
   - Specific files to modify
   - Potential risks/trade-offs
   - Test cases to verify

</instructions>


<guidelines>

- The Linear issue content is included above — use it as the primary source of requirements
- Be thorough but focused - investigate deeply without getting sidetracked
- Ask clarifying questions if requirements are unclear
- If multiple solutions exist, explain trade-offs
- Reference specific file paths and line numbers

</guidelines>`

/** Default prompt for generating release notes */
export const DEFAULT_RELEASE_NOTES_PROMPT = `Generate release notes for changes since the \`{tag}\` release ({previous_release_name}).

## Commits since {tag}

{commits}

## Instructions

- Write a concise release title
- Group changes into categories: Features, Fixes, Improvements, Breaking Changes (only include categories that have entries)
- Use bullet points with brief descriptions
- Reference PR numbers if visible in commit messages
- Skip merge commits and trivial changes (typos, formatting)
- Write in past tense ("Added", "Fixed", "Improved")
- Keep it concise and user-facing (skip internal implementation details)`

/** Default prompt for generating session names */
export const DEFAULT_SESSION_NAMING_PROMPT = `<task>Generate a short, human-friendly name for this chat session based on the user's request.</task>

<rules>
- Maximum 4-5 words total
- Use sentence case (only capitalize first word)
- Be descriptive but concise
- Focus on the main topic or goal
- No special characters or punctuation
- No generic names like "Chat session" or "New task"
- Do NOT use commit-style prefixes like "Add", "Fix", "Update", "Refactor"
</rules>

<user_request>
{message}
</user_request>

<output_format>
Respond with ONLY the raw JSON object, no markdown, no code fences, no explanation:
{"session_name": "Your session name here"}
</output_format>`

export const DEFAULT_GLOBAL_SYSTEM_PROMPT = `### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity
- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

### 2. Subagent Strategy to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update '.ai/lessons.md' with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests -> then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management
1. **Plan First**: Write plan to '.ai/todo.md' with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review to '.ai/todo.md'
6. **Capture Lessons**: Update '.ai/lessons.md' after corrections

## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Important!

- After each finished task, please write a few bullet points on how to test the changes.`

export const DEFAULT_PARALLEL_EXECUTION_PROMPT = `In plan mode, structure plans so subagents can work simultaneously. In build/execute mode, use subagents in parallel for faster implementation.

When launching multiple Task subagents, prefer sending them in a single message rather than sequentially. Group independent work items (e.g., editing separate files, researching unrelated questions) into parallel Task calls. Only sequence Tasks when one depends on another's output.

Instruct each sub-agent to briefly outline its approach before implementing, so it can course-correct early without formal plan mode overhead.`

/** Default prompt for session recap (digest) generation */
export const DEFAULT_SESSION_RECAP_PROMPT = `You are a summarization assistant. Your ONLY job is to summarize the following conversation transcript. Do NOT continue the conversation or take any actions. Just summarize.

CONVERSATION TRANSCRIPT:
{conversation}

END OF TRANSCRIPT.

Now provide a brief summary with exactly two fields:
- chat_summary: One sentence (max 100 chars) describing the overall goal and current status
- last_action: One sentence (max 200 chars) describing what was just completed in the last exchange`

/** Default prompt for addressing inline PR review comments */
export const DEFAULT_REVIEW_COMMENTS_PROMPT = `<task>

Address the following review comments from PR #{prNumber}

</task>


<review_comments>
{reviewComments}
</review_comments>


<instructions>

1. Read each review comment carefully, noting the file path, line numbers, and diff context
2. Understand what the reviewer is asking for in each comment
3. Make the requested changes to address each comment
4. If a comment is unclear or you disagree with it, explain your reasoning
5. After making changes, briefly summarize what you changed for each comment

</instructions>


<guidelines>

- Be thorough but focused — address exactly what was requested
- If a comment requires a larger refactor, explain the scope before proceeding
- Run tests after making changes to ensure nothing is broken

</guidelines>`

/** Default values for all magic prompts (null = use current app default) */
export const DEFAULT_MAGIC_PROMPTS: MagicPrompts = {
  investigate_issue: null,
  investigate_pr: null,
  pr_content: null,
  commit_message: null,
  code_review: null,
  context_summary: null,
  resolve_conflicts: null,
  investigate_workflow_run: null,
  release_notes: null,
  session_naming: null,
  parallel_execution: null,
  global_system_prompt: null,
  session_recap: null,
  investigate_security_alert: null,
  investigate_advisory: null,
  investigate_linear_issue: null,
  review_comments: null,
}

/**
 * Per-prompt model overrides. Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPromptModels {
  investigate_issue_model: MagicPromptModel
  investigate_pr_model: MagicPromptModel
  investigate_workflow_run_model: MagicPromptModel
  pr_content_model: MagicPromptModel
  commit_message_model: MagicPromptModel
  code_review_model: MagicPromptModel
  context_summary_model: MagicPromptModel
  resolve_conflicts_model: MagicPromptModel
  release_notes_model: MagicPromptModel
  session_naming_model: MagicPromptModel
  session_recap_model: MagicPromptModel
  investigate_security_alert_model: MagicPromptModel
  investigate_advisory_model: MagicPromptModel
  investigate_linear_issue_model: MagicPromptModel
  review_comments_model: MagicPromptModel
}

/**
 * Per-prompt reasoning effort overrides. null = use model default (no reasoning effort flag).
 * Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPromptReasoningEfforts {
  investigate_issue_effort: MagicPromptReasoningEffort
  investigate_pr_effort: MagicPromptReasoningEffort
  investigate_workflow_run_effort: MagicPromptReasoningEffort
  pr_content_effort: MagicPromptReasoningEffort
  commit_message_effort: MagicPromptReasoningEffort
  code_review_effort: MagicPromptReasoningEffort
  context_summary_effort: MagicPromptReasoningEffort
  resolve_conflicts_effort: MagicPromptReasoningEffort
  release_notes_effort: MagicPromptReasoningEffort
  session_naming_effort: MagicPromptReasoningEffort
  session_recap_effort: MagicPromptReasoningEffort
  investigate_security_alert_effort: MagicPromptReasoningEffort
  investigate_advisory_effort: MagicPromptReasoningEffort
  investigate_linear_issue_effort: MagicPromptReasoningEffort
  review_comments_effort: MagicPromptReasoningEffort
}

/** Default models for each magic prompt */
export const DEFAULT_MAGIC_PROMPT_MODELS: MagicPromptModels = {
  investigate_issue_model: 'opus',
  investigate_pr_model: 'opus',
  investigate_workflow_run_model: 'opus',
  pr_content_model: 'haiku',
  commit_message_model: 'haiku',
  code_review_model: 'opus',
  context_summary_model: 'opus',
  resolve_conflicts_model: 'opus',
  release_notes_model: 'haiku',
  session_naming_model: 'haiku',
  session_recap_model: 'haiku',
  investigate_security_alert_model: 'opus',
  investigate_advisory_model: 'opus',
  investigate_linear_issue_model: 'opus',
  review_comments_model: 'opus',
}

/** Codex preset: heavy tasks use top model, light tasks use mini */
export const CODEX_DEFAULT_MAGIC_PROMPT_MODELS: MagicPromptModels = {
  investigate_issue_model: 'gpt-5.4',
  investigate_pr_model: 'gpt-5.4',
  investigate_workflow_run_model: 'gpt-5.4',
  pr_content_model: 'gpt-5.3-codex',
  commit_message_model: 'gpt-5.3-codex',
  code_review_model: 'gpt-5.4',
  context_summary_model: 'gpt-5.4',
  resolve_conflicts_model: 'gpt-5.4',
  release_notes_model: 'gpt-5.3-codex',
  session_naming_model: 'gpt-5.3-codex',
  session_recap_model: 'gpt-5.3-codex',
  investigate_security_alert_model: 'gpt-5.4',
  investigate_advisory_model: 'gpt-5.4',
  investigate_linear_issue_model: 'gpt-5.4',
  review_comments_model: 'gpt-5.4',
}

/** OpenCode preset for all magic prompts */
export const OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS: MagicPromptModels = {
  investigate_issue_model: 'opencode/gpt-5.3-codex',
  investigate_pr_model: 'opencode/gpt-5.3-codex',
  investigate_workflow_run_model: 'opencode/gpt-5.3-codex',
  pr_content_model: 'opencode/gpt-5.3-codex',
  commit_message_model: 'opencode/gpt-5.3-codex',
  code_review_model: 'opencode/gpt-5.3-codex',
  context_summary_model: 'opencode/gpt-5.3-codex',
  resolve_conflicts_model: 'opencode/gpt-5.3-codex',
  release_notes_model: 'opencode/gpt-5.3-codex',
  session_naming_model: 'opencode/gpt-5.3-codex',
  session_recap_model: 'opencode/gpt-5.3-codex',
  investigate_security_alert_model: 'opencode/gpt-5.3-codex',
  investigate_advisory_model: 'opencode/gpt-5.3-codex',
  investigate_linear_issue_model: 'opencode/gpt-5.3-codex',
  review_comments_model: 'opencode/gpt-5.3-codex',
}

/** Default reasoning efforts for Claude backend (null = use model default) */
export const DEFAULT_MAGIC_PROMPT_EFFORTS: MagicPromptReasoningEfforts = {
  investigate_issue_effort: null,
  investigate_pr_effort: null,
  investigate_workflow_run_effort: null,
  pr_content_effort: null,
  commit_message_effort: null,
  code_review_effort: null,
  context_summary_effort: null,
  resolve_conflicts_effort: null,
  release_notes_effort: null,
  session_naming_effort: null,
  session_recap_effort: null,
  investigate_security_alert_effort: null,
  investigate_advisory_effort: null,
  investigate_linear_issue_effort: null,
  review_comments_effort: null,
}

/** Codex preset: heavier reasoning for investigations, lighter for simple generation */
export const CODEX_DEFAULT_MAGIC_PROMPT_EFFORTS: MagicPromptReasoningEfforts = {
  investigate_issue_effort: 'medium',
  investigate_pr_effort: 'medium',
  investigate_workflow_run_effort: 'medium',
  pr_content_effort: 'low',
  commit_message_effort: 'low',
  code_review_effort: 'medium',
  context_summary_effort: 'medium',
  resolve_conflicts_effort: 'medium',
  release_notes_effort: 'low',
  session_naming_effort: 'low',
  session_recap_effort: 'low',
  investigate_security_alert_effort: 'medium',
  investigate_advisory_effort: 'medium',
  investigate_linear_issue_effort: 'medium',
  review_comments_effort: 'medium',
}

/** OpenCode preset: same as Codex */
export const OPENCODE_DEFAULT_MAGIC_PROMPT_EFFORTS: MagicPromptReasoningEfforts = {
  ...CODEX_DEFAULT_MAGIC_PROMPT_EFFORTS,
}

/**
 * Per-prompt provider overrides. null = use global default_provider.
 * Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPromptProviders {
  investigate_issue_provider: string | null
  investigate_pr_provider: string | null
  investigate_workflow_run_provider: string | null
  pr_content_provider: string | null
  commit_message_provider: string | null
  code_review_provider: string | null
  context_summary_provider: string | null
  resolve_conflicts_provider: string | null
  release_notes_provider: string | null
  session_naming_provider: string | null
  session_recap_provider: string | null
  investigate_security_alert_provider: string | null
  investigate_advisory_provider: string | null
  investigate_linear_issue_provider: string | null
  review_comments_provider: string | null
}

/** Default providers for each magic prompt (null = use global default_provider) */
export const DEFAULT_MAGIC_PROMPT_PROVIDERS: MagicPromptProviders = {
  investigate_issue_provider: null,
  investigate_pr_provider: null,
  investigate_workflow_run_provider: null,
  pr_content_provider: null,
  commit_message_provider: null,
  code_review_provider: null,
  context_summary_provider: null,
  resolve_conflicts_provider: null,
  release_notes_provider: null,
  session_naming_provider: null,
  session_recap_provider: null,
  investigate_security_alert_provider: null,
  investigate_advisory_provider: null,
  investigate_linear_issue_provider: null,
  review_comments_provider: null,
}

/**
 * Per-prompt backend overrides for magic prompts.
 * null = use project/global default_backend.
 * Field names use snake_case to match Rust struct exactly.
 */
export interface MagicPromptBackends {
  investigate_issue_backend: string | null
  investigate_pr_backend: string | null
  investigate_workflow_run_backend: string | null
  pr_content_backend: string | null
  commit_message_backend: string | null
  code_review_backend: string | null
  context_summary_backend: string | null
  resolve_conflicts_backend: string | null
  release_notes_backend: string | null
  session_naming_backend: string | null
  session_recap_backend: string | null
  investigate_security_alert_backend: string | null
  investigate_advisory_backend: string | null
  investigate_linear_issue_backend: string | null
  review_comments_backend: string | null
}

/** Default backends for each magic prompt (null = use project/global default_backend) */
export const DEFAULT_MAGIC_PROMPT_BACKENDS: MagicPromptBackends = {
  investigate_issue_backend: null,
  investigate_pr_backend: null,
  investigate_workflow_run_backend: null,
  pr_content_backend: null,
  commit_message_backend: null,
  code_review_backend: null,
  context_summary_backend: null,
  resolve_conflicts_backend: null,
  release_notes_backend: null,
  session_naming_backend: null,
  session_recap_backend: null,
  investigate_security_alert_backend: null,
  investigate_advisory_backend: null,
  investigate_linear_issue_backend: null,
  review_comments_backend: null,
}

function makeBackendsPreset(backend: string): MagicPromptBackends {
  return {
    investigate_issue_backend: backend,
    investigate_pr_backend: backend,
    investigate_workflow_run_backend: backend,
    pr_content_backend: backend,
    commit_message_backend: backend,
    code_review_backend: backend,
    context_summary_backend: backend,
    resolve_conflicts_backend: backend,
    release_notes_backend: backend,
    session_naming_backend: backend,
    session_recap_backend: backend,
    investigate_security_alert_backend: backend,
    investigate_advisory_backend: backend,
    investigate_linear_issue_backend: backend,
    review_comments_backend: backend,
  }
}

export const CLAUDE_DEFAULT_MAGIC_PROMPT_BACKENDS =
  makeBackendsPreset('claude')
export const CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS = makeBackendsPreset('codex')
export const OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS =
  makeBackendsPreset('opencode')

/**
 * Resolve a magic prompt provider for a given key.
 * The settings UI stores null = "Anthropic" (explicit choice).
 * When the key is missing from saved prefs (undefined), we fall back to
 * DEFAULT_MAGIC_PROMPT_PROVIDERS (which defaults to null = Anthropic),
 * NOT to the global default_provider.
 *
 * Only uses global default_provider when DEFAULT_MAGIC_PROMPT_PROVIDERS
 * also doesn't have a value (which shouldn't happen for known keys).
 */
export function resolveMagicPromptProvider(
  providers: MagicPromptProviders | undefined,
  key: keyof MagicPromptProviders,
  globalDefaultProvider: string | null | undefined
): string | null {
  const merged = { ...DEFAULT_MAGIC_PROMPT_PROVIDERS, ...providers }
  const value = merged[key]
  // null = explicitly Anthropic, string = custom provider
  // Only fall back to global default if the merged value is somehow undefined
  return value !== undefined ? value : (globalDefaultProvider ?? null)
}

// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
// Note: Field names use snake_case to match Rust struct exactly
export interface AppPreferences {
  theme: string
  selected_model: ClaudeModel // Claude model ID passed to --model flag
  thinking_level: ThinkingLevel // Thinking level: 'off' | 'think' | 'megathink' | 'ultrathink'
  default_effort_level: EffortLevel // Effort level for Opus 4.6 adaptive thinking: 'low' | 'medium' | 'high' | 'max'
  terminal: TerminalApp // Terminal app: 'terminal' | 'warp' | 'ghostty' | 'iterm2' | 'powershell' | 'windows-terminal'
  editor: EditorApp // Editor app: 'zed' | 'vscode' | 'cursor' | 'xcode'
  open_in: OpenInDefault // Default Open In action: 'editor' | 'terminal' | 'finder' | 'github'
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
  syntax_theme_dark: SyntaxTheme // Syntax highlighting theme for dark mode
  syntax_theme_light: SyntaxTheme // Syntax highlighting theme for light mode
  session_recap_enabled: boolean // Show session recap when returning to unfocused sessions
  parallel_execution_prompt_enabled: boolean // Add system prompt to encourage parallel sub-agent execution
  magic_prompts: MagicPrompts // Customizable prompts for AI-powered features
  magic_prompt_models: MagicPromptModels // Per-prompt model overrides
  magic_prompt_providers: MagicPromptProviders // Per-prompt provider overrides (null = use default_provider)
  magic_prompt_backends: MagicPromptBackends // Per-prompt backend overrides (null = use project/global default_backend)
  magic_prompt_efforts: MagicPromptReasoningEfforts // Per-prompt reasoning effort overrides (null = model default)
  file_edit_mode: FileEditMode // How to edit files: inline (CodeMirror) or external (VS Code, etc.)
  ai_language: string // Preferred language for AI responses (empty = default)
  allow_web_tools_in_plan_mode: boolean // Allow WebFetch/WebSearch in plan mode without prompts
  waiting_sound: NotificationSound // Sound when session is waiting for input
  review_sound: NotificationSound // Sound when session finishes reviewing
  http_server_enabled: boolean // Whether HTTP server is enabled
  http_server_port: number // HTTP server port (default 3456)
  http_server_token: string | null // Auth token for HTTP/WS access
  http_server_auto_start: boolean // Auto-start HTTP server on launch
  http_server_localhost_only: boolean // Bind to localhost only (more secure)
  http_server_token_required: boolean // Require token for web access (default true)
  removal_behavior: RemovalBehavior // What happens when closing sessions/worktrees: 'archive' or 'delete'
  auto_pull_base_branch: boolean // Auto-pull base branch before creating a new worktree
  auto_archive_on_pr_merged: boolean // Auto-archive worktrees when their PR is merged
  debug_mode_enabled: boolean // Show debug panel in chat sessions
  default_enabled_mcp_servers: string[] // MCP server names enabled by default (empty = none)
  known_mcp_servers: string[] // All MCP server names ever seen (prevents re-enabling user-disabled servers)
  has_seen_feature_tour: boolean // Whether user has seen the feature tour onboarding
  has_seen_jean_config_wizard: boolean // Whether user has seen the jean.json setup wizard
  chrome_enabled: boolean // Enable browser automation via Chrome extension
  zoom_level: number // Zoom level percentage (50-200, default 100)
  custom_cli_profiles: CustomCliProfile[] // Custom CLI settings profiles (e.g., OpenRouter, MiniMax)
  default_provider: string | null // Default provider profile name (null = Anthropic direct)

  confirm_session_close: boolean // Show confirmation dialog before closing sessions/worktrees
  default_execution_mode: ExecutionMode // Default execution mode for new sessions: 'plan', 'build', or 'yolo'
  default_backend: CliBackend // Default CLI backend for new sessions: 'claude', 'codex', or 'opencode'
  selected_codex_model: CodexModel // Default Codex model
  selected_opencode_model: string // Default OpenCode model (provider/model)
  default_codex_reasoning_effort: CodexReasoningEffort // Default reasoning effort for Codex: 'low' | 'medium' | 'high' | 'xhigh'
  codex_multi_agent_enabled: boolean // Enable Codex multi-agent collaboration (experimental)
  codex_max_agent_threads: number // Max concurrent agent threads (1-8) when multi-agent is enabled
  restore_last_session: boolean // Restore last session when switching projects (default: false)
  close_original_on_clear_context: boolean // Close original session when using Clear Context and yolo (default: true)
  build_model: string | null // Model override for plan approval (build mode), null = use session model
  yolo_model: string | null // Model override for yolo plan approval, null = use session model
  build_backend: string | null // Backend override for plan approval (build mode), null = use session backend
  yolo_backend: string | null // Backend override for yolo plan approval, null = use session backend
  build_thinking_level: string | null // Thinking level override for build mode, null = use session thinking level
  yolo_thinking_level: string | null // Thinking level override for yolo mode, null = use session thinking level
  linear_api_key: string | null // Global Linear personal API key (inherited by all projects)
  magic_models_auto_initialized: boolean // Whether magic prompt models were auto-set based on installed backends
}

export interface CustomCliProfile {
  name: string // Display name, e.g. "OpenRouter"
  settings_json: string // JSON string matching Claude CLI settings format (with env block)
  file_path?: string // Path to settings file on disk (e.g. ~/.claude/settings.jean.openrouter.json)
  supports_thinking?: boolean // Whether this provider supports thinking/effort levels (default: true)
}

export const PREDEFINED_CLI_PROFILES: CustomCliProfile[] = [
  {
    name: 'OpenRouter',
    settings_json: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '<your_api_key>',
        },
      },
      null,
      2
    ),
  },
  {
    name: 'MiniMax',
    supports_thinking: false,
    settings_json: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: '<your-minimax-api-key>',
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_MODEL: 'MiniMax-M2.5',
          ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M2.5',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.5',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.5',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.5',
        },
      },
      null,
      2
    ),
  },
  {
    name: 'Z.ai',
    supports_thinking: false,
    settings_json: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
          ANTHROPIC_AUTH_TOKEN: '<your-zai-api-key>',
          API_TIMEOUT_MS: '3000000',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
        },
      },
      null,
      2
    ),
  },
  {
    name: 'Moonshot',
    supports_thinking: false,
    settings_json: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
          ANTHROPIC_AUTH_TOKEN: '<your-moonshot-api-key>',
          ANTHROPIC_MODEL: 'kimi-k2.5',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.5',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.5',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.5',
        },
      },
      null,
      2
    ),
  },
]

export type FileEditMode = 'inline' | 'external'

export const fileEditModeOptions: { value: FileEditMode; label: string }[] = [
  { value: 'inline', label: 'Jean (inline editor)' },
  { value: 'external', label: 'External editor' },
]

export type ClaudeModel =
  | 'opus'
  | 'claude-opus-4-6[1m]'
  | 'opus-4.5'
  | 'sonnet'
  | 'claude-sonnet-4-6[1m]'
  | 'sonnet-4.5'
  | 'haiku'

export const modelOptions: { value: ClaudeModel; label: string }[] = [
  { value: 'opus', label: 'Claude Opus 4.6' },
  { value: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6 (1M)' },
  { value: 'opus-4.5', label: 'Claude Opus 4.5' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'claude-sonnet-4-6[1m]', label: 'Claude Sonnet 4.6 (1M)' },
  { value: 'sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { value: 'haiku', label: 'Claude Haiku' },
]

export const thinkingLevelOptions: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'think', label: 'Think (4K)' },
  { value: 'megathink', label: 'Megathink (10K)' },
  { value: 'ultrathink', label: 'Ultrathink (32K)' },
]

export const effortLevelOptions: {
  value: EffortLevel
  label: string
  description: string
}[] = [
  { value: 'low', label: 'Low', description: 'Minimal thinking' },
  { value: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { value: 'high', label: 'High', description: 'Deep reasoning' },
  { value: 'max', label: 'Max', description: 'No limits' },
]

// =============================================================================
// Codex Types
// =============================================================================

export type CodexModel =
  | 'gpt-5.4'
  | 'gpt-5.4-fast'
  | 'gpt-5.3'
  | 'gpt-5.3-codex'
  | 'gpt-5.2-codex'
  | 'gpt-5.1-codex-max'
  | 'gpt-5.2'
  | 'gpt-5.1-codex-mini'

export const codexModelOptions: { value: CodexModel; label: string }[] = [
  { value: 'gpt-5.4', label: 'GPT 5.4' },
  { value: 'gpt-5.4-fast', label: 'GPT 5.4 - Fast' },
  { value: 'gpt-5.3', label: 'GPT 5.3' },
  { value: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' },
  { value: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' },
  { value: 'gpt-5.1-codex-max', label: 'GPT 5.1 Codex Max' },
  { value: 'gpt-5.2', label: 'GPT 5.2' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT 5.1 Codex Mini' },
]

const deprecatedCodexFastModelMap = {
  'gpt-5.3-fast': 'gpt-5.3',
  'gpt-5.3-codex-fast': 'gpt-5.3-codex',
  'gpt-5.2-codex-fast': 'gpt-5.2-codex',
  'gpt-5.1-codex-max-fast': 'gpt-5.1-codex-max',
  'gpt-5.2-fast': 'gpt-5.2',
  'gpt-5.1-codex-mini-fast': 'gpt-5.1-codex-mini',
} as const

export function normalizeCodexModel(model: string): CodexModel {
  if (model in deprecatedCodexFastModelMap) {
    return deprecatedCodexFastModelMap[
      model as keyof typeof deprecatedCodexFastModelMap
    ]
  }

  return isCodexModel(model) ? model : 'gpt-5.4'
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type MagicPromptReasoningEffort = 'low' | 'medium' | 'high' | null

// =============================================================================
// Magic Prompt Model (unified type for both Claude and Codex)
// =============================================================================

export type OpenCodeModel = `opencode/${string}`
export type MagicPromptModel = ClaudeModel | CodexModel | OpenCodeModel

/** Check if a model string identifies an OpenCode model */
export function isOpenCodeModel(model: string): model is OpenCodeModel {
  return model.startsWith('opencode/')
}

/** Check if a model string identifies a Codex model */
export function isCodexModel(model: string): model is CodexModel {
  return (codexModelOptions as { value: string }[]).some(
    opt => opt.value === model
  )
}

export const codexReasoningOptions: {
  value: CodexReasoningEffort
  label: string
}[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
]

// =============================================================================
// CLI Backend
// =============================================================================

export type CliBackend = 'claude' | 'codex' | 'opencode'

export const backendOptions: { value: CliBackend; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
]


export type TerminalApp =
  | 'terminal'
  | 'warp'
  | 'ghostty'
  | 'iterm2'
  | 'powershell'
  | 'windows-terminal'

type Platform = 'mac' | 'windows' | 'linux'

function getCurrentPlatform(): Platform {
  if (isMacOS) return 'mac'
  if (isWindows) return 'windows'
  return 'linux'
}

const allTerminalOptions: {
  value: TerminalApp
  label: string
  platforms: Platform[]
}[] = [
  { value: 'terminal', label: 'Terminal', platforms: ['mac', 'linux'] },
  { value: 'warp', label: 'Warp', platforms: ['mac', 'windows'] },
  { value: 'ghostty', label: 'Ghostty', platforms: ['mac', 'linux'] },
  { value: 'iterm2', label: 'iTerm2', platforms: ['mac'] },
  { value: 'powershell', label: 'PowerShell', platforms: ['windows'] },
  {
    value: 'windows-terminal',
    label: 'Windows Terminal',
    platforms: ['windows'],
  },
]

export const terminalOptions: { value: TerminalApp; label: string }[] =
  allTerminalOptions.filter(opt => opt.platforms.includes(getCurrentPlatform()))

export type EditorApp = 'zed' | 'vscode' | 'cursor' | 'xcode'

const allEditorOptions: {
  value: EditorApp
  label: string
  platforms: Platform[]
}[] = [
  { value: 'zed', label: 'Zed', platforms: ['mac', 'windows', 'linux'] },
  {
    value: 'vscode',
    label: 'VS Code',
    platforms: ['mac', 'windows', 'linux'],
  },
  {
    value: 'cursor',
    label: 'Cursor',
    platforms: ['mac', 'windows', 'linux'],
  },
  { value: 'xcode', label: 'Xcode', platforms: ['mac'] },
]

export const editorOptions: { value: EditorApp; label: string }[] =
  allEditorOptions.filter(opt => opt.platforms.includes(getCurrentPlatform()))

export type OpenInDefault = 'editor' | 'terminal' | 'finder' | 'github'

export const openInDefaultOptions: { value: OpenInDefault; label: string }[] = [
  { value: 'editor', label: 'Editor' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'finder', label: 'Finder' },
  { value: 'github', label: 'GitHub' },
]

export function getOpenInDefaultLabel(
  openIn: OpenInDefault | undefined,
  editor: EditorApp | undefined,
  terminal: TerminalApp | undefined
): string {
  switch (openIn) {
    case 'editor':
      return getEditorLabel(editor)
    case 'terminal':
      return getTerminalLabel(terminal)
    case 'finder':
      return 'Finder'
    case 'github':
      return 'GitHub'
    default:
      return getEditorLabel(editor)
  }
}

// Font size is now a pixel value
export type FontSize = number

export const FONT_SIZE_DEFAULT = 16
export const ZOOM_LEVEL_DEFAULT = 90

export const uiFontScaleTicks = [
  { value: 12, label: '12px' },
  { value: 14, label: '14px' },
  { value: 15, label: '15px' },
  { value: 16, label: '16px' },
  { value: 18, label: '18px' },
  { value: 20, label: '20px' },
  { value: 24, label: '24px' },
]

export const chatFontScaleTicks = [
  { value: 12, label: '12px' },
  { value: 14, label: '14px' },
  { value: 15, label: '15px' },
  { value: 16, label: '16px' },
  { value: 18, label: '18px' },
  { value: 20, label: '20px' },
  { value: 24, label: '24px' },
]

export const zoomLevelTicks = [
  { value: 50, label: '50' },
  { value: 67, label: '67' },
  { value: 75, label: '75' },
  { value: 80, label: '80' },
  { value: 90, label: '90' },
  { value: 100, label: '100' },
  { value: 110, label: '110' },
  { value: 125, label: '125' },
  { value: 150, label: '150' },
  { value: 175, label: '175' },
  { value: 200, label: '200' },
]

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

// Removal behavior options - what happens when closing sessions/worktrees
export type RemovalBehavior = 'archive' | 'delete'

export const removalBehaviorOptions: {
  value: RemovalBehavior
  label: string
  description: string
}[] = [
  {
    value: 'archive',
    label: 'Archive',
    description: 'Soft-delete; can be restored later',
  },
  {
    value: 'delete',
    label: 'Delete',
    description: 'Permanently delete; cannot be undone',
  },
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
  // Search all options (not just platform-filtered) so saved cross-platform values resolve
  const option = allTerminalOptions.find(opt => opt.value === terminal)
  return option?.label ?? 'Terminal'
}

export function getEditorLabel(editor: EditorApp | undefined): string {
  // Search all options (not just platform-filtered) so saved cross-platform values resolve
  const option = allEditorOptions.find(opt => opt.value === editor)
  return option?.label ?? 'Editor'
}

export const defaultPreferences: AppPreferences = {
  theme: 'system',
  selected_model: 'opus',
  thinking_level: 'ultrathink',
  default_effort_level: 'high',
  terminal: isWindows ? 'powershell' : 'terminal',
  editor: 'zed',
  open_in: 'editor',
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
  archive_retention_days: 7,
  syntax_theme_dark: 'vitesse-black',
  syntax_theme_light: 'github-light',
  session_recap_enabled: false, // Default: disabled (experimental)
  parallel_execution_prompt_enabled: false, // Default: disabled (experimental)
  magic_prompts: DEFAULT_MAGIC_PROMPTS,
  magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
  magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
  magic_prompt_backends: DEFAULT_MAGIC_PROMPT_BACKENDS,
  magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
  file_edit_mode: 'external',
  ai_language: '', // Default: empty (Claude's default behavior)
  allow_web_tools_in_plan_mode: true, // Default: enabled
  waiting_sound: 'none',
  review_sound: 'none',
  http_server_enabled: false,
  http_server_port: 3456,
  http_server_token: null,
  http_server_auto_start: false,
  http_server_localhost_only: true, // Default to localhost-only for security
  http_server_token_required: true, // Default: require token for security
  removal_behavior: 'delete', // Default: delete (permanent)
  auto_pull_base_branch: true, // Default: enabled
  auto_archive_on_pr_merged: true, // Default: enabled
  debug_mode_enabled: false, // Default: disabled
  default_enabled_mcp_servers: [], // Default: no MCP servers enabled
  known_mcp_servers: [], // Default: no known servers
  has_seen_feature_tour: false, // Default: not seen
  has_seen_jean_config_wizard: false, // Default: not seen
  chrome_enabled: true, // Default: enabled
  zoom_level: ZOOM_LEVEL_DEFAULT,
  custom_cli_profiles: [],
  default_provider: null,
  confirm_session_close: true, // Default: enabled (show confirmation)
  default_execution_mode: 'plan', // Default: plan mode
  default_backend: 'claude', // Default: Claude
  selected_codex_model: 'gpt-5.4', // Default: latest Codex model
  selected_opencode_model: 'opencode/gpt-5.3-codex', // Default OpenCode model
  default_codex_reasoning_effort: 'high', // Default: high reasoning
  codex_multi_agent_enabled: false, // Default: disabled
  codex_max_agent_threads: 3, // Default: 3 threads
  restore_last_session: false, // Default: disabled
  close_original_on_clear_context: true, // Default: enabled
  build_model: null, // Default: use session model
  yolo_model: null, // Default: use session model
  build_backend: null, // Default: use session backend
  yolo_backend: null, // Default: use session backend
  build_thinking_level: null, // Default: use session thinking level
  yolo_thinking_level: null, // Default: use session thinking level
  linear_api_key: null, // Default: no global Linear API key
  magic_models_auto_initialized: false, // Default: not yet auto-set
}
